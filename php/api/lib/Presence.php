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
            ];
        }
        return $out;
    }
}
