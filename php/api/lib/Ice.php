<?php
declare(strict_types=1);

/**
 * Kurzlebige Zugangsdaten für den eigenen Relaisdienst.
 *
 * Der Relaisdienst braucht einen dauerhaften Prozess und eigene Ports und
 * kann deshalb auf diesem Webspace nicht laufen. Ausstellen kann dieser
 * Webspace die Zugangsdaten trotzdem: dafür genügt eine HMAC-Rechnung über
 * ein Geheimnis, das beide Seiten kennen. Der Dienst rechnet dasselbe nach
 * und braucht keine Benutzerliste - und die beiden müssen nie miteinander
 * reden.
 *
 *   Benutzername = <ablaufzeitpunkt>:<kennung>
 *   Passwort     = base64(HMAC-SHA1(geheimnis, benutzername))
 *
 * Diese Zugangsdaten schützen den Dienst vor Fremdnutzung, nicht das
 * Gespräch: der Medienstrom ist zweifach verschlüsselt, bevor er dort
 * ankommt.
 */
final class Ice
{
    /** @return array{iceServers: list<array<string, mixed>>, expiresAt: ?int} */
    public static function servers(Config $config, string $label = ''): array
    {
        $servers = [];
        foreach ($config->stunUrls as $url) {
            $servers[] = ['urls' => $url];
        }

        if ($config->turnUrls === [] || $config->turnSecret === '') {
            return ['iceServers' => $servers, 'expiresAt' => null];
        }

        $ttl = max(60, $config->turnTtlSeconds);
        $expiry = time() + $ttl;
        $clean = preg_replace('/[^A-Za-z0-9_-]/', '', $label) ?? '';
        $clean = substr($clean, 0, 32);
        $username = $clean === '' ? (string) $expiry : $expiry . ':' . $clean;
        $password = base64_encode(hash_hmac('sha1', $username, $config->turnSecret, true));

        $servers[] = [
            'urls' => array_values($config->turnUrls),
            'username' => $username,
            'credential' => $password,
        ];

        return ['iceServers' => $servers, 'expiresAt' => $expiry * 1000];
    }

    /**
     * Kann überhaupt angerufen werden? Ohne jeden Dienst finden sich zwei
     * Geräte nur im selben Netz - das sollte man nicht als Anruf anbieten,
     * ohne es dazuzusagen.
     *
     * @return array{calls: bool, relay: bool}
     */
    public static function support(Config $config): array
    {
        $hasStun = $config->stunUrls !== [];
        $hasTurn = $config->turnUrls !== [] && $config->turnSecret !== '';
        return ['calls' => $hasStun || $hasTurn, 'relay' => $hasTurn];
    }
}
