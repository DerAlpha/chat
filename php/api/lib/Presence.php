<?php
declare(strict_types=1);

/**
 * Wer ist gerade da?
 *
 * Beim Abholen neuer Ereignisse schreibt jedes Mitglied einen Zeitstempel in
 * eine winzige eigene Datei. Das kommt ohne Sperre auf dem Raum aus - sonst
 * würde jede Abfrage den ganzen Raum blockieren.
 */
final class Presence
{
    public function __construct(private string $roomDir, private int $timeout)
    {
    }

    private function path(string $memberId): string
    {
        return $this->roomDir . '/seen-' . $memberId;
    }

    public function touch(string $memberId): void
    {
        @file_put_contents($this->path($memberId), (string) time(), LOCK_EX);
    }

    public function lastSeen(string $memberId): int
    {
        $raw = @file_get_contents($this->path($memberId));
        return $raw === false ? 0 : (int) trim($raw);
    }

    public function isOnline(string $memberId): bool
    {
        return time() - $this->lastSeen($memberId) <= $this->timeout;
    }

    private function typingPath(string $memberId): string
    {
        return $this->roomDir . '/typing-' . $memberId;
    }

    /**
     * Hält fest, dass jemand gerade schreibt.
     *
     * Die Übersicht auf der Startseite hat keine Verbindung zu diesem Raum
     * und kann das Tippen sonst nirgends ablesen - im Ereignisstrom steht es
     * zwar, aber den holt nur ab, wer den Chat offen hat.
     */
    public function setTyping(string $memberId, bool $on): void
    {
        if ($on) {
            @file_put_contents($this->typingPath($memberId), (string) time(), LOCK_EX);
            return;
        }
        @unlink($this->typingPath($memberId));
    }

    /** Wer aufhört, meldet es selbst; wer verschwindet, gilt kurz darauf als still. */
    public function isTyping(string $memberId, int $ttl = 5): bool
    {
        $raw = @file_get_contents($this->typingPath($memberId));
        return $raw !== false && time() - (int) trim($raw) <= $ttl;
    }

    /**
     * @param array<string, array<string,mixed>> $members
     * @return list<array<string,mixed>>
     */
    public function summarise(array $members): array
    {
        $out = [];
        foreach ($members as $id => $member) {
            $seen = $this->lastSeen((string) $id);
            $out[] = [
                'id' => (string) $id,
                'joinedAt' => (int) ($member['joinedAt'] ?? 0) * 1000,
                'lastSeen' => $seen * 1000,
                'nickCt' => $member['nickCt'] ?? null,
                'readSeq' => (int) ($member['readSeq'] ?? 0),
                'online' => time() - $seen <= $this->timeout,
                // In einer Gruppe darf nicht jeder alles: wer sie angelegt
                // hat, verwaltet sie und kann Rechte weitergeben.
                'role' => ($member['role'] ?? 'member') === 'admin' ? 'admin' : 'member',
                // Wer gegangen ist, bleibt als leerer Platz stehen - sonst
                // wären seine Nachrichten auf einmal von niemandem.
                'left' => ($member['left'] ?? false) === true,
                'avatarVer' => isset($member['avatarVer']) && is_string($member['avatarVer'])
                    ? $member['avatarVer'] : null,
            ];
        }
        return $out;
    }
}
