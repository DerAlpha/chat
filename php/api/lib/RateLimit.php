<?php
declare(strict_types=1);

/**
 * Token-Bucket auf Dateibasis. Ohne Datenbank, ohne Erweiterungen -
 * eine kleine Datei je Schlüssel reicht.
 */
final class RateLimit
{
    public function __construct(private string $dir)
    {
        if (!is_dir($this->dir) && !@mkdir($this->dir, 0770, true) && !is_dir($this->dir)) {
            throw new RuntimeException('Rate-Limit-Verzeichnis nicht anlegbar.');
        }
    }

    /**
     * @param string $key     z. B. "create:1.2.3.4"
     * @param int    $capacity Wie viele Aktionen im Eimer Platz haben.
     * @param float  $perSecond Nachfüllrate.
     * @return bool true, wenn die Aktion erlaubt ist.
     */
    public function take(string $key, int $capacity, float $perSecond, float $cost = 1.0): bool
    {
        $path = $this->dir . '/' . hash('sha256', $key) . '.bucket';
        $handle = @fopen($path, 'c+');
        if ($handle === false) {
            // Lieber durchlassen als den Dienst wegen eines Schreibfehlers lahmlegen.
            return true;
        }
        try {
            if (!flock($handle, LOCK_EX)) {
                return true;
            }
            $now = microtime(true);
            $raw = stream_get_contents($handle) ?: '';
            [$tokens, $updated] = $this->parse($raw, $capacity, $now);

            $tokens = min((float) $capacity, $tokens + ($now - $updated) * $perSecond);
            $allowed = $tokens >= $cost;
            if ($allowed) {
                $tokens -= $cost;
            }

            ftruncate($handle, 0);
            rewind($handle);
            fwrite($handle, sprintf('%.4f %.4f', $tokens, $now));
            fflush($handle);
            return $allowed;
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    /** @return array{0: float, 1: float} */
    private function parse(string $raw, int $capacity, float $now): array
    {
        $parts = explode(' ', trim($raw));
        if (count($parts) !== 2 || !is_numeric($parts[0]) || !is_numeric($parts[1])) {
            return [(float) $capacity, $now];
        }
        return [(float) $parts[0], (float) $parts[1]];
    }

    /**
     * Laeuft nur ab und zu mit - wie das Aufraeumen der Raeume, und aus
     * demselben Grund: Shared Hosting hat keine Cronjobs fuer uns.
     */
    public function sweepSometimes(int $chance, int $maxAgeSeconds = 7200): void
    {
        if (random_int(1, max(1, $chance)) !== 1) {
            return;
        }
        $this->sweep($maxAgeSeconds);
    }

    /** Alte Eimer wegräumen, damit das Verzeichnis nicht wächst. */
    public function sweep(int $maxAgeSeconds = 7200): void
    {
        foreach (glob($this->dir . '/*.bucket') ?: [] as $file) {
            if (time() - (int) @filemtime($file) > $maxAgeSeconds) {
                @unlink($file);
            }
        }
    }
}
