<?php
declare(strict_types=1);

/**
 * Alle Stellschrauben an einem Ort.
 *
 * Werte lassen sich über eine config.local.php daneben überschreiben, ohne
 * diese Datei anzufassen (praktisch beim Aktualisieren per FTP).
 */
final class Config
{
    /** Wo Räume, Nachrichten und verschlüsselte Anhänge liegen. */
    public string $dataDir;

    /** Ein Raum verschwindet, wenn er so lange nicht benutzt wurde. */
    public int $roomIdleTtl = 7 * 24 * 3600;

    /** Ein Code, dem nie jemand beigetreten ist, verfällt früher. */
    public int $unclaimedRoomTtl = 24 * 3600;

    public int $maxMembersPerRoom = 2;
    /** So gross darf eine Gruppe hoechstens werden - einschliesslich der Person, die sie anlegt. */
    public int $maxRoomCapacity = 16;
    /** Obergrenze fuer ein verpacktes Platzpaket. */
    public int $maxWrappedKeyChars = 1024;
    public int $maxMessagesPerRoom = 5000;
    public int $maxEvents = 800;
    public int $welcomeHistory = 300;

    /** Größe eines verschlüsselten Nachrichtentextes (Base64) in Bytes. */
    public int $maxCiphertextBytes = 65536;
    public int $maxBlobBytes = 12 * 1024 * 1024;
    public int $maxRoomBlobBytes = 150 * 1024 * 1024;

    /**
     * Wie lange eine Abfrage auf neue Ereignisse wartet, bevor sie leer
     * zurückkommt. Jede wartende Abfrage belegt einen PHP-Prozess - auf
     * kleinen Tarifen lieber kurz halten.
     */
    public int $pollWaitSeconds = 20;
    public int $pollIntervalMs = 300;

    /** Nach dieser Stille gilt jemand als offline. */
    public int $presenceTimeout = 25;

    // Rate-Limits pro IP
    public int $createRoomPerHour = 60;
    public int $joinAttemptsPerHour = 300;
    /**
     * Die Uebersicht fragt alle paar Sekunden nach - sie darf das
     * Beitritts-Kontingent nicht aufbrauchen. Sonst kaeme jemand mit
     * offener App irgendwann in keinen Chat mehr hinein.
     */
    public int $overviewPerHour = 5000;
    public int $uploadsPerHour = 400;
    public int $framesPerMinute = 240;

    /** Wie oft (im Mittel) beim Zugriff aufgeräumt wird: 1 von N Anfragen. */
    public int $cleanupChance = 200;

    // --- Anrufe --------------------------------------------------------
    // Adressen der Aushandlungs- und Relaisdienste, z. B.
    //   'stunUrls' => ['stun:anruf.meine-domain.de:3478'],
    //   'turnUrls' => ['turn:anruf.meine-domain.de:3478?transport=udp'],
    //   'turnSecret' => '<dasselbe wie TURN_SECRET beim Relaisdienst>',
    // Der Relaisdienst selbst läuft NICHT auf diesem Webspace - er braucht
    // einen dauerhaften Prozess und eigene Ports. Dieses Backend stellt nur
    // die kurzlebigen Zugangsdaten dafür aus; dazu genügt eine HMAC-Rechnung.

    /** @var string[] */
    public array $stunUrls = [];
    /** @var string[] */
    public array $turnUrls = [];
    public string $turnSecret = '';
    public string $turnRealm = 'fluesterchat';
    public int $turnTtlSeconds = 7200;

    // --- GIF-Suche -----------------------------------------------------
    // Ohne Schlüssel bleibt die Suche unsichtbar statt kaputt. Der Schlüssel
    // bleibt hier auf dem Server: Anfragen laufen über dieses Backend, damit
    // Giphy weder die IP-Adresse noch das Gerät der Nutzer zu sehen bekommt.
    public string $giphyKey = '';
    /** Bewertungsstufe, die Giphy höchstens ausliefern soll. */
    public string $giphyRating = 'pg-13';
    public int $gifSearchesPerHour = 300;

    public function __construct()
    {
        // Standard: ein Ordner NEBEN dem Docroot, damit nichts davon je
        // direkt über eine URL erreichbar ist. Klappt das nicht (Rechte),
        // fällt er auf api/data zurück - das schützt sich dann per .htaccess.
        $outside = dirname(__DIR__, 3) . '/fluesterchat-data';
        $inside  = dirname(__DIR__) . '/data';
        $this->dataDir = self::usable($outside) ? $outside : $inside;

        $local = __DIR__ . '/config.local.php';
        if (is_file($local)) {
            $overrides = require $local;
            foreach ((array) $overrides as $key => $value) {
                if (property_exists($this, $key)) {
                    $this->$key = $value;
                }
            }
        }

        // Nicht länger warten, als der Server die Anfrage überhaupt leben lässt.
        $limit = (int) ini_get('max_execution_time');
        if ($limit > 0) {
            $this->pollWaitSeconds = max(2, min($this->pollWaitSeconds, $limit - 5));
        }
    }

    /** Existiert der Ordner (oder lässt er sich anlegen) und ist er beschreibbar? */
    private static function usable(string $dir): bool
    {
        if (!is_dir($dir) && !@mkdir($dir, 0770, true) && !is_dir($dir)) {
            return false;
        }
        return is_writable($dir);
    }

    public static function get(): self
    {
        static $instance = null;
        return $instance ??= new self();
    }
}
