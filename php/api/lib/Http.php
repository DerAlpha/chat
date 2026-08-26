<?php
declare(strict_types=1);

/** Kleine Helfer rund um Anfrage und Antwort. */
final class Http
{
    /** Fachlicher Fehler, der als sauberes JSON zurückgeht. */
    public static function fail(int $status, string $code, string $message): never
    {
        throw new ApiError($status, $code, $message);
    }

    public static function json(mixed $body, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    /** Der Pfad der Anfrage, relativ zum Ordner der index.php. */
    public static function route(): string
    {
        $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
        $uri = rawurldecode($uri);
        $base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
        if ($base !== '' && str_starts_with($uri, $base)) {
            $uri = substr($uri, strlen($base));
        }
        return '/' . trim($uri, '/');
    }

    public static function method(): string
    {
        return strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    }

    public static function header(string $name): string
    {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        return (string) ($_SERVER[$key] ?? '');
    }

    /** Body als Text - mit Obergrenze, damit nichts den Speicher sprengt. */
    public static function rawBody(int $maxBytes): string
    {
        $length = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($length > $maxBytes) {
            self::fail(413, 'too_large', 'Datei zu gross.');
        }
        $body = file_get_contents('php://input', false, null, 0, $maxBytes + 1);
        if ($body === false) {
            return '';
        }
        if (strlen($body) > $maxBytes) {
            self::fail(413, 'too_large', 'Datei zu gross.');
        }
        return $body;
    }

    /** @return array<string, mixed> */
    public static function jsonBody(int $maxBytes = 262144): array
    {
        $raw = self::rawBody($maxBytes);
        if ($raw === '') {
            return [];
        }
        try {
            $data = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            self::fail(400, 'bad_json', 'Ungueltiges JSON.');
        }
        return is_array($data) ? $data : [];
    }

    public static function clientIp(): string
    {
        // Hinter dem Reverse Proxy des Hosters steht die echte Adresse im Header.
        foreach (['HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP'] as $key) {
            $value = $_SERVER[$key] ?? '';
            if ($value !== '') {
                $first = trim(explode(',', (string) $value)[0]);
                if (filter_var($first, FILTER_VALIDATE_IP)) {
                    return $first;
                }
            }
        }
        return (string) ($_SERVER['REMOTE_ADDR'] ?? 'unbekannt');
    }

    /** Zufällige, URL-sichere ID. */
    public static function randomId(int $bytes): string
    {
        return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '=');
    }

    /** Zeitkonstanter Vergleich, damit Tokens nicht erraten werden koennen. */
    public static function safeEquals(?string $a, ?string $b): bool
    {
        return is_string($a) && is_string($b) && $a !== '' && hash_equals($a, $b);
    }
}

/**
 * Fehler mit HTTP-Status und Kurzschlüssel.
 *
 * Der Schlüssel heisst bewusst nicht $code: den bringt Exception schon mit,
 * und zwar als int.
 */
final class ApiError extends RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
    ) {
        parent::__construct($message);
    }
}
