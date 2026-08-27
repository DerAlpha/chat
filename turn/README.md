# Der Relaisdienst für Anrufe

Ein eigener STUN- und TURN-Dienst, ohne Fremdbibliothek, Teil dieses
Projekts. Er sorgt dafür, dass Anrufe auch dann zustande kommen, wenn sich
die beiden Geräte nicht direkt finden.

## Warum überhaupt

Bei einem Anruf versuchen beide Geräte zuerst, sich unmittelbar zu erreichen.
In den meisten Heimnetzen klappt das. Hinter strengeren Routern – Mobilfunk,
Firmennetze, doppeltes NAT – klappt es nicht. Dann braucht es jemanden in der
Mitte, der die Pakete weiterreicht.

Üblicherweise nimmt man dafür einen fremden Dienst. Das wollten wir nicht:
er sieht, wer wann mit wem telefoniert. Deshalb dieser hier.

## Was er zu sehen bekommt

Verschlüsselte Pakete und die IP-Adressen beider Seiten. **Nicht** den Ton
oder das Bild: der Medienstrom ist zweifach verschlüsselt, bevor er hier
ankommt – einmal von WebRTC selbst (DTLS-SRTP) und darunter noch einmal mit
dem Schlüssel des Chats. Der Dienst reicht Bytes weiter, die er nicht lesen
kann.

## Wo er läuft – und wo nicht

Er braucht einen **dauerhaft laufenden Prozess** und **eigene UDP-Ports**.

| | geht |
| --- | --- |
| Eigener Server / VPS | ja |
| Raspberry Pi zu Hause (mit Portfreigabe) | ja |
| Neben dem Node-Backend dieses Projekts | ja |
| **lima-city und ähnlicher PHP-Webspace** | **nein** |

Auf klassischem Webspace ist das strukturell ausgeschlossen: dort läuft PHP
nur im Anfrage-Antwort-Takt hinter Apache, keine dauerhaften Prozesse, keine
eigenen Ports. Das ist keine Fleißfrage.

**Was auf lima-city trotzdem geht:** die Aushandlung und das Ausstellen der
Zugangsdaten. Beides ist reines PHP. Anrufe funktionieren dort also – nur
eben auf dem direkten Weg zwischen den Geräten. Für die Fälle, in denen der
nicht trägt, kann der Webspace auf einen Relaisdienst zeigen, der woanders
steht. Dafür müssen die beiden nie miteinander reden: sie teilen ein
Geheimnis und rechnen daraus dieselben kurzlebigen Zugangsdaten aus.

## Starten

```bash
# Geheimnis erzeugen - einmalig
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

TURN_SECRET='<das Geheimnis>' \
TURN_PUBLIC_ADDRESS=203.0.113.5 \
node turn/index.js
```

### Schalter

| Umgebungsvariable | Vorgabe | Wofür |
| --- | --- | --- |
| `TURN_SECRET` | – | **Pflicht.** Gemeinsam mit dem Webbackend |
| `TURN_PUBLIC_ADDRESS` | – | Die von außen erreichbare Adresse |
| `TURN_PORT` | `3478` | Port für die Aushandlung |
| `TURN_HOST` | `0.0.0.0` | Adresse, auf der gelauscht wird |
| `TURN_REALM` | `fluesterchat` | Bereichsname, muss überall gleich sein |
| `TURN_MIN_PORT` / `TURN_MAX_PORT` | `49152` / `65535` | Bereich für die Relais-Ports |
| `TURN_TTL_SECONDS` | `7200` | Gültigkeit ausgegebener Zugangsdaten |
| `TURN_MAX_ALLOCATIONS` | `500` | Obergrenze insgesamt |
| `TURN_MAX_PER_ADDRESS` | `10` | Obergrenze je IP-Adresse |
| `TURN_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### Ports freigeben

```
udp 3478            Aushandlung
udp 49152-65535     die Relais selbst
```

Ein knapperer Bereich tut es auch – jedes gleichzeitige Gespräch belegt einen
Port je Teilnehmer. `TURN_MIN_PORT=50000 TURN_MAX_PORT=50999` reicht für rund
500 gleichzeitige Anrufe.

### Als Dienst einrichten

```ini
# /etc/systemd/system/fluesterchat-turn.service
[Unit]
Description=Flüsterchat Relaisdienst
After=network.target

[Service]
Type=simple
User=fluesterchat
WorkingDirectory=/opt/fluesterchat
Environment=TURN_SECRET=<das Geheimnis>
Environment=TURN_PUBLIC_ADDRESS=203.0.113.5
Environment=TURN_MIN_PORT=50000
Environment=TURN_MAX_PORT=50999
ExecStart=/usr/bin/node turn/index.js
Restart=always
RestartSec=5

# Er braucht nichts vom System außer seinen Ports.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
RestrictAddressFamilies=AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
```

## Im Webbackend eintragen

**Node-Backend:**

```bash
STUN_URLS='stun:anruf.meine-domain.de:3478' \
TURN_URLS='turn:anruf.meine-domain.de:3478?transport=udp' \
TURN_SECRET='<dasselbe Geheimnis>' \
node server/index.js
```

**PHP-Backend** (`api/lib/config.local.php`):

```php
<?php
return [
    'stunUrls' => ['stun:anruf.meine-domain.de:3478'],
    'turnUrls' => ['turn:anruf.meine-domain.de:3478?transport=udp'],
    'turnSecret' => '<dasselbe Geheimnis>',
];
```

Ohne Einträge bietet die App keine Anrufe an – lieber gar nicht als eine
Schaltfläche, die bei der Hälfte der Leute nicht funktioniert.

## Nachsehen, ob es läuft

```bash
node -e "
import('./turn/stun.js').then(async ({ MessageBuilder, METHOD, CLASS, decode, ATTR }) => {
  const dgram = await import('node:dgram');
  const s = dgram.createSocket('udp4');
  s.on('message', (d) => {
    const m = decode(d);
    console.log('Antwort:', m.getAddress(ATTR.XOR_MAPPED_ADDRESS));
    s.close();
  });
  s.send(new MessageBuilder(METHOD.BINDING, CLASS.REQUEST).build(), 3478, 'anruf.meine-domain.de');
});
"
```

Kommt eine Adresse zurück, steht der Dienst.

## Was umgesetzt ist

Der Teil von RFC 5389 und RFC 5766, den WebRTC benutzt: Binding, Allocate,
Refresh, CreatePermission, ChannelBind, Send und Data, dazu ChannelData und
Langzeit-Zugangsdaten mit `MESSAGE-INTEGRITY`.

Nicht umgesetzt: TURN über TCP und TLS, IPv6-Relais, `EVEN-PORT` und
`RESERVATION-TOKEN`. Für Anrufe aus dem Browser braucht es davon nichts.

Geprüft wird gegen die Beispielnachrichten aus RFC 5769, gegen einen selbst
gebauten UDP-Client – und gegen den echten WebRTC-Stack von Chromium mit
`iceTransportPolicy: 'relay'`, was jeden direkten Weg verbietet. Was dort
ankommt, ist durch den Dienst gelaufen oder gar nicht.

```bash
npm test                     # Codec und Dienst
npm run test:e2e             # darin: der Anruf durch das Relais
```

## Grenzen, ehrlich benannt

- **Kein TCP/TLS.** Netze, die UDP vollständig sperren, kommen nicht durch.
  Dafür bräuchte es TURN über Port 443, was mit einem Webserver auf derselben
  Maschine kollidiert.
- **Der Dienst sieht die IP-Adressen** beider Seiten und weiß, dass zwischen
  ihnen etwas läuft. Inhalte sieht er nicht.
- **Er kostet Bandbreite.** Ein Videoanruf über das Relais bewegt in beide
  Richtungen je etwa 1–2 Mbit/s. Die Obergrenzen oben sind da, damit niemand
  den Dienst als kostenlose Datenschleuder benutzt – die Zugangsdaten laufen
  nach zwei Stunden ab und werden nur an Mitglieder eines Chats ausgegeben.
