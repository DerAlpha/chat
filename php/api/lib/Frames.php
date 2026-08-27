<?php
declare(strict_types=1);

/**
 * Verarbeitet die Frames, die der Browser schickt - dieselbe Sprache wie
 * beim Node-Server, damit der Client nicht zwei Protokolle kennen muss.
 *
 * Was nur den Absender angeht (ack, history, pong, err), geht direkt in der
 * Antwort zurück. Alles andere landet im Ereignisstrom und wird beim nächsten
 * Abholen zugestellt.
 */
final class Frames
{
    /** @var list<array<string,mixed>> */
    private array $direct = [];

    private Presence $presence;

    public function __construct(
        private Config $config,
        private Store $store,
        private string $roomId,
        private string $memberId,
    ) {
        $this->presence = new Presence($this->store->roomDir($roomId), $this->config->presenceTimeout);
    }

    /**
     * @param list<array<string,mixed>> $frames
     * @return list<array<string,mixed>>
     */
    public function process(array $frames): array
    {
        foreach ($frames as $frame) {
            if (!is_array($frame) || !isset($frame['t']) || !is_string($frame['t'])) {
                $this->error('bad_frame', 'Ungueltiges Format.', null);
                continue;
            }
            try {
                $this->one($frame);
            } catch (ApiError $error) {
                // Ein kaputtes Frame darf die anderen nicht mitreissen.
                $this->error($error->errorCode, $error->getMessage(), $frame['cid'] ?? null);
            }
        }
        return $this->direct;
    }

    /** @param array<string,mixed> $frame */
    private function one(array $frame): void
    {
        match ($frame['t']) {
            'ping' => $this->direct[] = ['t' => 'pong', 'now' => $this->millis()],
            'msg' => $this->message($frame),
            'edit' => $this->edit($frame),
            'del' => $this->delete($frame),
            'react' => $this->react($frame),
            'read' => $this->read($frame),
            'typing' => $this->typing($frame),
            'nick' => $this->nick($frame),
            'role' => $this->role($frame),
            'sig' => $this->signal($frame),
            'history' => $this->history($frame),
            'burn' => $this->burn(),
            default => $this->error('unknown_frame', 'Unbekannter Typ: ' . $frame['t'], $frame['cid'] ?? null),
        };
    }

    private function millis(): int
    {
        return (int) round(microtime(true) * 1000);
    }

    private function error(string $code, string $message, ?string $cid): void
    {
        $this->direct[] = ['t' => 'err', 'code' => $code, 'msg' => $message, 'cid' => $cid];
    }

    /** @param array<string,mixed> $frame */
    private function message(array $frame): void
    {
        $ct = (string) ($frame['ct'] ?? '');
        if ($ct === '') {
            Http::fail(400, 'empty_message', 'Leere Nachricht.');
        }
        if (strlen($ct) > $this->config->maxCiphertextBytes) {
            Http::fail(400, 'message_too_large', 'Nachricht zu gross.');
        }
        $blobIds = array_slice(array_values((array) ($frame['blobs'] ?? [])), 0, 4);
        $cid = isset($frame['cid']) ? (string) $frame['cid'] : null;
        $memberId = $this->memberId;

        $message = $this->store->mutate($this->roomId, function (array $room) use ($ct, $blobIds, $memberId): array {
            foreach ($blobIds as $blobId) {
                if (!isset($room['blobs'][$blobId])) {
                    Http::fail(400, 'unknown_blob', 'Unbekannter Anhang.');
                }
                if (($room['blobs'][$blobId]['messageId'] ?? null) !== null) {
                    Http::fail(400, 'blob_in_use', 'Anhang bereits verwendet.');
                }
            }
            $seq = ((int) ($room['seq'] ?? 0)) + 1;
            $room['seq'] = $seq;
            $message = [
                'id' => Http::randomId(12),
                'seq' => $seq,
                'from' => $memberId,
                'ts' => (int) round(microtime(true) * 1000),
                'ct' => $ct,
                'att' => array_values($blobIds),
                'deleted' => false,
                'editedAt' => null,
                'reactions' => (object) [],
            ];
            foreach ($blobIds as $blobId) {
                $room['blobs'][$blobId]['messageId'] = $message['id'];
            }
            $messages = $this->store->loadMessages($this->roomId);
            $messages[] = $message;
            $this->store->saveMessages($this->roomId, $messages);

            [$room] = $this->store->appendEvent($this->roomId, $room, ['t' => 'msg', 'message' => $message]);
            return [$room, $message];
        });

        $this->direct[] = [
            't' => 'ack',
            'cid' => $cid,
            'id' => $message['id'],
            'seq' => $message['seq'],
            'ts' => $message['ts'],
        ];
    }

    /** @param array<string,mixed> $frame */
    private function edit(array $frame): void
    {
        $id = (string) ($frame['id'] ?? '');
        $ct = (string) ($frame['ct'] ?? '');
        if (strlen($ct) > $this->config->maxCiphertextBytes) {
            Http::fail(400, 'message_too_large', 'Nachricht zu gross.');
        }
        $memberId = $this->memberId;

        $this->store->mutate($this->roomId, function (array $room) use ($id, $ct, $memberId): array {
            $messages = $this->store->loadMessages($this->roomId);
            $index = $this->findMessage($messages, $id);
            if ($messages[$index]['from'] !== $memberId) {
                Http::fail(403, 'not_owner', 'Fremde Nachricht.');
            }
            if (!empty($messages[$index]['deleted'])) {
                Http::fail(400, 'message_deleted', 'Nachricht ist geloescht.');
            }
            $editedAt = (int) round(microtime(true) * 1000);
            $messages[$index]['ct'] = $ct;
            $messages[$index]['editedAt'] = $editedAt;
            $this->store->saveMessages($this->roomId, $messages);

            [$room] = $this->store->appendEvent($this->roomId, $room, [
                't' => 'edit', 'id' => $id, 'ct' => $ct, 'editedAt' => $editedAt, 'from' => $memberId,
            ]);
            return [$room, null];
        });
    }

    /** @param array<string,mixed> $frame */
    private function delete(array $frame): void
    {
        $id = (string) ($frame['id'] ?? '');
        $memberId = $this->memberId;

        $this->store->mutate($this->roomId, function (array $room) use ($id, $memberId): array {
            $messages = $this->store->loadMessages($this->roomId);
            $index = $this->findMessage($messages, $id);
            if ($messages[$index]['from'] !== $memberId) {
                Http::fail(403, 'not_owner', 'Fremde Nachricht.');
            }
            // Löschen heisst löschen: Chiffrat und Anhänge verschwinden auch hier.
            foreach ((array) ($messages[$index]['att'] ?? []) as $blobId) {
                if (isset($room['blobs'][$blobId])) {
                    $room['blobBytes'] = max(0, (int) $room['blobBytes'] - (int) $room['blobs'][$blobId]['size']);
                    unset($room['blobs'][$blobId]);
                }
                $this->store->removeBlob($this->roomId, (string) $blobId);
            }
            $messages[$index]['deleted'] = true;
            $messages[$index]['ct'] = '';
            $messages[$index]['att'] = [];
            $messages[$index]['reactions'] = (object) [];
            $this->store->saveMessages($this->roomId, $messages);

            [$room] = $this->store->appendEvent($this->roomId, $room, ['t' => 'del', 'id' => $id, 'from' => $memberId]);
            return [$room, null];
        });
    }

    /** @param array<string,mixed> $frame */
    private function react(array $frame): void
    {
        $id = (string) ($frame['id'] ?? '');
        $ct = array_key_exists('ct', $frame) && $frame['ct'] !== null ? (string) $frame['ct'] : null;
        if ($ct !== null && strlen($ct) > 512) {
            Http::fail(400, 'reaction_too_large', 'Reaktion zu gross.');
        }
        $memberId = $this->memberId;

        $this->store->mutate($this->roomId, function (array $room) use ($id, $ct, $memberId): array {
            $messages = $this->store->loadMessages($this->roomId);
            $index = $this->findMessage($messages, $id);
            if (!empty($messages[$index]['deleted'])) {
                Http::fail(400, 'message_deleted', 'Nachricht ist geloescht.');
            }
            $reactions = (array) ($messages[$index]['reactions'] ?? []);
            if ($ct === null) {
                unset($reactions[$memberId]);
            } else {
                $reactions[$memberId] = $ct;
            }
            $messages[$index]['reactions'] = $reactions === [] ? (object) [] : $reactions;
            $this->store->saveMessages($this->roomId, $messages);

            [$room] = $this->store->appendEvent($this->roomId, $room, [
                't' => 'react', 'id' => $id, 'from' => $memberId, 'ct' => $ct,
            ]);
            return [$room, null];
        });
    }

    /** @param array<string,mixed> $frame */
    private function read(array $frame): void
    {
        $seq = (int) ($frame['seq'] ?? 0);
        $memberId = $this->memberId;
        $this->store->mutate($this->roomId, function (array $room) use ($seq, $memberId): array {
            $current = (int) ($room['members'][$memberId]['readSeq'] ?? 0);
            $next = max($current, min($seq, (int) ($room['seq'] ?? 0)));
            if ($next === $current) {
                return [$room, null];
            }
            $room['members'][$memberId]['readSeq'] = $next;
            [$room] = $this->store->appendEvent($this->roomId, $room, [
                't' => 'read', 'from' => $memberId, 'seq' => $next,
            ]);
            return [$room, null];
        });
    }

    /** @param array<string,mixed> $frame */
    private function typing(array $frame): void
    {
        $on = ($frame['on'] ?? false) === true;
        $memberId = $this->memberId;
        $this->presence->setTyping($memberId, $on);
        $this->store->mutate($this->roomId, function (array $room) use ($on, $memberId): array {
            [$room] = $this->store->appendEvent($this->roomId, $room, [
                't' => 'typing', 'from' => $memberId, 'on' => $on,
            ]);
            return [$room, null];
        });
    }

    /** @param array<string,mixed> $frame */
    private function nick(array $frame): void
    {
        $ct = array_key_exists('ct', $frame) && $frame['ct'] !== null ? (string) $frame['ct'] : null;
        if ($ct !== null && strlen($ct) > 1024) {
            Http::fail(400, 'nick_too_large', 'Name zu lang.');
        }
        $memberId = $this->memberId;
        $this->store->mutate($this->roomId, function (array $room) use ($ct, $memberId): array {
            $room['members'][$memberId]['nickCt'] = $ct;
            [$room] = $this->store->appendEvent($this->roomId, $room, [
                't' => 'nick', 'from' => $memberId, 'ct' => $ct,
            ]);
            return [$room, null];
        });
    }

    /**
     * Rechte in einer Gruppe vergeben oder wieder nehmen.
     *
     * Der Server prüft das selbst - eine Oberfläche, die den Knopf versteckt,
     * ist keine Sicherung. Und der letzte Verwalter kann sich seine Rechte
     * nicht selbst nehmen: eine Gruppe ohne Verwalter ließe sich nie wieder
     * erweitern und ihr Bild nie wieder ändern.
     *
     * @param array<string,mixed> $frame
     */
    private function role(array $frame): void
    {
        $ziel = (string) ($frame['to'] ?? '');
        $recht = (string) ($frame['role'] ?? '');
        if ($recht !== 'admin' && $recht !== 'member') {
            Http::fail(400, 'bad_role', 'Unbekanntes Recht.');
        }
        $memberId = $this->memberId;
        $this->store->mutate($this->roomId, function (array $room) use ($ziel, $recht, $memberId): array {
            if (((array) ($room['slots'] ?? [])) === []) {
                Http::fail(400, 'not_a_group', 'Das ist keine Gruppe.');
            }
            if ((($room['members'][$memberId]['role'] ?? 'member')) !== 'admin') {
                Http::fail(403, 'not_admin', 'Nur Verwalter duerfen Rechte vergeben.');
            }
            if (!isset($room['members'][$ziel]) || ($room['members'][$ziel]['left'] ?? false) === true) {
                Http::fail(400, 'unknown_member', 'Dieses Mitglied gibt es nicht.');
            }
            if ($recht === 'member' && ($room['members'][$ziel]['role'] ?? 'member') === 'admin') {
                $verwalter = 0;
                foreach ((array) ($room['members'] ?? []) as $mitglied) {
                    if (($mitglied['left'] ?? false) !== true && ($mitglied['role'] ?? 'member') === 'admin') {
                        $verwalter++;
                    }
                }
                if ($verwalter <= 1) {
                    Http::fail(400, 'last_admin', 'Die Gruppe braucht mindestens einen Verwalter.');
                }
            }
            $room['members'][$ziel]['role'] = $recht;
            [$room] = $this->store->appendEvent($this->roomId, $room, [
                't' => 'role', 'from' => $memberId, 'to' => $ziel, 'role' => $recht,
            ]);
            return [$room, null];
        });
    }

    /**
     * Aushandlung eines Anrufs. Der Inhalt ist schon im Browser verschlüsselt -
     * dieser Server reicht ihn weiter, ohne zu wissen, worum es geht. Damit
     * ist auch die Aushandlung selbst Ende-zu-Ende geschützt, nicht nur der
     * Gesprächsinhalt: ein untergeschobener Server kann sich nicht
     * dazwischenschalten, ohne dass es auffällt.
     */
    private function signal(array $frame): void
    {
        $ct = (string) ($frame['ct'] ?? '');
        if ($ct === '' || strlen($ct) > 16384) {
            Http::fail(400, 'bad_signal', 'Ungueltiges Aushandlungspaket.');
        }
        $memberId = $this->memberId;
        $this->store->mutate($this->roomId, function (array $room) use ($ct, $memberId): array {
            [$room] = $this->store->appendEvent($this->roomId, $room, [
                't' => 'sig', 'from' => $memberId, 'ct' => $ct,
            ]);
            return [$room, null];
        });
    }

    /** @param array<string,mixed> $frame */
    private function history(array $frame): void
    {
        $before = (int) ($frame['before'] ?? 0);
        $limit = max(1, min(300, (int) ($frame['limit'] ?? 100)));
        $older = array_values(array_filter(
            $this->store->loadMessages($this->roomId),
            static fn (array $m): bool => (int) $m['seq'] < $before,
        ));
        $page = array_slice($older, -$limit);
        $this->direct[] = [
            't' => 'history',
            'messages' => $page,
            'hasMore' => count($older) > count($page),
        ];
    }

    private function burn(): void
    {
        $this->store->mutate($this->roomId, function (array $room): array {
            [$room] = $this->store->appendEvent($this->roomId, $room, ['t' => 'burned']);
            return [$room, null];
        });
        $this->store->deleteRoom($this->roomId);
        $this->direct[] = ['t' => 'burned'];
    }

    /** @param list<array<string,mixed>> $messages */
    private function findMessage(array $messages, string $id): int
    {
        foreach ($messages as $index => $message) {
            if (($message['id'] ?? null) === $id) {
                return $index;
            }
        }
        Http::fail(404, 'unknown_message', 'Nachricht nicht gefunden.');
    }
}
