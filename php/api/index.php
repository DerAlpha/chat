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
require __DIR__ . '/lib/Ice.php';
require __DIR__ . '/lib/Gifs.php';

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
    /** Mehr Chats hat niemand offen, und eine Anfrage soll klein bleiben. */
    private const MAX_OVERVIEW_ROOMS = 50;
    /** Mehr als das zeigt der Punkt in der Uebersicht ohnehin nicht an. */
    private const UNREAD_CAP = 99;

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
        if (preg_match('#^/slots/([A-Za-z0-9_-]{22})/claim$#', $route, $m) && $method === 'POST') {
            $this->claimSlot($m[1]);
        }
        if ($route === '/overview' && $method === 'POST') {
            $this->overview();
        }
        if ($route === '/gifs' && $method === 'GET') {
            $this->gifSearch();
        }
        if ($route === '/gifs/media' && $method === 'GET') {
            $this->gifMedia();
        }
        if (preg_match('#^/rooms/([A-Za-z0-9_-]{22})/ice$#', $route, $m) && $method === 'GET') {
            $this->ice($m[1]);
        }
        if (preg_match('#^/rooms/([A-Za-z0-9_-]{22})/slots$#', $route, $m) && $method === 'POST') {
            $this->addSlots($m[1]);
        }
        if (preg_match('#^/rooms/([A-Za-z0-9_-]{22})/leave$#', $route, $m) && $method === 'POST') {
            $this->leave($m[1]);
        }
        if (preg_match('#^/rooms/([A-Za-z0-9_-]{22})/avatar/(group|[A-Za-z0-9_-]{1,32})$#', $route, $m)) {
            if ($method === 'PUT') {
                $this->putAvatar($m[1], $m[2]);
            }
            if ($method === 'GET') {
                $this->getAvatar($m[1], $m[2]);
            }
            if ($method === 'DELETE') {
                $this->dropAvatar($m[1], $m[2]);
            }
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
            // Wie gross eine Gruppe hoechstens werden darf.
            'maxGroup' => $this->config->maxRoomCapacity,
            'limits' => [
                'maxBlobBytes' => $this->config->maxBlobBytes,
                'maxCiphertextBytes' => $this->config->maxCiphertextBytes,
                'maxAvatarBytes' => $this->config->maxAvatarBytes,
            ],
            // Woran der Browser merkt, dass seine Kopie alt ist: dieselbe
            // Fassung, die auch in der ausgelieferten js/version.js steht.
            'version' => self::appVersion(),
            // Anrufe laufen zwischen den Browsern und werden immer angeboten;
            // was an Diensten fehlt, sagt die App als Hinweis dazu.
            'call' => Ice::support($this->config),
            // Ohne Giphy-Schlüssel bleibt die GIF-Suche unsichtbar statt kaputt.
            'gifs' => $this->config->giphyKey !== '',
        ]);
    }

    /**
     * Welche Fassung dieser Webspace ausliefert.
     *
     * Gelesen aus derselben Datei, die auch der Browser bekommt. Damit können
     * die beiden gar nicht auseinanderlaufen: hat der Browser eine andere
     * Fassung im Speicher, ist seine Kopie alt.
     */
    private static function appVersion(): string
    {
        static $gemerkt = null;
        if ($gemerkt !== null) {
            return $gemerkt;
        }
        $datei = dirname(__DIR__) . '/js/version.js';
        $roh = @file_get_contents($datei, false, null, 0, 4096);
        $gemerkt = (is_string($roh) && preg_match("/const APP_VERSION = '([^']*)'/", $roh, $m) === 1)
            ? $m[1]
            // Keine Datei, keine Auskunft. Dann sagt die App lieber nichts,
            // als den Nutzer mit einer erfundenen Fassung auszusperren.
            : '';
        return $gemerkt;
    }

    /**
     * GIF-Suche über diesen Server. Giphy sieht den Webspace, nicht die
     * Nutzer - und der Browser bekommt nur signierte, befristete Verweise.
     */
    private function gifSearch(): never
    {
        if ($this->config->giphyKey === '') {
            Http::fail(503, 'no_gif_service', 'Keine GIF-Suche eingerichtet.');
        }
        $this->limit('gifs', $this->config->gifSearchesPerHour, 3600);
        $query = mb_substr((string) ($_GET['q'] ?? ''), 0, 80);
        $offset = (int) ($_GET['offset'] ?? 0);
        Http::json(Gifs::search($this->config, $this->store->serverSecret(), $query, $offset));
    }

    /**
     * Ein Bild holen. Der Verweis ist signiert - dieser Server holt nichts,
     * was er nicht selbst kurz zuvor ausgegeben hat.
     */
    private function gifMedia(): never
    {
        if ($this->config->giphyKey === '') {
            Http::fail(404, 'not_found', 'Nicht gefunden.');
        }
        $url = Gifs::verifyRef($this->store->serverSecret(), (string) ($_GET['ref'] ?? ''));
        if ($url === null) {
            Http::fail(400, 'bad_ref', 'Verweis ungueltig oder abgelaufen.');
        }
        $media = Gifs::media($url);
        header('Content-Type: ' . $media['mime']);
        header('Content-Length: ' . strlen($media['bytes']));
        // Der Browser darf das Vorschaubild behalten - es ändert sich nicht.
        header('Cache-Control: private, max-age=900');
        header('Cross-Origin-Resource-Policy: same-origin');
        echo $media['bytes'];
        exit;
    }

    /**
     * Dienste für einen Anruf, mit kurzlebigen Zugangsdaten. Nur für
     * Mitglieder des Raums - sonst wäre der Relaisdienst für jeden, der die
     * Adresse kennt, eine kostenlose Datenschleuder.
     */
    private function ice(string $roomId): never
    {
        [$room] = $this->authenticate($roomId);
        $support = Ice::support($this->config);
        // Die Kennung landet im Benutzernamen und taucht im Protokoll des
        // Relaisdienstes auf - deshalb der Raum nur gekürzt.
        Http::json(Ice::servers($this->config, substr((string) ($room['id'] ?? $roomId), 0, 8)) + $support);
    }

    private function createRoom(): never
    {
        $this->limit('create', $this->config->createRoomPerHour, 3600);
        // Für eine Gruppe kommen die Einmal-Plätze gleich mit; die brauchen
        // mehr Platz im Rumpf als eine blosse Raum-ID.
        $body = Http::jsonBody(2048 + $this->config->maxRoomCapacity * 2048);
        $roomId = (string) ($body['roomId'] ?? '');
        if (!preg_match(Store::ROOM_ID_RE, $roomId)) {
            Http::fail(400, 'bad_room_id', 'Ungueltige Raum-ID.');
        }
        $slots = $this->readSlots($body['slots'] ?? []);
        $room = $this->store->createRoom($roomId, $slots);
        if ($room === null) {
            Http::fail(409, 'room_exists', 'Dieser Code ist bereits vergeben.');
        }

        $antwort = [
            'roomId' => $roomId,
            'createdAt' => $room['createdAt'] * 1000,
            'capacity' => (int) ($room['capacity'] ?? $this->config->maxMembersPerRoom),
            'expiresInMs' => $this->config->unclaimedRoomTtl * 1000,
        ];
        if ($slots !== []) {
            // Wer eine Gruppe anlegt, hat selbst keinen Code - die hat er
            // gerade für die anderen erzeugt. Sein Platz wird hier besetzt.
            $anleger = $this->store->mutate($roomId, function (array $raum): array {
                if (count((array) ($raum['members'] ?? [])) > 0) {
                    return [$raum, null];
                }
                $mitglied = [
                    'id' => Http::randomId(9),
                    'token' => Http::randomId(24),
                    'joinedAt' => time(),
                    'lastSeen' => time(),
                    'nickCt' => null,
                    'readSeq' => 0,
                    'slotId' => null,
                    // Wer die Gruppe anlegt, verwaltet sie auch: nur so gibt
                    // es überhaupt jemanden, der später Rechte vergeben oder
                    // weitere Leute einladen kann.
                    'role' => 'admin',
                    'avatarVer' => null,
                    'left' => false,
                ];
                $raum['members'][$mitglied['id']] = $mitglied;
                return [$raum, $mitglied];
            });
            if ($anleger !== null) {
                $antwort['you'] = ['id' => $anleger['id'], 'token' => $anleger['token']];
            }
        }
        Http::json($antwort, 201);
    }

    /**
     * Prüft die Plätze, die beim Anlegen einer Gruppe mitkommen.
     *
     * @return list<array{id: string, wrapped: string}>
     */
    private function readSlots(mixed $roh, ?int $hoechstens = null): array
    {
        if (!is_array($roh) || $roh === []) {
            return [];
        }
        if (count($roh) > ($hoechstens ?? $this->config->maxRoomCapacity - 1)) {
            Http::fail(400, 'too_many_slots', 'So gross darf eine Gruppe nicht sein.');
        }
        $slots = [];
        $gesehen = [];
        foreach ($roh as $eintrag) {
            $id = is_array($eintrag) ? (string) ($eintrag['id'] ?? '') : '';
            $wrapped = is_array($eintrag) ? (string) ($eintrag['wrapped'] ?? '') : '';
            if (!preg_match(Store::ROOM_ID_RE, $id)) {
                Http::fail(400, 'bad_slot_id', 'Ungueltige Platzkennung.');
            }
            if ($wrapped === '' || strlen($wrapped) > $this->config->maxWrappedKeyChars) {
                Http::fail(400, 'bad_slot', 'Ungueltiges Platzpaket.');
            }
            // Zwei gleiche Kennungen hiessen: zwei Teilnehmer mit demselben Code.
            if (isset($gesehen[$id]) || is_file($this->store->slotPath($id))) {
                Http::fail(400, 'slot_exists', 'Diese Platzkennung ist schon vergeben.');
            }
            $gesehen[$id] = true;
            $slots[] = ['id' => $id, 'wrapped' => $wrapped];
        }
        return $slots;
    }

    /**
     * Löst einen Einmal-Platz ein.
     *
     * Der Beitretende kennt nur seinen Code, nicht den Raum. Aus dem Code
     * rechnet sein Browser die Platzkennung; die legt er hier vor und bekommt
     * dafür das verpackte Paket und einen Platz im Raum.
     *
     * Ein zweiter Versuch ist erlaubt, SOLANGE sich noch niemand damit
     * verbunden hat: reisst die Leitung dazwischen ab, wäre die Person sonst
     * für immer ausgesperrt und der Platz für immer tot.
     */
    private function claimSlot(string $slotId): never
    {
        $this->limit('join', $this->config->joinAttemptsPerHour, 3600);
        $verweis = @file_get_contents($this->store->slotPath($slotId));
        $roomId = is_string($verweis) ? trim($verweis) : '';
        if (!preg_match(Store::ROOM_ID_RE, $roomId) || $this->store->loadRoom($roomId) === null) {
            // Bewusst dieselbe Antwort wie für einen verbrauchten Platz: sonst
            // liesse sich daran ablesen, welche Codes es einmal gegeben hat.
            Http::fail(404, 'slot_unknown', 'Dieser Code gilt nicht (mehr).');
        }

        $ergebnis = $this->store->mutate($roomId, function (array $room) use ($slotId): array {
            $slot = $room['slots'][$slotId] ?? null;
            if ($slot === null) {
                return [$room, ['error' => 'slot_unknown']];
            }
            $bekannt = $slot['claimedBy'] !== null ? ($room['members'][$slot['claimedBy']] ?? null) : null;
            if ($slot['claimedBy'] !== null) {
                if (($slot['settled'] ?? false) || $bekannt === null) {
                    return [$room, ['error' => 'slot_used']];
                }
                return [$room, ['slot' => $slot, 'member' => $bekannt]];
            }
            $mitglied = [
                'id' => Http::randomId(9),
                'token' => Http::randomId(24),
                'joinedAt' => time(),
                'lastSeen' => time(),
                'nickCt' => null,
                'readSeq' => 0,
                'slotId' => $slotId,
                'role' => 'member',
                'avatarVer' => null,
                'left' => false,
            ];
            $room['members'][$mitglied['id']] = $mitglied;
            $room['slots'][$slotId]['claimedBy'] = $mitglied['id'];
            $room['slots'][$slotId]['claimedAt'] = time();
            $room['lastActivity'] = time();
            return [$room, ['slot' => $room['slots'][$slotId], 'member' => $mitglied]];
        });

        if (($ergebnis['error'] ?? null) === 'slot_unknown') {
            Http::fail(404, 'slot_unknown', 'Dieser Code gilt nicht (mehr).');
        }
        if (($ergebnis['error'] ?? null) === 'slot_used') {
            Http::fail(410, 'slot_used', 'Dieser Code wurde schon eingeloest.');
        }
        $room = $this->store->loadRoom($roomId) ?? [];
        Http::json([
            'roomId' => $roomId,
            'wrapped' => (string) $ergebnis['slot']['wrapped'],
            'capacity' => (int) ($room['capacity'] ?? $this->config->maxMembersPerRoom),
            'you' => ['id' => $ergebnis['member']['id'], 'token' => $ergebnis['member']['token']],
        ]);
    }

    /**
     * Kurzfassung mehrerer Räume auf einmal.
     *
     * Die App hält genau eine Verbindung - zu dem Chat, der offen ist. Was in
     * den anderen passiert, erfährt sie nur hier: wie viel Ungelesenes liegt,
     * wann zuletzt etwas kam und ob dort gerade jemand schreibt. Eine Anfrage
     * statt zwanzig Verbindungen - das ist auf einem Webspace der Unterschied
     * zwischen "läuft" und "läuft nicht".
     *
     * Gelesen werden dabei nur winzige Dateien: der Auszug aus recent.json
     * und je ein Zeitstempel für Anwesenheit und Tippen.
     */
    private function overview(): never
    {
        $this->limit('overview', $this->config->overviewPerHour, 3600);
        $body = Http::jsonBody(16 * 1024);
        $wanted = is_array($body['rooms'] ?? null) ? array_slice($body['rooms'], 0, self::MAX_OVERVIEW_ROOMS) : [];

        $out = [];
        foreach ($wanted as $eintrag) {
            if (!is_array($eintrag)) {
                continue;
            }
            $roomId = (string) ($eintrag['roomId'] ?? '');
            $token = (string) ($eintrag['token'] ?? '');
            if (!preg_match(Store::ROOM_ID_RE, $roomId) || $token === '') {
                continue;
            }
            $room = $this->store->loadRoom($roomId);
            if ($room === null) {
                // Weg ist weg - das darf die App wissen, damit sie nicht ewig fragt.
                $out[] = ['roomId' => $roomId, 'gone' => true];
                continue;
            }
            $memberId = null;
            foreach ((array) ($room['members'] ?? []) as $id => $member) {
                // Wer gegangen ist, hat kein gültiges Token mehr - auch nicht
                // für die Übersicht. Sonst bliebe ihm ein Lesekanal in die
                // Gruppe: Ungelesen-Zähler, Zeitpunkt der letzten Nachricht
                // und wer gerade tippt.
                if (($member['left'] ?? false) === true) {
                    continue;
                }
                if (hash_equals((string) ($member['token'] ?? ''), $token)) {
                    $memberId = (string) $id;
                    break;
                }
            }
            // Ohne gültiges Token gibt es keine Auskunft - und auch keinen
            // Hinweis darauf, ob es den Raum überhaupt gibt.
            if ($memberId === null) {
                continue;
            }
            $seq = (int) ($eintrag['seq'] ?? 0);
            $out[] = ['roomId' => $roomId] + $this->summarise($roomId, $room, $memberId, $seq);
        }

        Http::json(['rooms' => $out, 'now' => time() * 1000]);
    }

    /**
     * @param array<string,mixed> $room
     * @return array{unread:int, lastMessageAt:int, typing:bool}
     */
    private function summarise(string $roomId, array $room, string $memberId, int $seq): array
    {
        $auszug = $this->store->loadRecent($roomId);
        $unread = 0;
        $lastMessageAt = 0;
        // Von hinten: die jüngsten Nachrichten sind die interessanten, und
        // mehr als der Punkt anzeigen kann, muss niemand zählen.
        for ($i = count($auszug) - 1; $i >= 0; $i--) {
            $eintrag = $auszug[$i];
            $mseq = (int) ($eintrag[0] ?? 0);
            $von = (string) ($eintrag[1] ?? '');
            $ts = (int) ($eintrag[2] ?? 0);
            if ($von === $memberId) {
                continue;
            }
            if ($lastMessageAt === 0) {
                $lastMessageAt = $ts;
            }
            if ($mseq <= $seq) {
                break;
            }
            $unread++;
            if ($unread >= self::UNREAD_CAP) {
                break;
            }
        }

        $presence = new Presence($this->store->roomDir($roomId), $this->config->presenceTimeout);
        $typing = false;
        foreach (array_keys((array) ($room['members'] ?? [])) as $id) {
            if ((string) $id === $memberId) {
                continue;
            }
            if ($presence->isTyping((string) $id)) {
                $typing = true;
                break;
            }
        }

        return ['unread' => $unread, 'lastMessageAt' => $lastMessageAt, 'typing' => $typing];
    }

    private function roomStatus(string $roomId): never
    {
        $this->limit('join', $this->config->joinAttemptsPerHour, 3600);
        $room = $this->store->loadRoom($roomId);
        if ($room === null) {
            Http::fail(404, 'room_unknown', 'Diesen Chat gibt es nicht (mehr).');
        }
        $members = count((array) ($room['members'] ?? []));
        // Die Kapazität steht am Raum, nicht in der Konfiguration: ein
        // Zweierchat hat zwei Plätze, eine Gruppe so viele wie Codes.
        $capacity = (int) ($room['capacity'] ?? $this->config->maxMembersPerRoom);
        Http::json([
            'roomId' => $roomId,
            'createdAt' => $room['createdAt'] * 1000,
            'members' => $members,
            'capacity' => $capacity,
            'group' => ((array) ($room['slots'] ?? [])) !== [],
            'full' => $members >= $capacity,
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
                if (($member['left'] ?? false) === true) {
                    continue;
                }
                if (Http::safeEquals((string) ($member['token'] ?? ''), $token)) {
                    // Rückkehrer: das Gegenüber soll gleich sehen, dass wieder jemand da ist.
                    [$room] = $this->store->appendEvent($roomId, $room, [
                        't' => 'presence', 'from' => (string) $id, 'online' => true, 'lastSeen' => time() * 1000,
                    ]);
                    // Wer sich mit einem eingelösten Platz verbindet, verbraucht
                    // ihn damit endgültig. Bis hierhin war ein zweiter Versuch
                    // erlaubt - für den Fall, dass die Leitung dazwischen abriss.
                    $slotId = (string) ($member['slotId'] ?? '');
                    if ($slotId !== '' && isset($room['slots'][$slotId])) {
                        $room['slots'][$slotId]['settled'] = true;
                    }
                    return [$room, ['id' => (string) $id, 'token' => $member['token'], 'returning' => true]];
                }
            }
            // In einer Gruppe kommt man nur über einen eingelösten Platz herein.
            // Sonst könnte jeder, der die Raum-ID kennt, sich die freien Plätze
            // nehmen - bei zwei Personen ein enges Fenster, bei zwölf eine Tür.
            if (((array) ($room['slots'] ?? [])) !== []) {
                Http::fail(403, 'need_slot', 'Fuer diese Gruppe brauchst du einen eigenen Code.');
            }
            if (count($members) >= (int) ($room['capacity'] ?? $this->config->maxMembersPerRoom)) {
                Http::fail(403, 'room_full', 'Dieser Chat ist schon voll.');
            }
            $id = Http::randomId(12);
            $members[$id] = [
                'token' => Http::randomId(24),
                'joinedAt' => time(),
                'nickCt' => null,
                'readSeq' => 0,
                'role' => 'member',
                'avatarVer' => null,
                'left' => false,
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
                'capacity' => (int) ($room['capacity'] ?? $this->config->maxMembersPerRoom),
                'group' => ((array) ($room['slots'] ?? [])) !== [],
                'avatarVer' => isset($room['avatarVer']) && is_string($room['avatarVer'])
                    ? $room['avatarVer'] : null,
                'limits' => [
                    'maxBlobBytes' => $this->config->maxBlobBytes,
                    'maxCiphertextBytes' => $this->config->maxCiphertextBytes,
                    'maxAvatarBytes' => $this->config->maxAvatarBytes,
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
                // Anruf-Aushandlung kommt in Schwällen: zwei Dutzend kleine
                // Pakete in wenigen Sekunden. Die dürfen das Kontingent für
                // echte Nachrichten nicht auffressen.
                'sig' => 0.2,
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

    /**
     * Eine Gruppe nachträglich erweitern.
     *
     * Wer sie verwaltet, hat neue Codes gewürfelt und den Gruppenschlüssel
     * dafür verpackt. Hier kommen nur die Pakete an - dieser Server kann
     * keines davon öffnen und sieht die Codes nie.
     */
    private function addSlots(string $roomId): never
    {
        $this->limit('create', $this->config->createRoomPerHour, 3600);
        [$room, $memberId] = $this->authenticate($roomId);
        if (((array) ($room['slots'] ?? [])) === []) {
            Http::fail(400, 'not_a_group', 'Das ist keine Gruppe.');
        }
        if ((($room['members'][$memberId]['role'] ?? 'member')) !== 'admin') {
            Http::fail(403, 'not_admin', 'Nur Verwalter duerfen einladen.');
        }
        $body = Http::jsonBody(2048 + $this->config->maxRoomCapacity * 2048);
        $roh = $body['slots'] ?? [];
        if (!is_array($roh) || $roh === []) {
            Http::fail(400, 'bad_slot', 'Keine Plaetze angegeben.');
        }
        $slots = $this->readSlots($roh, $this->config->maxRoomCapacity);

        $capacity = $this->store->mutate($roomId, function (array $raum) use ($slots, $memberId): array {
            if ((($raum['members'][$memberId]['role'] ?? 'member')) !== 'admin') {
                Http::fail(403, 'not_admin', 'Nur Verwalter duerfen einladen.');
            }
            // Die Obergrenze wird hier drinnen geprüft, nicht davor: zwei
            // Anfragen gleichzeitig hätten sonst beide "passt schon" gelesen
            // und die Gruppe zusammen über die Grenze gehoben.
            $platz = (int) ($raum['capacity'] ?? $this->config->maxMembersPerRoom);
            if ($platz + count($slots) > $this->config->maxRoomCapacity) {
                Http::fail(400, 'too_many_slots', 'So gross darf eine Gruppe nicht sein.');
            }
            foreach ($slots as $slot) {
                if (isset($raum['slots'][$slot['id']])) {
                    Http::fail(400, 'slot_exists', 'Diese Platzkennung ist schon vergeben.');
                }
                $raum['slots'][$slot['id']] = [
                    'id' => $slot['id'],
                    'wrapped' => $slot['wrapped'],
                    'claimedBy' => null,
                    'claimedAt' => null,
                    'settled' => false,
                ];
            }
            $raum['capacity'] = (int) ($raum['capacity'] ?? 0) + count($slots);
            [$raum] = $this->store->appendEvent($raum['id'], $raum, [
                't' => 'capacity', 'capacity' => $raum['capacity'],
            ]);
            return [$raum, $raum['capacity']];
        });
        foreach ($slots as $slot) {
            $this->store->writeSlotRef($slot['id'], $roomId);
        }
        Http::json(['capacity' => $capacity], 201);
    }

    /**
     * Eine Gruppe verlassen.
     *
     * Der Unterschied zum Vernichten: die Gruppe bleibt für alle anderen
     * stehen. Nur die eigenen Nachrichten verlieren ihren Inhalt, und an
     * ihrer Stelle steht bei den anderen, dass hier jemand gegangen ist.
     */
    private function leave(string $roomId): never
    {
        [$room, $memberId] = $this->authenticate($roomId);

        // Alles unter derselben Sperre: waehrend hier die eigenen
        // Nachrichten zu Platzhaltern werden, koennte sonst nebenan jemand
        // eine neue schreiben - und die waere danach weg.
        $leer = $this->store->mutate($roomId, function (array $raum) use ($memberId): array {
            $nachrichten = $this->store->loadMessages($raum['id']);
            $frei = [];
            foreach ($nachrichten as $i => $nachricht) {
                if ((string) ($nachricht['from'] ?? '') !== $memberId) {
                    continue;
                }
                foreach ((array) ($nachricht['att'] ?? []) as $blobId) {
                    $frei[] = (string) $blobId;
                }
                $nachrichten[$i]['gone'] = true;
                $nachrichten[$i]['deleted'] = true;
                $nachrichten[$i]['ct'] = '';
                $nachrichten[$i]['att'] = [];
                $nachrichten[$i]['reactions'] = (object) [];
                $nachrichten[$i]['revealedBy'] = [];
            }
            $this->store->saveMessages($raum['id'], $nachrichten);
            foreach ($frei as $blobId) {
                if (isset($raum['blobs'][$blobId])) {
                    $raum['blobBytes'] = max(0, (int) ($raum['blobBytes'] ?? 0) - (int) ($raum['blobs'][$blobId]['size'] ?? 0));
                    unset($raum['blobs'][$blobId]);
                }
                $this->store->removeBlob($raum['id'], $blobId);
            }
            $this->store->removeAvatar($raum['id'], $memberId);

            if (isset($raum['members'][$memberId])) {
                $raum['members'][$memberId]['left'] = true;
                $raum['members'][$memberId]['nickCt'] = null;
                $raum['members'][$memberId]['avatarVer'] = null;
            }
            // Geht der letzte Verwalter, wäre die Gruppe führungslos: niemand
            // könnte sie je wieder erweitern oder ihr Bild ändern. Also rückt
            // der am längsten Dabeigebliebene nach.
            if (((array) ($raum['slots'] ?? [])) !== []) {
                $verwalter = 0;
                $kandidaten = [];
                foreach ((array) ($raum['members'] ?? []) as $id => $mitglied) {
                    if (($mitglied['left'] ?? false) === true) {
                        continue;
                    }
                    if (($mitglied['role'] ?? 'member') === 'admin') {
                        $verwalter++;
                    }
                    $kandidaten[(string) $id] = (int) ($mitglied['joinedAt'] ?? 0);
                }
                if ($verwalter === 0 && $kandidaten !== []) {
                    asort($kandidaten);
                    $nachfolge = (string) array_key_first($kandidaten);
                    $raum['members'][$nachfolge]['role'] = 'admin';
                    [$raum] = $this->store->appendEvent($raum['id'], $raum, [
                        't' => 'role', 'from' => $memberId, 'to' => $nachfolge, 'role' => 'admin',
                    ]);
                }
            }

            [$raum] = $this->store->appendEvent($raum['id'], $raum, ['t' => 'left', 'from' => $memberId]);

            $uebrig = 0;
            foreach ((array) ($raum['members'] ?? []) as $mitglied) {
                if (($mitglied['left'] ?? false) !== true) {
                    $uebrig++;
                }
            }
            return [$raum, $uebrig === 0];
        });

        if ($leer === true) {
            // Niemand mehr da: dann kann auch der Raum weg.
            $this->store->deleteRoom($roomId);
        }
        Http::json(['ok' => true, 'empty' => $leer === true]);
    }

    /**
     * Profilbild setzen. Der Inhalt ist schon im Browser verschlüsselt -
     * dieser Server legt nur Bytes ab, die er nicht lesen kann.
     */
    private function putAvatar(string $roomId, string $owner): never
    {
        $this->limit('upload', $this->config->uploadsPerHour, 3600);
        [$room, $memberId] = $this->authenticate($roomId);

        // Das eigene Bild darf jeder setzen, das der Gruppe nur ihr
        // Verwalter. Ein fremdes Bild darf niemand setzen.
        if ($owner === 'group') {
            if (((array) ($room['slots'] ?? [])) === []) {
                Http::fail(400, 'not_a_group', 'Das ist keine Gruppe.');
            }
            if ((($room['members'][$memberId]['role'] ?? 'member')) !== 'admin') {
                Http::fail(403, 'not_admin', 'Nur Verwalter duerfen das Gruppenbild aendern.');
            }
        } elseif ($owner !== $memberId) {
            Http::fail(403, 'not_owner', 'Fremdes Bild.');
        }

        $bytes = Http::rawBody($this->config->maxAvatarBytes);
        if ($bytes === '') {
            Http::fail(400, 'empty_avatar', 'Leeres Bild.');
        }
        $this->store->writeAvatar($roomId, $owner, $bytes);
        $ver = Http::randomId(8);
        $this->store->mutate($roomId, function (array $raum) use ($owner, $ver, $memberId): array {
            // Die Rolle noch einmal unter der Sperre: zwischen Prüfung und
            // Schreiben könnte sie jemand genommen haben.
            if ($owner === 'group' && (($raum['members'][$memberId]['role'] ?? 'member')) !== 'admin') {
                Http::fail(403, 'not_admin', 'Nur Verwalter duerfen das Gruppenbild aendern.');
            }
            if ($owner === 'group') {
                $raum['avatarVer'] = $ver;
            } elseif (isset($raum['members'][$owner])) {
                $raum['members'][$owner]['avatarVer'] = $ver;
            }
            [$raum] = $this->store->appendEvent($raum['id'], $raum, [
                't' => 'avatar', 'from' => $owner, 'ver' => $ver,
            ]);
            return [$raum, null];
        });
        Http::json(['ver' => $ver], 201);
    }

    /** Bild wieder wegnehmen - dieselben Regeln wie beim Setzen. */
    private function dropAvatar(string $roomId, string $owner): never
    {
        [$room, $memberId] = $this->authenticate($roomId);
        if ($owner === 'group') {
            if ((($room['members'][$memberId]['role'] ?? 'member')) !== 'admin') {
                Http::fail(403, 'not_admin', 'Nur Verwalter duerfen das Gruppenbild aendern.');
            }
        } elseif ($owner !== $memberId) {
            Http::fail(403, 'not_owner', 'Fremdes Bild.');
        }
        $this->store->removeAvatar($roomId, $owner);
        $this->store->mutate($roomId, function (array $raum) use ($owner): array {
            if ($owner === 'group') {
                $raum['avatarVer'] = null;
            } elseif (isset($raum['members'][$owner])) {
                $raum['members'][$owner]['avatarVer'] = null;
            }
            [$raum] = $this->store->appendEvent($raum['id'], $raum, [
                't' => 'avatar', 'from' => $owner, 'ver' => null,
            ]);
            return [$raum, null];
        });
        Http::json(['ok' => true]);
    }

    private function getAvatar(string $roomId, string $owner): never
    {
        $this->authenticate($roomId);
        $bytes = $this->store->readAvatar($roomId, $owner);
        if ($bytes === null) {
            Http::fail(404, 'avatar_unknown', 'Kein Bild hinterlegt.');
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
            // Wer die Gruppe verlassen hat, kommt nicht mehr hinein. Sein
            // Token bleibt am Platz stehen, damit die alten Nachrichten der
            // anderen weiter auf ihn verweisen können - es öffnet aber nichts.
            if (($member['left'] ?? false) === true) {
                continue;
            }
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
