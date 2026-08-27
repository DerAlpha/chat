<?php
declare(strict_types=1);

/**
 * GIF-Suche, ohne die Privatsphäre aufzugeben.
 *
 * Der naheliegende Weg wäre, den Browser direkt mit Giphy reden zu lassen.
 * Dann wüsste Giphy: diese IP-Adresse, dieses Gerät, dieser Suchbegriff, zu
 * dieser Uhrzeit - und beim Betrachten im Chat noch einmal, bei jedem, dem
 * das GIF geschickt wurde. Genau die Spur, die diese Anwendung sonst überall
 * vermeidet.
 *
 * Deshalb läuft alles über diesen Server: er sucht, er holt die
 * Vorschaubilder, er holt das GIF zum Verschicken. Der Browser sieht nie
 * eine Giphy-Adresse, und wer ein GIF empfängt, spricht nie mit Giphy - es
 * kommt als ganz normaler verschlüsselter Anhang an.
 *
 * Der Schlüssel bleibt hier und erreicht den Browser nie.
 */
final class Gifs
{
    /** Höchstens so viele Treffer je Seite - jede Vorschau kostet Bandbreite. */
    public const PAGE_SIZE = 12;

    /** Größer wird kein GIF geholt. */
    private const MAX_BYTES = 8 * 1024 * 1024;

    /** So lange gilt ein ausgegebener Verweis. */
    private const TOKEN_TTL = 1800;

    /** Für die Übersicht: das kleinste bewegte Bild zuerst. */
    private const PREVIEW_ORDER = [
        'preview_webp',              // ~26 KB, bewegt
        'preview_gif',               // ~47 KB, bewegt
        'fixed_width_small_still',   // ~5 KB, steht still
        'fixed_height_small_still',
        'fixed_width_downsampled',
        'fixed_width_small',
    ];

    /** Zum Verschicken: ordentlich, aber nicht riesig. */
    private const FULL_ORDER = ['downsized_medium', 'downsized', 'fixed_width', 'original'];

    /**
     * Ein Verweis auf ein Bild bei Giphy, signiert und befristet. Ohne
     * gültige Signatur holt dieser Server gar nichts - sonst wäre er ein
     * offener Proxy für beliebige fremde Adressen.
     */
    public static function signRef(string $secret, string $url, ?int $now = null): string
    {
        $now = $now ?? time();
        $payload = self::b64url(json_encode(['u' => $url, 'e' => $now + self::TOKEN_TTL], JSON_UNESCAPED_SLASHES));
        $mac = substr(self::b64url(hash_hmac('sha256', $payload, $secret, true)), 0, 32);
        return $payload . '.' . $mac;
    }

    public static function verifyRef(string $secret, string $token, ?int $now = null): ?string
    {
        $now = $now ?? time();
        if ($token === '' || strlen($token) > 2048) {
            return null;
        }
        $dot = strrpos($token, '.');
        if ($dot === false || $dot === 0) {
            return null;
        }
        $payload = substr($token, 0, $dot);
        $mac = substr($token, $dot + 1);
        $expected = substr(self::b64url(hash_hmac('sha256', $payload, $secret, true)), 0, 32);
        if (!hash_equals($expected, $mac)) {
            return null;
        }
        $raw = self::b64urlDecode($payload);
        if ($raw === null) {
            return null;
        }
        $parsed = json_decode($raw, true);
        if (!is_array($parsed) || !is_string($parsed['u'] ?? null) || !is_int($parsed['e'] ?? null)) {
            return null;
        }
        if ($parsed['e'] <= $now) {
            return null;
        }
        return self::allowedMedia($parsed['u']) ? $parsed['u'] : null;
    }

    /** Nur Giphy, nur verschlüsselt. */
    public static function allowedMedia(string $url): bool
    {
        $parts = parse_url($url);
        if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https') {
            return false;
        }
        $host = strtolower((string) ($parts['host'] ?? ''));
        return $host === 'giphy.com' || str_ends_with($host, '.giphy.com');
    }

    /**
     * Sucht bei Giphy und gibt nur zurück, was der Browser braucht: Größe,
     * Titel und zwei signierte Verweise. Keine Giphy-Adressen, keine
     * Kennungen, nichts zum Nachverfolgen.
     *
     * @return array{items: list<array<string, mixed>>, next: ?int}
     */
    public static function search(Config $config, string $secret, string $query, int $offset): array
    {
        $endpoint = $query === '' ? 'trending' : 'search';
        $params = [
            'api_key' => $config->giphyKey,
            'limit' => self::PAGE_SIZE,
            'offset' => max(0, min($offset, 500)),
            'rating' => $config->giphyRating,
        ];
        if ($query !== '') {
            $params['q'] = $query;
            $params['lang'] = 'de';
        }
        // Bewusst ohne "bundle": die schlanken Bundles enthalten ausgerechnet
        // die kleinen Vorschaugrößen nicht, und dann kämen statt 26 KB je
        // Bild 200 KB über diesen Server.
        $url = 'https://api.giphy.com/v1/gifs/' . $endpoint . '?' . http_build_query($params);

        $body = self::get($url, 10, 2 * 1024 * 1024);
        if ($body === null) {
            throw new ApiError(502, 'gif_upstream', 'Die GIF-Suche antwortet gerade nicht.');
        }
        $data = json_decode($body['bytes'], true);
        if (!is_array($data)) {
            throw new ApiError(502, 'gif_upstream', 'Die GIF-Suche antwortet gerade nicht.');
        }

        $items = [];
        foreach ((array) ($data['data'] ?? []) as $entry) {
            $images = (array) ($entry['images'] ?? []);
            $preview = self::pick($images, self::PREVIEW_ORDER, PHP_INT_MAX);
            $full = self::pick($images, self::FULL_ORDER, self::MAX_BYTES);
            if ($preview === null || $full === null) {
                continue;
            }
            if (!self::allowedMedia($preview['url']) || !self::allowedMedia($full['url'])) {
                continue;
            }
            $items[] = [
                'id' => (string) ($entry['id'] ?? ''),
                'title' => mb_substr((string) ($entry['title'] ?? ''), 0, 120),
                'width' => (int) ($preview['width'] ?? 100) ?: 100,
                'height' => (int) ($preview['height'] ?? 100) ?: 100,
                'preview' => self::signRef($secret, $preview['url']),
                'full' => self::signRef($secret, $full['url']),
                'bytes' => (int) ($full['size'] ?? 0),
            ];
        }

        $pagination = (array) ($data['pagination'] ?? []);
        $nextOffset = (int) ($pagination['offset'] ?? 0) + (int) ($pagination['count'] ?? count($items));
        $total = (int) ($pagination['total_count'] ?? 0);
        return [
            'items' => $items,
            'next' => (count($items) === self::PAGE_SIZE && $nextOffset < $total) ? $nextOffset : null,
        ];
    }

    /**
     * Holt ein Bild und reicht es unverändert weiter.
     * @return array{bytes: string, mime: string}
     */
    public static function media(string $url): array
    {
        $body = self::get($url, 20, self::MAX_BYTES);
        if ($body === null) {
            throw new ApiError(502, 'gif_upstream', 'Das Bild liess sich nicht holen.');
        }
        // Nur Bilder weiterreichen - was sonst käme, wollen wir nicht ausliefern.
        $mime = preg_match('#^image/(gif|webp|png|jpeg)$#', $body['mime']) === 1
            ? $body['mime']
            : 'application/octet-stream';
        return ['bytes' => $body['bytes'], 'mime' => $mime];
    }

    /**
     * @param array<string, mixed> $images
     * @param list<string> $order
     * @return array{url: string, width: mixed, height: mixed, size: mixed}|null
     */
    private static function pick(array $images, array $order, int $maxBytes): ?array
    {
        $fallback = null;
        foreach ($order as $name) {
            $entry = $images[$name] ?? null;
            if (!is_array($entry) || !is_string($entry['url'] ?? null) || $entry['url'] === '') {
                continue;
            }
            $size = (int) ($entry['size'] ?? 0);
            if ($size > 0 && $size <= $maxBytes) {
                return $entry;
            }
            $fallback ??= $entry;
        }
        return $fallback;
    }

    /**
     * Holen - mit curl, wenn vorhanden, sonst über den Stream-Wrapper.
     * Auf Webspace ist mal das eine, mal das andere abgeschaltet.
     *
     * @return array{bytes: string, mime: string}|null
     */
    private static function get(string $url, int $timeout, int $maxBytes): ?array
    {
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS => 3,
                CURLOPT_TIMEOUT => $timeout,
                CURLOPT_CONNECTTIMEOUT => 5,
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_USERAGENT => 'Fluesterchat',
                CURLOPT_HTTPHEADER => ['Accept: application/json, image/*'],
                // Abbrechen, sobald mehr kommt als erlaubt - nicht erst danach.
                CURLOPT_NOPROGRESS => false,
                CURLOPT_PROGRESSFUNCTION => static function ($res, $dlTotal, $dlNow) use ($maxBytes) {
                    return ($dlTotal > $maxBytes || $dlNow > $maxBytes) ? 1 : 0;
                },
            ]);
            $bytes = curl_exec($ch);
            $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $mime = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
            curl_close($ch);
            if (!is_string($bytes) || $status < 200 || $status >= 300 || strlen($bytes) > $maxBytes) {
                return null;
            }
            return ['bytes' => $bytes, 'mime' => strtok($mime, ';') ?: ''];
        }

        if (!ini_get('allow_url_fopen')) {
            return null;
        }
        $context = stream_context_create(['http' => [
            'timeout' => $timeout,
            'follow_location' => 1,
            'max_redirects' => 3,
            'header' => "Accept: application/json, image/*\r\nUser-Agent: Fluesterchat\r\n",
            'ignore_errors' => true,
        ]]);
        $bytes = @file_get_contents($url, false, $context, 0, $maxBytes + 1);
        if (!is_string($bytes) || strlen($bytes) > $maxBytes) {
            return null;
        }
        $mime = '';
        foreach ($http_response_header ?? [] as $line) {
            if (stripos($line, 'content-type:') === 0) {
                $mime = trim(strtok(substr($line, 13), ';') ?: '');
            }
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m) === 1 && ((int) $m[1] < 200 || (int) $m[1] >= 300)) {
                return null;
            }
        }
        return ['bytes' => $bytes, 'mime' => $mime];
    }

    private static function b64url(string $raw): string
    {
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }

    private static function b64urlDecode(string $text): ?string
    {
        $raw = base64_decode(strtr($text, '-_', '+/'), true);
        return $raw === false ? null : $raw;
    }
}
