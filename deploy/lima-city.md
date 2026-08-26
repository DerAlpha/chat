# Flüsterchat auf lima-city (fluester.4lima.de)

lima-city ist klassischer PHP-Webspace: **kein Node, keine WebSockets, keine
dauerhaft laufenden Prozesse** – das schließt der Hoster ausdrücklich aus.
Deshalb liegt dem Projekt ein zweites Backend in PHP bei. Verschlüsselung,
Oberfläche, Bilder, Sprachnachrichten und QR-Code bleiben unverändert; nur der
Weg der Nachrichten ist ein anderer:

| | Node-Server | PHP-Webspace |
| --- | --- | --- |
| Zustellung | WebSocket, der Server ruft | Long-Polling, der Browser fragt |
| Verzögerung | wenige Millisekunden | meist unter einer Sekunde |
| Tippanzeige | sofort | etwas träger |
| Voraussetzung | eigener Server | ganz normaler Webspace |

Welches Backend läuft, merkt der Browser selbst (`/api/config`) – am Client ist
nichts umzustellen.

## Der kurze Weg: ein Befehl über SSH

Voraussetzung: dein Tarif hat SSH (bei lima-city die bezahlten Pakete,
Anmeldung ausschließlich per Schlüssel).

**Das Repo ist privat.** Ein `curl … | sh` direkt von GitHub scheitert deshalb
auf dem Server mit 404 – dort liegen keine Zugangsdaten. Der Weg führt über das
fertige Paket, das du ohnehin schon hast:

```bash
# 1. Paket hochladen
scp fluesterchat-webspace.tar.gz DEINNUTZER@fluester.4lima.de:~/

# 2. Ein Befehl, der den Rest erledigt
ssh DEINNUTZER@fluester.4lima.de 'mkdir -p ~/fc \
  && tar xzf ~/fluesterchat-webspace.tar.gz -C ~/fc \
  && sh ~/fc/install-webspace.sh --source ~/fc --url https://fluester.4lima.de \
  && rm -rf ~/fc ~/fluesterchat-webspace.tar.gz'
```

Das Skript sucht den Document Root, legt den Datenordner **neben** ihm an,
trägt den Pfad ein und prüft zum Schluss, ob wirklich alles liegt. Es braucht
weder root noch Node – nur eine Shell und `tar`.

### Wenn das Repo öffentlich wäre

Dann ginge es tatsächlich in einer Zeile, ohne vorher etwas hochzuladen:

```bash
curl -fsSL https://raw.githubusercontent.com/DerAlpha/chat/BRANCH/deploy/install-webspace.sh | sh
```

Das ist deine Entscheidung – im Code stecken keine Geheimnisse (Schlüssel
entstehen erst im Browser), aber öffentlich ist öffentlich.

### Schalter

| Schalter | Wofür |
| --- | --- |
| `--source ~/ordner` | Aus einem entpackten Paket installieren |
| `--archive ~/paket.tar.gz` | Direkt aus `.tar.gz` oder `.zip` |
| `--docroot ~/html` | Verzeichnis selbst angeben, wenn die Suche danebenliegt |
| `--url https://…` | Für die Schlussmeldung mit den richtigen Adressen |
| `--data ~/woanders` | Anderer Ort für die Daten |
| `--force` | Auch installieren, wenn im Verzeichnis schon etwas anderes liegt |

Erneutes Ausführen aktualisiert. Eine eigene `api/lib/config.local.php`, der
Datenordner und fremde Dateien im Verzeichnis bleiben unangetastet – laufende
Chats überleben das.

Ohne SSH geht es genauso gut per FTP; das steht direkt darunter.

## Schritt 1: PHP-Version prüfen

Im lima-city-Panel unter **Domains → fluester.4lima.de → Details** die
PHP-Version auf **8.1 oder neuer** stellen. Ältere Versionen lehnt die App mit
einer klaren Meldung ab, statt seltsam kaputtzugehen.

Dort steht auch das **Document Root** – der Ordner, in den alles kommt
(meist `html`).

## Der andere Weg: per FTP

### Schritt 2: Paket bauen

Mit Node zur Hand:

```bash
git clone -b claude/chat-website-no-signup-qpswkk https://github.com/DerAlpha/chat.git
cd chat
node scripts/build-webspace.mjs
# -> dist/webspace/   (31 Dateien, rund 360 KB)
```

Ohne Node: Bei GitHub unter **Actions → „Webspace-Paket bauen" → Run workflow**
starten und danach `fluesterchat-webspace` herunterladen – das ist derselbe
Ordnerinhalt als ZIP.

### Schritt 3: Hochladen

Zugangsdaten stehen im Panel unter **Webspace → FTP-Zugang**. Mit FileZilla
(oder dem lima-city-Dateimanager) den **Inhalt** von `dist/webspace/` in das
Document Root laden – nicht den Ordner selbst.

Danach sieht es dort so aus:

```
html/                     <- Document Root
  index.html
  .htaccess               <- wichtig!
  .user.ini               <- wichtig!
  css/  js/  img/
  manifest.webmanifest
  sw.js
  api/
    index.php
    .htaccess
    lib/
```

> **Achtung bei den Punkt-Dateien:** `.htaccess` und `.user.ini` blenden viele
> FTP-Programme aus. In FileZilla: *Server → Versteckte Dateien anzeigen*.
> Ohne `.htaccess` findet der Browser die API nicht.

Der Ordner für die Daten wird beim ersten Zugriff selbst angelegt – als
`fluesterchat-data` **neben** dem Document Root, also von außen nicht
erreichbar. Klappt das mangels Rechten nicht, weicht die App auf `api/data`
aus und schützt den Ordner dort per `.htaccess`.

### Schritt 4: Nachsehen, ob alles sitzt

```
https://fluester.4lima.de/api/setup-check.php
```

Die Seite prüft PHP-Version, Erweiterungen, Schreibrechte, Upload-Grenzen und
ob `.htaccess` greift – und sagt bei jedem Haken dazu, was zu tun ist. Steht
dort **„Alles bereit"**, ist die Seite unter `https://fluester.4lima.de/`
einsatzbereit. Die Prüfdatei danach ruhig löschen.

## Aktualisieren

Paket neu bauen und den Inhalt erneut hochladen. Zwei Dinge dabei:

- `api/lib/config.local.php` (falls angelegt) **nicht überschreiben**.
- Der Ordner `fluesterchat-data` bleibt unangetastet – laufende Chats
  überleben das Update.

Nach dem Hochladen einmal hart neu laden (Strg+Umschalt+R), sonst hält der
Service Worker noch kurz die alte Fassung.

## Eigene Einstellungen

Optional `api/lib/config.local.php` anlegen:

```php
<?php
return [
    // Wie lange eine Abfrage auf neue Nachrichten wartet. Kürzer = mehr
    // Anfragen, aber weniger gleichzeitig belegte PHP-Prozesse.
    'pollWaitSeconds' => 20,

    // Stille Chats verschwinden nach dieser Zeit (Sekunden).
    'roomIdleTtl' => 7 * 24 * 3600,

    // Nie eingelöste Codes verfallen früher.
    'unclaimedRoomTtl' => 24 * 3600,

    // Größe eines einzelnen Anhangs.
    'maxBlobBytes' => 12 * 1024 * 1024,

    // Eigener Datenpfad, falls der Standard nicht passt.
    // 'dataDir' => '/home/webpages/lima-city/DEINNAME/fluesterchat-data',
];
```

## Was man wissen sollte

**Jede wartende Abfrage belegt einen PHP-Prozess.** Bei zwei Leuten in einem
Chat sind das zwei – unkritisch. Wer viele Chats gleichzeitig laufen lässt und
an die Prozessgrenze des Tarifs stößt, setzt `pollWaitSeconds` herunter
(z. B. auf 8): dann fragt der Browser öfter, hält aber kürzer.

**Aufgeräumt wird nebenbei.** Ohne Cronjob putzt die App bei etwa jeder
200. Anfrage abgelaufene Räume weg. Wer einen Cronjob hat, kann stattdessen
regelmäßig `api/index.php` mit `/healthz` aufrufen.

**Kamera, Mikrofon und Installation als App brauchen HTTPS.** Bei lima-city
ist das kostenlose Zertifikat im Panel mit einem Klick aktiviert.

## Wenn etwas klemmt

| Beobachtung | Ursache |
| --- | --- |
| „Diesen Chat gibt es nicht" gleich nach dem Anlegen | `.htaccess` fehlt oder wurde nicht mit hochgeladen |
| Seite lädt, bleibt aber bei „Verbindung wird hergestellt" | `api/config` liefert kein JSON – Rewrite greift nicht |
| Bilder brechen beim Senden ab | `post_max_size` zu klein; `.user.ini` prüfen |
| Alles ist zäh, Nachrichten kommen verspätet | `max_execution_time` sehr klein – die App wartet dann kürzer und fragt öfter |
| Nach dem Update alte Fassung | Service Worker: einmal hart neu laden |

Erste Anlaufstelle bleibt `api/setup-check.php` – die Seite beantwortet die
meisten dieser Fälle direkt.
