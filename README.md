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
- „Chat löschen" räumt sofort alles ab – bei beiden und auf dem Server

**Fürs Smartphone gemacht**
- Nichts scrollt seitlich weg, auch nicht auf 320 px schmalen Displays
- Alle Schaltflächen mindestens 44 px – für Daumen statt Mauszeiger
- Eingabefelder mit 16 px, damit iOS beim Antippen nicht hineinzoomt
- Randbereiche (Notch, Home-Indicator) werden respektiert
- Die Bildschirmtastatur schiebt die Ansicht mit, statt sie zu verdecken

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

Der Code ist das gemeinsame Geheimnis. Aus ihm entstehen im Browser zwei Dinge:

| Aus dem Code abgeleitet | Wofür | Sieht der Server? |
| --- | --- | --- |
| `SHA-256("…room…" + Code)`, gekürzt auf 22 Zeichen | Raum-ID | **ja** – ein Hash, aus dem sich der Code nicht zurückrechnen lässt |
| `PBKDF2-SHA256(Code, Salt, 250 000 Runden)` → AES-256-GCM | Nachrichten und Anhänge | **nein** |

- Der Code steht ausschließlich im **URL-Fragment** (`…/#H7Q2-9XKM-3BTV`). Fragmente
  werden von Browsern grundsätzlich nicht an den Server geschickt.
- Jede Nachricht bekommt einen frischen 12-Byte-IV; gespeichert wird `IV ‖ Chiffrat`.
- Anhänge werden vor dem Hochladen im Browser verschlüsselt. Der Server verwahrt
  undurchsichtige Bytes und kennt weder Dateinamen noch Typ noch Bildmaße.
- AES-GCM erkennt Manipulationen: ein einziges gekipptes Bit lässt die Entschlüsselung fehlschlagen.

Der Code besteht aus 12 Zeichen des Crockford-Base32-Alphabets – 60 Bit Entropie.
Zusammen mit 250 000 PBKDF2-Runden ist Durchprobieren teuer. Die verwechselbaren
Zeichen `I`, `L`, `O` und `U` kommen nicht vor; beim Eintippen werden `O→0` und
`I/L→1` automatisch korrigiert.

### Was der Server trotzdem weiß

Ehrlichkeit gehört dazu. Der Server sieht:

- die Raum-ID (Hash des Codes), Zeitstempel und Größen der Nachrichten,
- wer wann verbunden ist, und wie viele Anhänge es gibt,
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
server/
  index.js      Einstieg: HTTP-Server, Aufräum-Intervall, sauberes Herunterfahren
  app.js        REST-Schnittstelle, Sicherheits-Header, statische Dateien
  ws.js         WebSocket-Verteiler: Nachrichten, Präsenz, Tippanzeige
  store.js      Räume, Mitglieder, Verlauf, Anhänge, Momentaufnahme auf Platte
  ratelimit.js  Token-Bucket ohne Fremdcode
  config.js     Alle Stellschrauben an einem Ort
public/
  index.html    Grundgerüst inklusive Icon-Sprite
  css/app.css   Mobile-First-Gestaltung, hell und dunkel
  js/crypto.js  Code-Erzeugung, Schlüsselableitung, Ver- und Entschlüsselung
  js/qr.js      Eigener QR-Encoder (Byte-Modus, Stufe M, Versionen 1–10)
  js/net.js     REST-Aufrufe und WebSocket mit selbsttätigem Wiederverbinden
  js/media.js   Bilder verkleinern, Ton aufnehmen
  js/session.js Was das Gerät sich merkt
  js/i18n.js    Deutsch und Englisch
  js/ui.js      Screens, Sheets, Toasts, Zeitangaben
  js/app.js     Ablaufsteuerung
  sw.js         Service Worker (nur die Hülle, niemals Inhalte)
```

Keine Build-Kette, kein Bundler, kein Framework: Der Browser lädt die ES-Module direkt.
Auf dem Server stehen nur `express` und `ws` – sonst nichts.

## Tests

```bash
npm test          # 72 Unit-Tests (Server, Krypto, QR, i18n)
npm run test:e2e  # 20 End-to-End-Tests mit zwei simulierten Smartphones
npm run test:all
```

Für die E2E-Tests einmalig `npx playwright install chromium`.

Ein paar Dinge, die dabei tatsächlich geprüft werden:

- Der QR-Encoder wird für **alle Längen von 1 bis 213 Zeichen** Modul für Modul gegen
  eine unabhängige Referenzimplementierung verglichen.
- Ein Mitschnitt aller WebSocket-Frames belegt, dass Klartext und Code den Browser nie verlassen.
- `<script>` im Nachrichtentext bleibt Text und wird nicht ausgeführt.
- Ein dritter Gast wird abgewiesen, ein zweites eigenes Gerät nicht.
- Auf 320 px Breite scrollt nichts seitlich weg, und alle Schaltflächen bleiben daumengroß.

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

## Lizenz

MIT – siehe [LICENSE](LICENSE).
