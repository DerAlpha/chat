# Flüsterchat

Ein Chat **ohne Anmeldung, ohne Konto, ohne Telefonnummer** – zu zweit oder in
einer kleinen Gruppe. Eine Person erzeugt einen Einmal-Code (in einer Gruppe
einen je Teilnehmer), gibt ihn weiter, und schon läuft die Unterhaltung.
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

**Gruppen (im Bau)**
- Beim Anlegen einer Gruppe entsteht für jede Person ein eigener Einmal-Code
- Alle teilen sich einen Gruppenschlüssel; der liegt für jeden Code einzeln
  verpackt auf dem Server – öffnen kann ihn nur, wer den passenden Code hat
- Ein Code gibt einen Platz her, nicht die Gruppe: wer einen abfängt, kommt
  an die Pakete der anderen nicht heran
- In eine Gruppe kommt niemand allein über die Raum-ID – nur über einen
  eingelösten Platz
- Verwalterrechte prüft der Server, nicht die Oberfläche: wer keine hat,
  bekommt auch beim Aufruf von Hand ein 403
- Profilbilder gehen verschlüsselt über den Server – für jeden Raum einzeln,
  mit dem Schlüssel genau dieses Raums

**Sprechen statt tippen**
- Sprach- und Videoanrufe zwischen den beiden Geräten, direkt im Browser
- Die Aushandlung ist genauso verschlüsselt wie eine Nachricht – der Server
  reicht sie durch, ohne sie lesen zu können
- Vier Prüfzeichen aus den Zertifikaten beider Seiten: stimmen sie überein,
  sitzt niemand dazwischen
- Der Medienstrom selbst läuft über DTLS-SRTP, direkt von Gerät zu Gerät –
  und darüber liegt, wo der Browser es hergibt, noch eine zweite Schicht:
  jedes Bild und jedes Tonpaket wird zusätzlich mit dem Schlüssel aus eurem
  Code verschlüsselt
- Stumm schalten, Kamera aus, vorne/hinten wechseln, mitten im Sprachanruf
  die Kamera zuschalten
- Auf Wunsch alles über den eigenen Relaisdienst – dann sieht das Gegenüber
  die eigene IP-Adresse nicht

**Wer hat es gelesen?**
- Unter der eigenen Nachricht steht in Gruppen ein Auge mit einer Zahl: so
  viele haben sie gelesen. Ein Haken sagt dort zu wenig – bei acht Leuten ist
  „alle haben gelesen" selten und „jemand hat gelesen" nichtssagend
- Antippen öffnet die Liste mit den Namen; am Rechner wächst sie schon beim
  Darüberfahren als Blase aus dem Auge heraus
- Getrennt und blasser stehen die, für die es nur bereitliegt. „Gelesen" heißt:
  das andere Gerät hat es gemeldet. Alles andere wäre eine Bestätigung, die
  niemand gegeben hat – und genau so steht es auch da

**Gruppen**
- Ein Code je Person, nicht einer für alle. Wer einen weitergibt, gibt genau
  einen Platz weiter – nicht die Gruppe
- Jeder Code gilt genau einmal; danach ist er verbraucht
- Der Gruppenschlüssel ist gewürfelt und liegt auf jedem Platz einzeln
  verpackt – mit einem Schlüssel, den nur dieser eine Code hergibt. Der
  Server sieht Pakete, die er nicht öffnen kann
- Im Paket steht, wozu der Schlüssel gehört. Nennt der Server einen anderen
  Raum, bricht der Beitritt ab – das ist der einzige Schutz gegen einen
  Server, der jemanden in einen fremden Raum lotst
- Über fremden Blasen steht, von wem sie kommen; in der Kopfzeile, wie viele
  gerade da sind
- Wer die Gruppe anlegt, verwaltet sie. Verwalter können das Gruppenbild
  setzen, Rechte weitergeben und nachträglich weitere Leute einladen – der
  Server prüft die Rolle selbst, ein versteckter Knopf ist keine Sicherung
- Die letzte Verwalterin kann sich ihre Rechte nicht selbst nehmen; eine
  Gruppe ohne Verwaltung ließe sich nie wieder erweitern
- Nachträglich einladen heißt: neue Codes, neue Plätze, derselbe
  Gruppenschlüssel – wieder einzeln verpackt, wieder nur einmal einlösbar
- Anrufe bleiben in Gruppen vorerst aus (siehe *Was noch fehlt*)

**Profile**
- Ein richtiges Profil statt nur eines Bildchens: Bild in groß, Name und ein
  paar Zeilen über sich. Antippen zieht das Bild ganz auf
- Auch die Leute, mit denen man schreibt, haben eins – erreichbar über Bild
  und Namen in der Kopfzeile, in Gruppen über die Mitgliederliste
- Der Text über einen selbst geht denselben Weg wie der Name: verschlüsselt,
  im selben Päckchen. Der Server sieht Zeichensalat
- Gruppen haben ein eigenes Profil mit Bild, Größe und den Mitgliedern; die
  Verwalterknöpfe stehen dort, wo man sie sucht

**Profilbilder**
- Ein Bild auswählen, quadratisch zuschneiden (schieben und zoomen), fertig –
  es gilt in allen Chats
- Herauszoomen geht bis weit über den Bildrand hinaus. Was dann frei bleibt,
  ist schwarz – im Ausschnittfenster genauso wie im fertigen Bild
- Der Kreis im Ausschnitt ist das Bild: was außerhalb liegt, wird schwarz –
  nicht nur abgedunkelt angezeigt und dann doch mitgespeichert. Vorher wurde
  das ganze Quadrat gesichert; rund angezeigt fiel das nicht auf, aber sobald
  das Bild groß und unbeschnitten zu sehen war, standen darin Stellen, die
  niemand ausgewählt hatte
- Und der Kreis hat die richtige Größe: ohne `closest-side` reicht ein
  radialer Verlauf bis zur weitesten Ecke, der freie Kreis war rund 30 % zu
  klein
- Der Weg über die Leinwand ist auch hier die Metadatenentfernung: kopiert
  werden nur Bildpunkte, GPS und Kameramodell bleiben zurück
- In jeden Raum geht das Bild einzeln, verschlüsselt mit dem Schlüssel genau
  dieses Raums. Der Server legt Bytes ab, die er nicht ansehen kann
- Gruppen haben ein eigenes Bild – setzen dürfen es nur Verwalter
- Für die Liste auf der Startseite bleibt eine winzige Fassung auf dem Gerät;
  sie braucht keine Verbindung zu zwanzig Räumen

**Wo die Ansicht steht**
- Ein Chat öffnet sich bei der neuesten Nachricht – mit einem Sprung, nicht
  mit einer Reise durch den ganzen Verlauf. Das war der Fehler: `behavior:
  'auto'` übernimmt die CSS-Regel `scroll-behavior: smooth`, und die weiche
  Fahrt blieb unterwegs stehen, sobald ein Bild die Höhe änderte
- Wer unten steht, bleibt unten – auch wenn Bilder erst später ihre Höhe
  bekommen. Nachgezogen wird, solange der Chat offen ist
- Ein Scroll-Ereignis, das erst zum nächsten Bildaufbau eintrifft, wird nicht
  mehr für einen Wisch des Nutzers gehalten: die App merkt sich, wohin sie
  selbst gesprungen ist
- Älteres wird geladen, wenn jemand danach sucht – nicht schon beim Öffnen
- Ein Wisch auf der Textzeile bleibt in der Textzeile. Die Seite selbst hat
  nichts zu scrollen, und die Bewegung wird nicht nach außen weitergereicht

**Wenn der Text nicht passt**
- „zuletzt gesehen vor 3 Std." ist auf einem Telefon länger als die Zeile.
  Abgeschnitten fehlt genau die Angabe, um die es ging
- Passt der Text nicht, wandert er langsam nach links, wartet und kommt
  zurück – und nur dann. Wer „prefers-reduced-motion" gesetzt hat, bekommt
  Auslassungspunkte statt Bewegung
- Der Rahmen schneidet ab, der Streifen darin bewegt sich: so bleibt die
  Kopfzeile schmal, statt das Fenster nach rechts wachsen zu lassen

**Wie es sich bewegt**
- Vier Werte für die ganze App: kurz für alles unter dem Finger, mittel für
  den Normalfall, lang für Flächen, die kommen und gehen – und eine einzige
  Kurve. Jedes Teil mit eigenem Tempo wirkt unruhig
- Bewegt wird, was etwas erklärt: ein Bildschirmwechsel, eine neue Nachricht,
  ein Menü, das aufgeht, der Sendeknopf, der erscheint. Nichts blinkt, nichts
  dreht sich, nichts hüpft
- Bewegt wird nur, was wirklich neu ist. Der Nachrichtenverlauf wird bei jeder
  Kleinigkeit neu aufgebaut – bei jeder Lesebestätigung, bei jedem Tippen des
  Gegenübers. Ohne dieses Gedächtnis zappelte dabei jedes Mal der ganze Chat
- Ein Menü kommt in der Reihenfolge herein, in der man es liest – ein Hauch
  Versatz, und nach den ersten Zeilen ist Schluss. Sonst wartet man unten auf
  sein Blatt
- Jede Einblendung beschreibt nur ihren Anfang; das Ende ist der normale
  Zustand. Das ist kein Geschmack, sondern Vorsicht: wer „prefers-reduced-motion"
  gesetzt hat, bekommt die Dauer auf null – und dann muss ohne die Bewegung
  alles genau richtig dastehen. Ein Muster, das auf `opacity: 0` endet, wäre
  ein unsichtbares Fenster

**Wie es klingt**
- Neun Klänge, alle aus einer Fünftonleiter: was hintereinander erklingt,
  passt zusammen
- Gerechnet statt geladen – keine Tondateien, kein Byte mehr Download,
  offline klingt es genauso
- Gedämpft mit einem Tiefpass, weicher Ein- und Ausschwung: ein Hinweis,
  kein Alarm. Die Marke sagt „psst…", so klingt sie auch
- Wer hinsieht, bekommt nur eine leise Bestätigung; wer woanders ist, den
  eigentlichen Benachrichtigungston
- Ton aus heißt Ton aus – ein Test im echten Browser zählt nach, dass dann
  wirklich kein einziger Ton mehr entsteht

**Wie es aussieht**
- Die Marke ist eine Sprechblase, in der „psst…" steht – ein Bild für das,
  worum es geht: leise miteinander reden
- Dieselbe Marke überall: im Browser-Reiter, als App-Symbol auf dem
  Startbildschirm und auf der Startseite der App. Vorher stand dort ein
  Schloss, das eher nach Bank als nach Gespräch aussah
- Ein einziges SVG liefert alles; die PNG-Größen fürs Betriebssystem werden
  daraus gebaut (`npm run icons`)
- Bis 32 px ist das Wort zu lesen, darunter trägt der Umriss allein

**Drumherum**
- Tippanzeige, Online-Status, „zuletzt gesehen", Lesebestätigung
- Verlauf bleibt erhalten – auch nach Neuladen, Verbindungsabbruch oder Serverneustart
- Mehrere Chats parallel, mit Übersicht auf der Startseite: ein Punkt mit der
  Zahl ungelesener Nachrichten, die Zeit der letzten eingegangenen Nachricht,
  und wenn dort gerade jemand schreibt, steht das auch da. Wo etwas ankommt,
  rutscht nach oben
- Zweites eigenes Gerät per Geräte-Link dazuschalten
- Als App installierbar (PWA), offline lauffähige Oberfläche, Benachrichtigungen
- Hell/Dunkel/Automatisch, Deutsch und Englisch
- GIF-Suche über das eigene Backend – Giphy sieht den Server, nie die Nutzer
- Reaktionen aus allen gängigen Emoji, mit Suche auf Deutsch und Englisch
- Fragt nach einem Namen, wenn noch keiner feststeht – überspringbar
- In der Übersicht steht, wie das Gegenüber heißt – und wer will, gibt einem
  Chat einen eigenen Namen („Mama", „Verein"), der nur auf dem eigenen Gerät liegt
- Liegt auf dem Server eine neue Fassung, legt sich ein Fenster über alles, das
  sich nicht wegklicken lässt; ein Knopf holt die App komplett frisch
- „Chat löschen" räumt sofort alles ab – bei beiden und auf dem Server
- „Alle Daten löschen" räumt das ganze Gerät ab und vernichtet dabei jeden
  Chat auch bei allen anderen Beteiligten. Drei Hinweise stehen davor, jeder
  sagt etwas anderes; der letzte Knopf lässt sich erst nach 15 Sekunden
  drücken – lang genug, um gelesen zu haben, was er anrichtet

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
- die Zugangstoken, die er selbst vergeben hat,
- wer gerade tippt (nicht was) – das braucht die Übersicht auf der Startseite,
- die IP-Adressen der Verbindungen (wie bei jedem Webserver).

Er sieht **nicht**: Codes, Klartexte, Bilder, Namen, Dateinamen oder Reaktionen.

### Alles löschen

Unter „Über" steht ganz unten **Alle Daten löschen**. Der Knopf tut zwei Dinge,
und das zweite übersieht man leicht:

1. Er vernichtet jeden Chat **auf dem Server**. Damit verschwindet dieselbe
   Unterhaltung auch bei allen, mit denen man geschrieben hat – samt Bildern,
   Sprachnachrichten und Dateien. Sie werden nicht gefragt. In Gruppen trifft
   es jedes Mitglied.
2. Erst danach räumt er dieses Gerät ab: Chats, Name, Einstellungen,
   Zwischenspeicher, Service Worker.

Die Reihenfolge ist keine Geschmacksfrage. Andersherum wären die Zugangstoken
weg, mit denen sich die Räume überhaupt vernichten lassen – die Unterhaltungen
blieben bei allen anderen stehen, und man käme selbst nie wieder an sie heran,
um das nachzuholen. Geht ein Raum nicht weg, wird deshalb auch lokal nichts
gelöscht; stattdessen fragt die App, ob sie es noch einmal versuchen soll.

Weggeworfen wird nur, was diese App angelegt hat (Präfix `fc:`). Ein pauschales
Leeren des Speichers würde auf einer Domain mit anderen Seiten deren Daten
gleich mitnehmen.

### Was das Modell nicht leistet

- Wer den Code hat, ist im Chat. Gib ihn über einen Kanal weiter, dem du traust –
  ein Screenshot in einer Gruppe reicht, um den Chat zu verlieren.
- Es gibt keine Forward Secrecy: ein später bekannt gewordener Code entschlüsselt
  auch ältere, noch gespeicherte Nachrichten. Dagegen hilft „Chat löschen".
- Code, Schlüssel und Token liegen im `localStorage` des Geräts. Wer das entsperrte
  Gerät in der Hand hat, kommt an den Chat.
- Der ausgelieferte Code stammt vom Server. Wer den Server kontrolliert, könnte
  theoretisch manipuliertes JavaScript ausliefern – das gilt für jede Web-Krypto.
- In einer Gruppe kennt jedes Mitglied den Gruppenschlüssel. Wer einmal drin
  ist, kann alles mitlesen, was danach geschrieben wird – auch nachdem er
  gegangen ist. Es gibt keinen Rauswurf und keinen Schlüsselwechsel.
- Anrufe gibt es in Gruppen deshalb (noch) nicht: der Schlüssel für Ton und
  Bild hängt am Raumschlüssel, und der Aushandlungskanal geht an alle. Jedes
  Mitglied könnte damit ein fremdes Zweiergespräch im selben Raum mithören.
  Das braucht einen eigenen Schlüsseltausch je Anruf, bevor es einen Knopf gibt.

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
  js/sound.js   Die Klangpalette - gerechnet, nicht geladen
  js/emoji.js   Mitgelieferter Emoji-Katalog samt Suche
  js/call.js    Anrufe: Aushandlung, Prüfzeichen, Mikrofon und Kamera
  js/framecrypto.js Die zweite Schicht über Ton und Bild
  js/call-worker.js Eigener Faden, in dem sie angewendet wird
  js/ui.js      Screens, Sheets, Toasts, Zeitangaben
  js/version.js Die Fassung - gestempelt, nicht von Hand gezählt
  js/app.js     Ablaufsteuerung
  sw.js         Service Worker (nur die Hülle, niemals Inhalte)
scripts/
  version.mjs   Rechnet die Fassung aus dem Inhalt und stempelt sie ein
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
npm test                  # 314 Unit-Tests (Server, Krypto, QR, i18n, Installer, STUN/TURN, GIFs, Anrufe, Gruppen, Uebersicht, Klang, Bildmarke, Fassung)
npm run test:e2e          # 123 Tests am Smartphone + 16 am Rechner
npm run test:e2e:subpath  # dieselben Tests unter /chats
npm run test:e2e:php      # dieselben Tests gegen das PHP-Backend
npm run test:all
```

Für die E2E-Tests einmalig `npx playwright install chromium`.

Wer etwas an `public/` ändert, lässt danach `npm run stamp` laufen: die Fassung
der App ist ein Fingerabdruck über alles Ausgelieferte, und ein Test wird rot,
solange der Stempel nicht dazu passt. Damit kann niemand vergessen, sie
hochzuzählen – und niemand bleibt auf einer alten Fassung sitzen, ohne es zu
merken.

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
- Zwei echte Browser bauen einen echten Anruf auf: der eine ruft an, der andere
  nimmt ab, und danach zählt der Test die tatsächlich angezeigten Bilder. Nicht
  `videoWidth` – die Bildgrösse steht im Klartext-Kopf eines Schlüsselbilds und
  kommt auch dann an, wenn kein einziges Bild entschlüsselt werden konnte.
- Ein Mitschnitt des Aushandlungskanals belegt, dass weder Angebot noch
  Adresskandidat noch Zertifikats-Fingerabdruck im Klartext über den Server gehen.
- Die komplette Suite läuft mehrfach: gegen Node, gegen Node unter `/chats` und
  gegen das PHP-Backend. Dieselben 139 Tests, drei Auslieferungen – damit fällt
  auf, wenn eine davon bei der nächsten Änderung wegbricht.
- Für die Übersicht wird nachgemessen, dass mit falschem Token nichts über
  den Inhalt eines Raums herauskommt – keine Zahl, keine Zeit, kein Tippen.
- Bei den Rechten wird nicht geprüft, ob der Knopf fehlt, sondern ob es ohne
  ihn geht: ein gewöhnliches Mitglied ruft die Verwalter-Wege mit seinem
  eigenen gültigen Token direkt auf und bekommt zweimal 403.
- Beim Profilbild schneidet ein Test mit, was wirklich über die Leitung geht:
  weder PNG noch JPEG noch WebP – nichts, was ein Bildbetrachter öffnet.
  Dasselbe für den Text über einen selbst: er darf auf keiner Leitung im
  Klartext auftauchen.
- Beim Zuschneiden werden Bildpunkte gezählt: nach dem Herauszoomen muss die
  Ecke des fertigen Bildes schwarz UND undurchsichtig sein, die Mitte nicht.
- Und es wird nachgerechnet, dass der Ausschnitt genau der Kreis ist: die
  Vorlage ist ein Farbverlauf, aus dem sich zu jedem Bildpunkt des Ergebnisses
  zurückrechnen lässt, welche Stelle der Vorlage dort steht – sie muss auf
  wenige Prozent genau die sein, die im Fenster an dieser Stelle stand.
- Beim Scrollen wird nicht die Absicht geprüft, sondern das Ergebnis: ein
  langer Chat mit Bildern wird geöffnet, und der Abstand zum unteren Ende
  muss null sein und null bleiben. Ein zweiter Test zählt die
  Zwischenstände – eine weiche Fahrt durch den Verlauf hinterlässt Dutzende,
  ein Sprung keinen.
- Der Wisch auf der Textzeile ist ein echter: der Test schickt Touch-Punkte
  über das Eingabefeld und misst danach nach, dass Kopfzeile und App keinen
  Bildpunkt verrutscht sind.
- Bei der Laufschrift wird nicht die Klasse geprüft, sondern die Bewegung:
  dieselbe Stelle, zwei Zeitpunkte, und dazwischen muss sich etwas getan
  haben.
- Bei den Animationen wird gezählt, was sich bewegt: nach dem Öffnen eines
  Chats keine einzige Blase, bei einer eingehenden Nachricht genau eine – und
  nach der nächsten Lesebestätigung immer noch nicht der ganze Verlauf.
- Und die wichtigere Hälfte: mit abgestellter Bewegung wird jede sichtbare
  Fläche nachgemessen. Nichts darf halb durchsichtig oder verschoben
  hängenbleiben, auch kein Menüeintrag – eine stehengebliebene Verzögerung
  hielte ihn in seinem Anfangszustand fest, und der ist unsichtbar.
- Beim Austritt wird nachgemessen, dass das alte Token wirklich nichts mehr
  öffnet – auch nicht die Übersicht, die sonst weiter verraten hätte, wann in
  der Gruppe zuletzt etwas ankam und wer gerade tippt.
- Beim Löschen aller Daten wird beides nachgemessen: dass Zweiergespräche bei
  den anderen wirklich verschwinden, dass eine Gruppe dagegen stehen bleibt
  und dort nur noch „Diese Person hat die Gruppe verlassen" steht, und dass im
  Speicher des Geräts nichts von der App zurückbleibt – während Daten fremder Seiten auf derselben Domain
  unangetastet stehen bleiben. Und dass man nicht hineinstolpert: ein Test
  tippt zweimal schnell auf dieselbe Stelle, ein zweiter drückt die
  Eingabetaste – beide Male steht der Hinweis danach immer noch da.
- Bei Gruppen wird nicht nur geprüft, dass drei Leute miteinander reden
  können, sondern auch, dass ein Code sich kein zweites Mal einlösen lässt –
  und dass ein Server, der im Platzpaket einen anderen Raum nennt, abgewiesen
  wird. Dafür verbiegt der Test die Antwort des Servers unterwegs.
- Beim Ton wird nicht gezählt, was eingeplant wurde, sondern was am Ausgang
  ankommt: der Test hängt einen Messknoten vor den Lautsprecher. Kappt man
  eine einzige Verbindung im Klangweg, ist die App still – und genau dann
  wird der Test rot, statt weiter Töne zu zählen, die niemand hört.
- Die Bildmarke wird an den ausgelieferten PNG-Bytes nachgemessen: dass die
  Ecken der runden Symbole durchsichtig sind (dort lag vorher eine flache
  Farbe hinter einem Verlauf – ein blauer Viertelmond im violetten Eck) und
  dass das Abzeichen für die Statusleiste seine Leinwand ausfüllt.
- Das gebaute Upload-Paket wurde zusätzlich unter einem echten Apache mit
  `mod_php` und der mitgelieferten `.htaccess` durchgetestet. Dabei fiel auf,
  dass Apache vielerorts ein `Alias /icons/` auf sein eigenes Symbolverzeichnis
  mitbringt und einen gleichnamigen Ordner verdeckt – deshalb heißt er hier
  `img/`, und ein Test prüft, dass wirklich jede Datei geladen wird.

Jeder dieser Regressionstests wurde gegen den fehlerhaften Stand gegengeprüft – sie
werden rot, wenn man die zugehörige Korrektur zurücknimmt.

## Was noch fehlt

- **Anrufe in Gruppen.** Der Schlüssel für Ton und Bild wird aus dem
  Raumschlüssel abgeleitet, und der Aushandlungskanal geht an alle im Raum.
  In einer Gruppe könnte damit jedes Mitglied ein fremdes Zweiergespräch im
  selben Raum mithören. Bis es dafür einen eigenen Schlüsseltausch je Anruf
  gibt, sind die Anrufknöpfe in Gruppen ausgeblendet – kein halbgares Angebot.
- **Zweites eigenes Gerät in einer Gruppe.** Der Geräte-Link trägt den Code,
  und den gibt es in einer Gruppe nicht. Er bräuchte einen eigenen Weg.
- **Jemanden aus einer Gruppe entfernen.** Alle teilen einen Schlüssel; wer
  einmal drin war, kann alles Weitere mitlesen. Ein Rauswurf wäre nur mit
  einem Schlüsselwechsel ehrlich.
- **Sticker selbst erstellen und empfangene speichern.**

## Einstellungen

Alle Werte sind optional – siehe `.env.example`. Die wichtigsten:

| Variable | Vorgabe | Bedeutung |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Wo gelauscht wird |
| `TRUST_PROXY` | `0` | Auf `1`, wenn ein Reverse Proxy davorsteht |
| `DATA_DIR` | `./data` | Momentaufnahme und verschlüsselte Anhänge |
| `ROOM_IDLE_TTL_HOURS` | `168` | Stille Chats verschwinden nach einer Woche |
| `UNCLAIMED_ROOM_TTL_HOURS` | `24` | Nie eingelöste Codes verfallen nach einem Tag |
| `MAX_ROOM_CAPACITY` | `16` | Wie groß eine Gruppe höchstens werden darf |
| `MAX_BLOB_BYTES` | `12582912` | Größe eines einzelnen Anhangs (12 MB) |
| `MESSAGES_PER_MINUTE` | `240` | Nachrichten pro Mitglied und Minute |
| `WELCOME_HISTORY` | `300` | Nachrichten beim Verbinden; ältere lädt der Client nach |
| `BASE_PATH` | – | Unterpfad, z. B. `/chats`. Leer = Wurzel |

## Lizenz

MIT – siehe [LICENSE](LICENSE).
