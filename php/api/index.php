<?php
declare(strict_types=1);

/**
 * Flüsterchat – Backend für Webspace ohne Node.
 *
 * Gleiche Frame-Sprache wie der Node-Server; statt einer WebSocket-Verbindung
 * holt der Browser neue Ereignisse per Long-Polling ab. Inhalte sieht dieser
 * Code nie: was hier durchläuft, ist bereits im Browser verschlüsselt.
 */

require __DIR__ . '/lib/Config.php';
require __DIR__ . '/lib/Http.php';
require __DIR__ . '/lib/Store.php';
require __DIR__ . '/lib/RateLimit.php';
require __DIR__ . '/lib/Frames.php';
require __DIR__ . '/lib/Presence.php';

if (PHP_VERSION_ID < 80100) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'php_too_old', 'message' => 'PHP 8.1 oder neuer wird gebraucht.']);
    exit;
}

$config = Config::get();

try {
    $store = new Store($config);
    $limits = new RateLimit($config->dataDir . '/limits');
    (new App($config, $store, $limits))->run();
} catch (ApiError $error) {
    http_response_code($error->status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $error->errorCode, 'message' => $error->getMessage()]);
} catch (Throwable $error) {
    error_log('Fluesterchat: ' . $error->getMessage() . ' @ ' . $error->getFile() . ':' . $error->getLine());
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'server_error', 'message' => 'Interner Fehler.']);
}

final class App
{
    private string $ip;

    public function __construct(
        private Config $config,
        private Store $store,
        private RateLimit $limits,
    ) {
        $this->ip = Http::clientIp();
    }

    public function run(): void
    {
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: no-referrer');
        header('Cache-Control: no-store');

        $route = Http::route();
        $method = Http::method();

        if ($method === 'OPTIONS') {
            http_response_code(204);
            return;
        }

        $this->store->cleanupSometimes();

        // /config
        if ($route === '/config' && $method === 'GET') {
            $this->config();
        }
        // /rooms
        if ($route === '/rooms' && $method === 'POST') {
            $this->createRoom();
        }

        if (preg_match('#^/rooms/([A-Za-z0-9_-]{22})$#', $route, $m)) {
            if ($method === 'GET') {
                $this->roomStatus($m[1]);
            }
            if ($method === 'DELETE') {
                $this->burn($m[1]);
            }
        }
        if (preg_match('#^/rooms/([A-Za-z0-9_-]{22})/join$#', $route, $m) && $method === 'POST') {
            $this->join($m[1]);
        }
        if (preg_match('#^/rooms/([A-Za-z0-9_-]{22})/frames$#', $route, $m) && $method === 'POST') {
            $this->frames($m[1]);
        }
        if (preg_match('#^/rooms/([A-Za-z0-9_-]{22})/events$#', $route, $m) && $method === 'GET') {
            $this->events($m[1]);
        }
        if (preg_match('#^/rooms/([A-Za-z0-9_-]{22})/blobs$#', $route, $m) && $method === 'POST') {
            $this->uploadBlob($m[1]);
        }
        if (preg_match('#^/rooms/([A-Za-z0-9_-]{22})/blobs/([A-Za-z0-9_-]{22})$#', $route, $m) && $method === 'GET') {
            $this->downloadBlob($m[1], $m[2]);
        }
        if ($route === '/healthz' && $method === 'GET') {
            Http::json(['ok' => true, 'backend' => 'php', 'php' => PHP_VERSION]);
        }

        Http::fail(404, 'not_found', 'Nicht gefunden.');
    }

    // ------------------------------------------------------------- Endpunkte

    private function config(): never
    {
        Http::json([
            'realtime' => 'poll',
            'backend' => 'php',
            'pollWaitSeconds' => $this->config->pollWaitSeconds,
            'presenceTimeout' => $this->config->presenceTimeout,
            'capacity' => $this->config->maxMembersPerRoom,
            'limits' => [
                'maxBlobBytes' => $this->config->maxBlobBytes,
                'maxCiphertextBytes' => $this->config->maxCiphertextBytes,
            ],
        ]);
    }

    private function createRoom(): never
    {
        $this->limit('create', $this->config->createRoomPerHour, 3600);
        $body = Http::jsonBody(2048);
        $roomId = (string) ($body['roomId'] ?? '');
        if (!preg_match(Store::ROOM_ID_RE, $roomId)) {
            Http::fail(400, 'bad_room_id', 'Ungueltige Raum-ID.');
        }
        $room = $this->store->createRoom($roomId);
        if ($room === null) {
            Http::fail(409, 'room_exists', 'Dieser Code ist bereits vergeben.');
        }
        Http::json([
            'roomId' => $roomId,
            'createdAt' => $room['createdAt'] * 1000,
            'expiresInMs' => $this->config->unclaimedRoomTtl * 1000,
        ], 201);
    }

    private function roomStatus(string $roomId): never
    {
        $this->limit('join', $this->config->joinAttemptsPerHour, 3600);
        $room = $this->store->loadRoom($roomId);
        if ($room === null) {
            Http::fail(404, 'room_unknown', 'Diesen Chat gibt es nicht (mehr).');
        }
        $members = count((array) ($room['members'] ?? []));
        Http::json([
            'roomId' => $roomId,
            'createdAt' => $room['createdAt'] * 1000,
            'members' => $members,
            'capacity' => $this->config->maxMembersPerRoom,
            'full' => $members >= $this->config->maxMembersPerRoom,
        ]);
    }

    /** Beitreten oder mit Token zurückkehren - das Gegenstück zum WebSocket-„welcome". */
    private function join(string $roomId): never
    {
        $this->limit('join', $this->config->joinAttemptsPerHour, 3600);
        $body = Http::jsonBody(2048);
        $token = (string) ($body['token'] ?? '');

        $result = $this->store->mutate($roomId, function (array $room) use ($roomId, $token): array {
            $members = (array) ($room['members'] ?? []);
            foreach ($members as $id => $member) {
                if (Http::safeEquals((string) ($member['token'] ?? ''), $token)) {
                    // Rückkehrer: das Gegenüber soll gleich sehen, dass wieder jemand da ist.
                    [$room] = $this->store->appendEvent($roomId, $room, [
                        't' => 'presence', 'from' => (string) $id, 'online' => true, 'lastSeen' => time() * 1000,
                    ]);
                    return [$room, ['id' => (string) $id, 'token' => $member['token'], 'returning' => true]];
                }
            }
            if (count($members) >= $this->config->maxMembersPerRoom) {
                Http::fail(403, 'room_full', 'Dieser Chat ist schon voll.');
            }
            $id = Http::randomId(12);
            $members[$id] = [
                'token' => Http::randomId(24),
                'joinedAt' => time(),
                'nickCt' => null,
                'readSeq' => 0,
            ];
            $room['members'] = $members;
            // Wichtig: als Ereignis eintragen, sonst wartet der Abruf des
            // Gegenübers bis zum Zeitablauf, statt sofort aufzuwachen.
            [$room] = $this->store->appendEvent($roomId, $room, [
                't' => 'presence', 'from' => $id, 'online' => true, 'lastSeen' => time() * 1000,
            ]);
            return [$room, ['id' => $id, 'token' => $members[$id]['token'], 'returning' => false]];
        });

        $room = $this->store->loadRoom($roomId);
        $presence = new Presence($this->store->roomDir($roomId), $this->config->presenceTimeout);
        $presence->touch($result['id']);

        $messages = $this->store->loadMessages($roomId);
        $history = array_slice($messages, -$this->config->welcomeHistory);

        Http::json([
            't' => 'welcome',
            'now' => time() * 1000,
            'you' => $result,
            'room' => [
                'id' => $roomId,
                'createdAt' => $room['createdAt'] * 1000,
                'seq' => (int) ($room['seq'] ?? 0),
                'capacity' => $this->config->maxMembersPerRoom,
                'limits' => [
                    'maxBlobBytes' => $this->config->maxBlobBytes,
                    'maxCiphertextBytes' => $this->config->maxCiphertextBytes,
                ],
            ],
            'members' => $presence->summarise((array) $room['members']),
            'messages' => array_values($history),
            'hasMore' => count($messages) > count($history),
            'cursor' => $this->store->currentEventSeq($roomId),
        ]);
    }

    /** Ein oder mehrere Frames verarbeiten. Antwort enthält, was direkt an mich zurückgeht. */
    private function frames(string $roomId): never
    {
        [$room, $memberId] = $this->authenticate($roomId);
        $body = Http::jsonBody($this->config->maxCiphertextBytes * 2 + 8192);
        $incoming = $body['frames'] ?? [];
        if (!is_array($incoming) || $incoming === []) {
            Http::fail(400, 'bad_frame', 'Keine Frames uebergeben.');
        }
        if (count($incoming) > 20) {
            Http::fail(400, 'bad_frame', 'Zu viele Frames auf einmal.');
        }
        $cost = 0.0;
        foreach ($incoming as $frame) {
            $cost += match ((string) ($frame['t'] ?? '')) {
                'typing', 'read' => 0.1,
                'history' => 0.5,
                default => 1.0,
            };
        }
        $this->limit('frames:' . $memberId, $this->config->framesPerMinute, 60, $cost);

        $handler = new Frames($this->config, $this->store, $roomId, $memberId);
        $direct = $handler->process($incoming);

        Http::json(['direct' => $direct, 'cursor' => $this->store->currentEventSeq($roomId)]);
    }

    /** Long-Polling: wartet auf neue Ereignisse und liefert sie. */
    private function events(string $roomId): never
    {
        [$room, $memberId] = $this->authenticate($roomId);
        $since = (int) ($_GET['since'] ?? 0);
        $wait = max(0, min($this->config->pollWaitSeconds, (int) ($_GET['wait'] ?? $this->config->pollWaitSeconds)));

        $presence = new Presence($this->store->roomDir($roomId), $this->config->presenceTimeout);
        $presence->touch($memberId);

        @set_time_limit($wait + 15);
        $deadline = microtime(true) + $wait;
        $current = $this->store->currentEventSeq($roomId);
        while ($current <= $since && microtime(true) < $deadline) {
            usleep($this->config->pollIntervalMs * 1000);
            if ($this->store->wasBurned($roomId)) {
                Http::json(['cursor' => $since, 'frames' => [['t' => 'burned']], 'members' => [], 'now' => time() * 1000]);
            }
            $presence->touch($memberId);
            $current = $this->store->currentEventSeq($roomId);
        }

        $frames = [];
        foreach ($this->store->loadEvents($roomId) as $event) {
            if ((int) $event['seq'] <= $since) {
                continue;
            }
            $to = $event['to'] ?? null;
            // "to" gesetzt heisst: nur für dieses Mitglied bestimmt.
            if ($to !== null && $to !== $memberId) {
                continue;
            }
            // Eigene Frames werden bewusst NICHT herausgefiltert: sonst bekäme
            // ein zweites eigenes Gerät nichts mit. Der Client verarbeitet sie
            // wirkungsfrei - er kennt sie schon.
            $frames[] = $event['frame'];
        }

        $room = $this->store->loadRoom($roomId) ?? $room;
        Http::json([
            'cursor' => $current,
            'frames' => $frames,
            'members' => $presence->summarise((array) ($room['members'] ?? [])),
            'now' => time() * 1000,
        ]);
    }

    private function uploadBlob(string $roomId): never
    {
        $this->limit('upload', $this->config->uploadsPerHour, 3600);
        [$room, $memberId] = $this->authenticate($roomId);

        $bytes = Http::rawBody($this->config->maxBlobBytes);
        if ($bytes === '') {
            Http::fail(400, 'empty_blob', 'Leerer Anhang.');
        }
        $size = strlen($bytes);
        $blobId = Http::randomId(16);

        $this->store->mutate($roomId, function (array $room) use ($size, $blobId): array {
            if ((int) ($room['blobBytes'] ?? 0) + $size > $this->config->maxRoomBlobBytes) {
                Http::fail(400, 'room_quota', 'Speicherplatz des Chats erschoepft.');
            }
            $room['blobs'][$blobId] = ['id' => $blobId, 'size' => $size, 'createdAt' => time(), 'messageId' => null];
            $room['blobBytes'] = (int) ($room['blobBytes'] ?? 0) + $size;
            return [$room, null];
        });
        $this->store->writeBlob($roomId, $blobId, $bytes);

        Http::json(['id' => $blobId, 'size' => $size], 201);
    }

    private function downloadBlob(string $roomId, string $blobId): never
    {
        [$room] = $this->authenticate($roomId);
        if (!isset($room['blobs'][$blobId])) {
            Http::fail(404, 'blob_unknown', 'Anhang nicht gefunden.');
        }
        $bytes = $this->store->readBlob($roomId, $blobId);
        if ($bytes === null) {
            Http::fail(404, 'blob_unknown', 'Anhang nicht gefunden.');
        }
        header('Content-Type: application/octet-stream');
        header('Content-Length: ' . strlen($bytes));
        header('Cache-Control: private, max-age=86400');
        echo $bytes;
        exit;
    }

    private function burn(string $roomId): never
    {
        $this->authenticate($roomId);
        $this->store->deleteRoom($roomId);
        Http::json(['ok' => true]);
    }

    // --------------------------------------------------------------- Helfer

    /**
     * Prüft Raum und Mitglieds-Token.
     * @return array{0: array<string,mixed>, 1: string}
     */
    private function authenticate(string $roomId): array
    {
        $room = $this->store->loadRoom($roomId);
        if ($room === null) {
            if ($this->store->wasBurned($roomId)) {
                Http::fail(410, 'burned', 'Dieser Chat wurde geloescht.');
            }
            Http::fail(404, 'room_unknown', 'Diesen Chat gibt es nicht (mehr).');
        }
        $token = Http::header('x-room-token');
        foreach ((array) ($room['members'] ?? []) as $id => $member) {
            if (Http::safeEquals((string) ($member['token'] ?? ''), $token)) {
                return [$room, (string) $id];
            }
        }
        Http::fail(401, 'unauthorized', 'Kein Zugriff auf diesen Chat.');
    }

    private function limit(string $bucket, int $count, int $perSeconds, float $cost = 1.0): void
    {
        $key = $bucket . ':' . ($bucket === 'create' || $bucket === 'join' || $bucket === 'upload' ? $this->ip : '');
        if (!$this->limits->take($key, $count, $count / $perSeconds, $cost)) {
            header('Retry-After: 30');
            Http::fail(429, 'rate_limited', 'Zu viele Anfragen.');
        }
    }
}
