# Flüsterchat

Ein Chat für genau zwei Personen – **ohne Anmeldung, ohne Konto, ohne Telefonnummer**.
Eine Person erzeugt einen Einmal-Code, gibt ihn weiter, und schon läuft die Unterhaltung.
Fotos aus der Galerie, Kamerabilder, Sprachnachrichten und Dateien inklusive.
Gebaut fürs Smartphone, funktioniert genauso am Rechner.

```
┌──────────────┐        Code weitergeben        ┌──────────────┐
│   Person A   │  ──────────────────────────▶   │   Person B   │
│              │   (Link, QR-Code, abtippen)    │              │
└──────┬───────┘                                └───────┬──────┘
       │  verschlüsselt auf dem Gerät                   │
       ▼                                                ▼
   ┌──────────────────────────────────────────────────────┐
   │   Server: sieht nur einen Hash und unlesbare Bytes    │
   └──────────────────────────────────────────────────────┘
```

## Was drin ist

**Der Kern**
- Einmal-Code (`H7Q2-9XKM-3BTV`) zum Weitergeben – per Link, QR-Code oder abgetippt
- Genau zwei Plätze pro Code. Ist er einmal eingelöst, kommt niemand mehr hinterher
- Ende-zu-Ende-Verschlüsselung mit AES-256-GCM; der Schlüssel steckt im Code und verlässt das Gerät nie
- Kein Konto, keine E-Mail, keine Telefonnummer, keine Tracker, keine Cookies

**Beim Schreiben**
- Text mit Emoji, anklickbaren Links und mehrzeiligen Nachrichten
- Bilder aus der Galerie (auch mehrere auf einmal) und direkt aus der Kamera
- Sprachnachrichten mit Pegelanzeige und Abspieler
- Beliebige Dateien
- Antworten mit Zitat, Reaktionen, Nachrichten bearbeiten und für beide Seiten löschen

**Drumherum**
- Tippanzeige, Online-Status, „zuletzt gesehen", Lesebestätigung
- Verlauf bleibt erhalten – auch nach Neuladen, Verbindungsabbruch oder Serverneustart
- Mehrere Chats parallel, mit Übersicht auf der Startseite
- Zweites eigenes Gerät per Geräte-Link dazuschalten
- Als App installierbar (PWA), offline lauffähige Oberfläche, Benachrichtigungen
- Hell/Dunkel/Automatisch, Deutsch und Englisch
- Reaktionen aus allen gängigen Emoji, mit Suche auf Deutsch und Englisch
- Fragt nach einem Namen, wenn noch keiner feststeht – überspringbar
- „Chat löschen" räumt sofort alles ab – bei beiden und auf dem Server

**Fürs Smartphone gemacht**
- Nichts scrollt seitlich weg, auch nicht auf 320 px schmalen Displays
- Alle Schaltflächen mindestens 44 px – für Daumen statt Mauszeiger
- Eingabefelder mit 16 px, damit iOS beim Antippen nicht hineinzoomt
- Randbereiche (Notch, Home-Indicator) werden respektiert
- Die Bildschirmtastatur schiebt die Ansicht mit, statt sie zu verdecken
- Langes Drücken öffnet das Nachrichtenmenü, statt Text zu markieren

**Am Rechner ein eigenes Layout**
- Ab 900 px zwei Spalten: links die Chatliste, rechts die Unterhaltung
- Ohne offenen Chat steht rechts ein Platzhalter statt einer leeren Fläche
- Der Menüknopf einer Nachricht erscheint beim Überfahren mit der Maus;
  die rechte Maustaste tut es genauso
- Text lässt sich mit der Maus ganz normal markieren
- Enter schickt ab, Umschalt+Enter macht eine neue Zeile
- Halbhohe Menüs werden zu Dialogen in der Fenstermitte

## Loslegen

```bash
npm install
npm start
# http://localhost:3000
```

Zum Ausprobieren zu zweit: Seite in zwei Browserfenstern öffnen,
im ersten „Neuen Chat starten", den Code ins zweite kopieren.

Auf dem Handy testen: Server im lokalen Netz starten und die IP-Adresse aufrufen.

```bash
HOST=0.0.0.0 npm start
# dann z. B. http://192.168.1.42:3000 am Telefon öffnen
```

> **Wichtig:** Kamera, Mikrofon und die Installation als App brauchen **HTTPS**
> (`localhost` ausgenommen). Im Betrieb gehört ein Reverse Proxy mit Zertifikat davor.

### Mit Docker

```bash
docker compose up -d
```

Die Daten (Momentaufnahme + verschlüsselte Anhänge) landen im Volume `chat-data`.

### Auf ganz normalem Webspace, ohne Node

Nicht jeder Hoster lässt dauerhaft laufende Prozesse zu – klassischer
PHP-Webspace etwa kann keine WebSockets. Dafür liegt ein **zweites Backend in
PHP** bei (`php/`). Verschlüsselung, Oberfläche, Bilder und Sprachnachrichten
bleiben identisch; nur der Weg der Nachrichten ist ein anderer:

| | Node (`server/`) | PHP (`php/`) |
| --- | --- | --- |
| Zustellung | WebSocket – der Server ruft | Long-Polling – der Browser fragt |
| Verzögerung | Millisekunden | meist unter einer Sekunde |
| Speicher | Momentaufnahme als JSON | Dateien je Raum, atomar geschrieben |
| Voraussetzung | Node ≥ 20 | PHP ≥ 8.1, `.htaccess` |

Welches der beiden läuft, findet der Browser selbst heraus (`GET api/config`)
und wählt den passenden Transportweg. Am Client ist nichts umzustellen.

```bash
npm run php:dev                  # PHP-Backend samt Client lokal starten
node scripts/build-webspace.mjs  # fertiges Verzeichnis zum Hochladen
```

Auf einem Webspace mit SSH genügt ein Befehl:

```bash
curl -fsSL https://raw.githubusercontent.com/DerAlpha/chat/refs/heads/claude/chat-website-no-signup-qpswkk/deploy/install-webspace.sh | sh
```

Danach ist Aktualisieren ein Einzeiler – der Installer merkt sich Document
Root, Datenordner und Adresse:

```bash
ssh DEINNUTZER@DEINHOST 'sh ~/fluesterchat-update.sh'
```

Ohne SSH tut es der FTP-Weg. Beides steht in [`deploy/lima-city.md`](deploy/lima-city.md).

### In einem Unterordner einer bestehenden Domain

Die App muss nicht auf einer eigenen Domain wohnen. Mit `BASE_PATH` hängt sie
unter einem beliebigen Pfad – Startseite, API, WebSocket, Service Worker,
Manifest und Einladungslinks ziehen automatisch mit:

```bash
BASE_PATH=/chats PORT=8123 npm start
# -> http://localhost:8123/chats/
```

Der Client leitet seine Basis aus dem eigenen Modulpfad ab (`import.meta.url`),
das HTML lädt alles relativ. Es braucht also weder einen Bauschritt noch ein
eingebettetes Skript – was auch gut ist, denn die CSP verbietet inline.

Eine fertige Anleitung für **Apache + systemd** samt geprüfter Konfiguration
liegt in [`deploy/`](deploy/README.md).

### Hinter einem Reverse Proxy

WebSockets müssen durchgereicht werden, und `TRUST_PROXY=1` sorgt dafür, dass die
Rate-Limits die echte Client-IP sehen statt der des Proxys.

```nginx
location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade    $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host       $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;   # sonst fallen stille WebSockets raus
}
```

## Wie die Verschlüsselung funktioniert

Der Code ist das gemeinsame Geheimnis. Aus ihm entstehen im Browser zwei Dinge –
beide aus **einem einzigen** PBKDF2-Lauf mit 250 000 Runden:

```
Code ──PBKDF2-SHA256(250 000 Runden)──▶ 384 Bit
                                         ├─ Byte 0–31  → AES-256-GCM-Schlüssel   (bleibt im Browser)
                                         └─ Byte 32–47 → Raum-ID (22 Zeichen)    (sieht der Server)
```

Dass beides aus demselben teuren Lauf kommt, ist kein Detail, sondern der Kern:
Wäre die Raum-ID ein billiger Ein-Runden-Hash desselben Codes, könnte jemand mit
Kenntnis der Raum-ID den 60-Bit-Coderaum mit einem SHA-256 pro Kandidat
durchprobieren – und die 250 000 Runden nur ein einziges Mal für den Treffer
rechnen. So kostet **jeder** Rateversuch den vollen Aufwand.

- Der Code steht ausschließlich im **URL-Fragment** (`…/#H7Q2-9XKM-3BTV`). Fragmente
  werden von Browsern grundsätzlich nicht an den Server geschickt.
- Jede Nachricht bekommt einen frischen 12-Byte-IV; gespeichert wird `IV ‖ Chiffrat`.
- Anhänge werden vor dem Hochladen im Browser verschlüsselt. Der Server verwahrt
  undurchsichtige Bytes und kennt weder Dateinamen noch Typ noch Bildmaße.
- AES-GCM erkennt Manipulationen: ein einziges gekipptes Bit lässt die Entschlüsselung fehlschlagen.

Der Code besteht aus 12 Zeichen des Crockford-Base32-Alphabets – 60 Bit Entropie.
Zusammen mit 250 000 PBKDF2-Runden liegt der Aufwand fürs Durchprobieren bei
rund 2⁷⁸ Hash-Operationen. Die verwechselbaren Zeichen `I`, `L`, `O` und `U`
kommen nicht vor; beim Eintippen werden `O→0` und `I/L→1` automatisch korrigiert.

Das Zugangstoken, das der Server jedem der beiden Plätze gibt, reist im
WebSocket-Subprotokoll statt im Query-String – Query-Strings landen in fast jedem
Reverse-Proxy-Log, Header-Werte nicht.

### Was in einem Bild sonst noch steckt

Ein Foto vom Handy trägt mehr als das Motiv: GPS-Koordinaten, Kameramodell,
Seriennummer, Aufnahmezeit. Beim Senden geht ein Bild deshalb über eine
Zeichenfläche – die kennt nur Bildpunkte, alles andere bleibt zurück. Auch
der Dateiname wird ersetzt, denn `IMG_20260826_143107.jpg` verrät die
Aufnahmezeit.

| | Bild aus Galerie oder Kamera | „Datei senden" |
| --- | --- | --- |
| Standort, Gerät, Seriennummer | **entfernt** | bleibt drin |
| Dateiname | durch `bild.webp` ersetzt | bleibt |
| Größe | auf 1600 px verkleinert | unverändert |

**Videos und Dokumente gehen Byte für Byte hinaus.** Sie im Browser
umzurechnen wäre langsam und verlustbehaftet, deshalb tut die App es nicht –
und sagt es im Anhang-Menü auch dazu, statt Sicherheit vorzutäuschen. Wer den
Aufnahmeort eines Videos nicht mitschicken will, entfernt ihn vorher.

Ein Test schickt ein Foto mit echten GPS-Daten durch die Aufbereitung und
prüft die Ausgabe Byte für Byte auf Rückstände. Der Grund dafür ist eine
Optimierung, die es in diesem Projekt schon einmal gab: kleine Originale
wurden unverändert weitergereicht, weil das ein paar Kilobyte sparte – und
schickte den Standort gleich mit.

### Was der Server trotzdem weiß

Ehrlichkeit gehört dazu. Der Server sieht:

- die Raum-ID, Zeitstempel und Größen der Nachrichten,
- wer wann verbunden ist, und wie viele Anhänge es gibt,
- die beiden Zugangstoken, die er selbst vergeben hat,
- die IP-Adressen der Verbindungen (wie bei jedem Webserver).

Er sieht **nicht**: Codes, Klartexte, Bilder, Namen, Dateinamen oder Reaktionen.

### Was das Modell nicht leistet

- Wer den Code hat, ist im Chat. Gib ihn über einen Kanal weiter, dem du traust –
  ein Screenshot in einer Gruppe reicht, um den Chat zu verlieren.
- Es gibt keine Forward Secrecy: ein später bekannt gewordener Code entschlüsselt
  auch ältere, noch gespeicherte Nachrichten. Dagegen hilft „Chat löschen".
- Code, Schlüssel und Token liegen im `localStorage` des Geräts. Wer das entsperrte
  Gerät in der Hand hat, kommt an den Chat.
- Der ausgelieferte Code stammt vom Server. Wer den Server kontrolliert, könnte
  theoretisch manipuliertes JavaScript ausliefern – das gilt für jede Web-Krypto.

## Wie es aufgebaut ist

```
php/            Backend für Webspace ohne Node (PHP 8.1+)
  api/index.php   Front-Controller
  api/lib/        Speicher, Frames, Präsenz, Rate-Limits
  site/           .htaccess und .user.ini fürs Wurzelverzeichnis
server/
  index.js      Einstieg: HTTP-Server, Aufräum-Intervall, sauberes Herunterfahren
  app.js        REST-Schnittstelle, Sicherheits-Header, statische Dateien
  ws.js         WebSocket-Verteiler: Nachrichten, Präsenz, Tippanzeige
  store.js      Räume, Mitglieder, Verlauf, Anhänge, Momentaufnahme auf Platte
  ratelimit.js  Token-Bucket ohne Fremdcode
  config.js     Alle Stellschrauben an einem Ort
public/
  index.html    Grundgerüst inklusive Icon-Sprite
  js/base.js    Wo die App hängt - aus dem eigenen Modulpfad abgeleitet
  css/app.css   Mobile First, ab 900 px zwei Spalten; hell und dunkel
  js/crypto.js  Code-Erzeugung, Schlüsselableitung, Ver- und Entschlüsselung
  js/qr.js      Eigener QR-Encoder (Byte-Modus, Stufe M, Versionen 1–10)
  js/net.js     REST-Aufrufe; WebSocket oder Long-Polling, je nach Server
  js/media.js   Bilder verkleinern, Ton aufnehmen
  js/session.js Was das Gerät sich merkt
  js/i18n.js    Deutsch und Englisch
  js/emoji.js   Mitgelieferter Emoji-Katalog samt Suche
  js/ui.js      Screens, Sheets, Toasts, Zeitangaben
  js/app.js     Ablaufsteuerung
  sw.js         Service Worker (nur die Hülle, niemals Inhalte)
turn/
  stun.js       STUN/TURN-Nachrichten lesen und schreiben (RFC 5389/5766)
  server.js     Der eigene Relaisdienst für Anrufe
  credentials.js Kurzlebige Zugangsdaten, die auch PHP ausstellen kann
  index.js      Startbefehl samt Schaltern
```

Keine Build-Kette, kein Bundler, kein Framework: Der Browser lädt die ES-Module direkt.
Auf dem Node-Server stehen nur `express` und `ws`, im PHP-Backend gar keine
Fremdbibliothek – nur `json` und `mbstring` aus der Standardausstattung.

## Tests

```bash
npm test                  # 136 Unit-Tests (Server, Krypto, QR, i18n, Installer, STUN/TURN)
npm run test:e2e          # 36 Tests am Smartphone + 12 am Rechner
npm run test:e2e:subpath  # dieselben Tests unter /chats
npm run test:e2e:php      # dieselben Tests gegen das PHP-Backend
npm run test:all
```

Für die E2E-Tests einmalig `npx playwright install chromium`.

Ein paar Dinge, die dabei tatsächlich geprüft werden:

- Der QR-Encoder wird für **alle Längen von 1 bis 213 Zeichen** Modul für Modul gegen
  eine unabhängige Referenzimplementierung verglichen.
- Ein Mitschnitt aller WebSocket-Frames belegt, dass Klartext und Code den Browser nie verlassen;
  ein zweiter Test belegt dasselbe für das Zugangstoken in allen URLs.
- Die Raum-ID wird gegen die naheliegenden Ein-Runden-Hashes des Codes geprüft, damit
  die PBKDF2-Härtung nicht versehentlich wieder umgangen wird.
- `<script>` im Nachrichtentext bleibt Text und wird nicht ausgeführt.
- Ein dritter Gast wird abgewiesen, ein zweites eigenes Gerät nicht.
- Auf 320 px Breite scrollt nichts seitlich weg, alle Schaltflächen bleiben 44 px groß,
  und das Chat-Layout hält auch, wenn das Verbindungsbanner verschwindet.
- Schnell hintereinander abgeschickte Nachrichten behalten ihre Reihenfolge, schon
  bevor die erste Quittung da ist.
- Die komplette Suite läuft mehrfach: gegen Node, gegen Node unter `/chats` und
  gegen das PHP-Backend. Dieselben 26 Tests, drei Auslieferungen – damit fällt
  auf, wenn eine davon bei der nächsten Änderung wegbricht.
- Das gebaute Upload-Paket wurde zusätzlich unter einem echten Apache mit
  `mod_php` und der mitgelieferten `.htaccess` durchgetestet. Dabei fiel auf,
  dass Apache vielerorts ein `Alias /icons/` auf sein eigenes Symbolverzeichnis
  mitbringt und einen gleichnamigen Ordner verdeckt – deshalb heißt er hier
  `img/`, und ein Test prüft, dass wirklich jede Datei geladen wird.

Jeder dieser Regressionstests wurde gegen den fehlerhaften Stand gegengeprüft – sie
werden rot, wenn man die zugehörige Korrektur zurücknimmt.

## Einstellungen

Alle Werte sind optional – siehe `.env.example`. Die wichtigsten:

| Variable | Vorgabe | Bedeutung |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Wo gelauscht wird |
| `TRUST_PROXY` | `0` | Auf `1`, wenn ein Reverse Proxy davorsteht |
| `DATA_DIR` | `./data` | Momentaufnahme und verschlüsselte Anhänge |
| `ROOM_IDLE_TTL_HOURS` | `168` | Stille Chats verschwinden nach einer Woche |
| `UNCLAIMED_ROOM_TTL_HOURS` | `24` | Nie eingelöste Codes verfallen nach einem Tag |
| `MAX_BLOB_BYTES` | `12582912` | Größe eines einzelnen Anhangs (12 MB) |
| `MESSAGES_PER_MINUTE` | `240` | Nachrichten pro Mitglied und Minute |
| `WELCOME_HISTORY` | `300` | Nachrichten beim Verbinden; ältere lädt der Client nach |
| `BASE_PATH` | – | Unterpfad, z. B. `/chats`. Leer = Wurzel |

## Lizenz

MIT – siehe [LICENSE](LICENSE).
