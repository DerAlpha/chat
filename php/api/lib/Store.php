<?php
declare(strict_types=1);

/**
 * Dateibasierter Speicher.
 *
 * Ein Verzeichnis je Raum. Geschrieben wird immer nach dem gleichen Muster:
 * exklusive Sperre holen, lesen, ändern, in eine temporäre Datei schreiben,
 * per rename() an ihren Platz ziehen. Dadurch sieht ein gleichzeitiger Leser
 * niemals eine halb geschriebene Datei und braucht selbst keine Sperre.
 */
final class Store
{
    public const ROOM_ID_RE = '/^[A-Za-z0-9_-]{22}$/';
    public const BLOB_ID_RE = '/^[A-Za-z0-9_-]{22}$/';

    public function __construct(private Config $config)
    {
        $this->ensureDir($this->config->dataDir);
        $this->ensureDir($this->roomsDir());
        $this->protect($this->config->dataDir);
    }

    private function roomsDir(): string
    {
        return $this->config->dataDir . '/rooms';
    }

    public function roomDir(string $roomId): string
    {
        return $this->roomsDir() . '/' . $roomId;
    }

    private function ensureDir(string $path): void
    {
        if (!is_dir($path) && !@mkdir($path, 0770, true) && !is_dir($path)) {
            throw new RuntimeException("Verzeichnis nicht anlegbar: $path");
        }
    }

    /**
     * Falls der Datenordner doch im Docroot landet: per .htaccess dichtmachen.
     * Auf lima-city (Apache) greift das; ein Ordner ausserhalb des Docroots
     * bleibt trotzdem die bessere Wahl.
     */
    private function protect(string $dir): void
    {
        $guard = $dir . '/.htaccess';
        if (is_file($guard)) {
            return;
        }
        @file_put_contents($guard, "Require all denied\n<IfModule !mod_authz_core.c>\n  Deny from all\n</IfModule>\n");
        @file_put_contents($dir . '/index.html', '');
    }

    // ------------------------------------------------------------- Sperren

    /** @return resource */
    private function lock(string $roomId)
    {
        $this->ensureDir($this->roomDir($roomId));
        $handle = fopen($this->roomDir($roomId) . '/.lock', 'c');
        if ($handle === false || !flock($handle, LOCK_EX)) {
            throw new RuntimeException('Raum konnte nicht gesperrt werden.');
        }
        return $handle;
    }

    /** @param resource $handle */
    private function unlock($handle): void
    {
        flock($handle, LOCK_UN);
        fclose($handle);
    }

    private function writeAtomic(string $path, string $content): void
    {
        $tmp = $path . '.' . getmypid() . '.tmp';
        if (file_put_contents($tmp, $content, LOCK_EX) === false || !rename($tmp, $path)) {
            @unlink($tmp);
            throw new RuntimeException("Schreiben fehlgeschlagen: $path");
        }
    }

    private function readJson(string $path, mixed $fallback): mixed
    {
        $raw = @file_get_contents($path);
        if ($raw === false || $raw === '') {
            return $fallback;
        }
        try {
            return json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            return $fallback;
        }
    }

    private function writeJson(string $path, mixed $value): void
    {
        $this->writeAtomic($path, json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    }

    /**
     * Führt `$mutator` unter exklusiver Sperre auf dem Raum aus und schreibt
     * das Ergebnis zurück. Der Mutator bekommt den Raum als Array und gibt
     * zurück, was der Aufrufer braucht.
     *
     * @template T
     * @param callable(array<string,mixed> $room): array{0: array<string,mixed>, 1: T} $mutator
     * @return T
     */
    public function mutate(string $roomId, callable $mutator): mixed
    {
        $handle = $this->lock($roomId);
        try {
            $room = $this->loadRoom($roomId);
            if ($room === null) {
                Http::fail(404, 'room_unknown', 'Diesen Chat gibt es nicht (mehr).');
            }
            [$room, $result] = $mutator($room);
            $room['lastActivity'] = time();
            $this->saveRoom($roomId, $room);
            return $result;
        } finally {
            $this->unlock($handle);
        }
    }

    // -------------------------------------------------------------- Räume

    /** @return array<string,mixed>|null */
    public function loadRoom(string $roomId): ?array
    {
        if (!preg_match(self::ROOM_ID_RE, $roomId)) {
            return null;
        }
        $room = $this->readJson($this->roomDir($roomId) . '/room.json', null);
        if (!is_array($room) || !isset($room['id'])) {
            return null;
        }
        if ($this->isExpired($room)) {
            $this->deleteRoom($roomId, false);
            return null;
        }
        return $room;
    }

    /** @param array<string,mixed> $room */
    private function saveRoom(string $roomId, array $room): void
    {
        $this->writeJson($this->roomDir($roomId) . '/room.json', $room);
    }

    /** @param array<string,mixed> $room */
    public function isExpired(array $room): bool
    {
        $ttl = empty($room['members']) ? $this->config->unclaimedRoomTtl : $this->config->roomIdleTtl;
        return time() - (int) ($room['lastActivity'] ?? 0) > $ttl;
    }

    /** @return array<string,mixed>|null null, wenn die ID schon vergeben ist. */
    public function createRoom(string $roomId): ?array
    {
        if (!preg_match(self::ROOM_ID_RE, $roomId)) {
            Http::fail(400, 'bad_room_id', 'Ungueltige Raum-ID.');
        }
        $handle = $this->lock($roomId);
        try {
            if ($this->loadRoom($roomId) !== null) {
                return null;
            }
            $now = time();
            $room = [
                'id' => $roomId,
                'createdAt' => $now,
                'lastActivity' => $now,
                'seq' => 0,
                'eventSeq' => 0,
                'members' => [],
                'blobs' => [],
                'blobBytes' => 0,
            ];
            $this->saveRoom($roomId, $room);
            $this->writeJson($this->roomDir($roomId) . '/messages.json', []);
            $this->writeJson($this->roomDir($roomId) . '/events.json', []);
            $this->writeAtomic($this->roomDir($roomId) . '/eventseq', '0');
            return $room;
        } finally {
            $this->unlock($handle);
        }
    }

    public function deleteRoom(string $roomId, bool $tombstone = true): void
    {
        if (!preg_match(self::ROOM_ID_RE, $roomId)) {
            return;
        }
        if ($tombstone) {
            // Damit das Gegenüber beim nächsten Abholen erfährt, dass der Chat
            // absichtlich weg ist - und nicht bloss abgelaufen scheint.
            $this->ensureDir($this->config->dataDir . '/burned');
            @file_put_contents($this->config->dataDir . '/burned/' . $roomId, (string) time());
        }
        $this->removeTree($this->roomDir($roomId));
    }

    public function wasBurned(string $roomId): bool
    {
        return is_file($this->config->dataDir . '/burned/' . $roomId);
    }

    private function removeTree(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        $items = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST,
        );
        foreach ($items as $item) {
            $item->isDir() ? @rmdir($item->getPathname()) : @unlink($item->getPathname());
        }
        @rmdir($dir);
    }

    // ---------------------------------------------------------- Nachrichten

    /** @return list<array<string,mixed>> */
    public function loadMessages(string $roomId): array
    {
        $messages = $this->readJson($this->roomDir($roomId) . '/messages.json', []);
        return is_array($messages) ? array_values($messages) : [];
    }

    /** @param list<array<string,mixed>> $messages */
    public function saveMessages(string $roomId, array $messages): void
    {
        if (count($messages) > $this->config->maxMessagesPerRoom) {
            $messages = array_slice($messages, -$this->config->maxMessagesPerRoom);
        }
        $this->writeJson($this->roomDir($roomId) . '/messages.json', array_values($messages));
    }

    // ------------------------------------------------------------ Ereignisse

    /** @return list<array<string,mixed>> */
    public function loadEvents(string $roomId): array
    {
        $events = $this->readJson($this->roomDir($roomId) . '/events.json', []);
        return is_array($events) ? array_values($events) : [];
    }

    /**
     * Hängt ein Frame an den Ereignisstrom. Muss innerhalb von mutate()
     * laufen, damit die Nummerierung lückenlos bleibt.
     *
     * @param array<string,mixed> $room
     * @param array<string,mixed> $frame
     * @return array{0: array<string,mixed>, 1: int}
     */
    public function appendEvent(string $roomId, array $room, array $frame, ?string $only = null): array
    {
        $seq = ((int) ($room['eventSeq'] ?? 0)) + 1;
        $room['eventSeq'] = $seq;

        $events = $this->loadEvents($roomId);
        $events[] = ['seq' => $seq, 'to' => $only, 'frame' => $frame];
        if (count($events) > $this->config->maxEvents) {
            $events = array_slice($events, -$this->config->maxEvents);
        }
        $this->writeJson($this->roomDir($roomId) . '/events.json', array_values($events));
        // Winzige Datei nur mit der Nummer: das Abholen prüft damit billig,
        // ob sich überhaupt etwas getan hat.
        $this->writeAtomic($this->roomDir($roomId) . '/eventseq', (string) $seq);
        return [$room, $seq];
    }

    public function currentEventSeq(string $roomId): int
    {
        $raw = @file_get_contents($this->roomDir($roomId) . '/eventseq');
        return $raw === false ? 0 : (int) trim($raw);
    }

    // ---------------------------------------------------------------- Blobs

    public function blobPath(string $roomId, string $blobId): string
    {
        return $this->roomDir($roomId) . '/blobs/' . $blobId . '.bin';
    }

    public function writeBlob(string $roomId, string $blobId, string $bytes): void
    {
        $this->ensureDir($this->roomDir($roomId) . '/blobs');
        $this->writeAtomic($this->blobPath($roomId, $blobId), $bytes);
    }

    public function readBlob(string $roomId, string $blobId): ?string
    {
        $bytes = @file_get_contents($this->blobPath($roomId, $blobId));
        return $bytes === false ? null : $bytes;
    }

    public function removeBlob(string $roomId, string $blobId): void
    {
        @unlink($this->blobPath($roomId, $blobId));
    }

    // ------------------------------------------------------------ Aufräumen

    /** Läuft nur ab und zu mit - Shared Hosting hat keine Cronjobs für uns. */
    public function cleanupSometimes(): void
    {
        if (random_int(1, max(1, $this->config->cleanupChance)) !== 1) {
            return;
        }
        $this->cleanup();
    }

    public function cleanup(): int
    {
        $removed = 0;
        foreach (glob($this->roomsDir() . '/*', GLOB_ONLYDIR) ?: [] as $dir) {
            $roomId = basename($dir);
            $room = $this->readJson($dir . '/room.json', null);
            if (!is_array($room) || $this->isExpired($room)) {
                $this->deleteRoom($roomId, false);
                $removed++;
            }
        }
        // Grabsteine verfallen nach einem Tag.
        foreach (glob($this->config->dataDir . '/burned/*') ?: [] as $file) {
            if (time() - (int) @filemtime($file) > 86400) {
                @unlink($file);
            }
        }
        return $removed;
    }
}
