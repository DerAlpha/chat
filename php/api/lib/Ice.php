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
 * Gespräch: der Medienstrom ist mit DTLS-SRTP verschlüsselt, bevor er dort
 * ankommt - der Schlüssel dafür entsteht zwischen den beiden Geräten, und
 * die Aushandlung darüber läuft verschlüsselt über diesen Server.
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
     * Anrufe laufen zwischen den Geräten - dieser Server handelt nur aus. Im
     * selben Netz klappt das ohne jede Einrichtung, deshalb wird die
     * Möglichkeit immer angeboten. Was fehlt, sagt die App dazu; eine
     * versteckte Funktion ist schlechter als eine mit ehrlichem Hinweis.
     *
     * @return array{calls: bool, discovery: bool, relay: bool}
     */
    public static function support(Config $config): array
    {
        $hasStun = $config->stunUrls !== [];
        $hasTurn = $config->turnUrls !== [] && $config->turnSecret !== '';
        return [
            'calls' => true,
            'discovery' => $hasStun || $hasTurn,
            'relay' => $hasTurn,
        ];
    }
}
