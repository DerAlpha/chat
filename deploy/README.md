# Flüsterchat unter `megamc.de/chats` betreiben

Auf megamc.de läuft bereits eine Anwendung („GameRoom") hinter einem Apache,
und die beantwortet derzeit **jeden** Pfad – auch `/chats`. Damit Flüsterchat
dort landet, braucht es zwei Dinge:

1. einen eigenen Dienst, der auf `127.0.0.1:8123` lauscht und weiß, dass er
   unter `/chats` hängt (`BASE_PATH=/chats`),
2. eine Apache-Regel, die `/chats/` **vor** der bestehenden Catch-all-Regel
   dorthin weiterreicht.

An GameRoom ändert sich dabei nichts.

```
                      ┌──────────────────────────────┐
  megamc.de/chats/ ──▶│ Apache                       │──▶ 127.0.0.1:8123  Flüsterchat
  megamc.de/…      ──▶│  (erste passende Regel gewinnt)│──▶ … wie bisher    GameRoom
                      └──────────────────────────────┘
```

## Der schnelle Weg

```bash
git clone -b claude/chat-website-no-signup-qpswkk https://github.com/DerAlpha/chat.git
cd chat
sudo bash deploy/install.sh
```

Das Skript legt den Benutzer `fluesterchat` an, installiert nach
`/opt/fluesterchat`, richtet den systemd-Dienst ein und prüft sich selbst.
**Deine Apache-Konfiguration fasst es nicht an** – den Block fügst du selbst
ein, damit an der bestehenden Seite garantiert nichts kaputtgeht.

Danach:

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite headers
sudoedit /etc/apache2/sites-available/<deine-megamc-vhost>.conf   # Block einfügen
sudo apache2ctl configtest && sudo systemctl reload apache2
```

## Der Apache-Block

Inhalt von [`apache-chats.conf`](apache-chats.conf), einzufügen in den
`<VirtualHost *:443>` von megamc.de – **oberhalb** der vorhandenen
`ProxyPass`-Zeilen:

```apache
RewriteEngine On
RewriteCond %{HTTP:Upgrade} =websocket [NC]
RewriteCond %{HTTP:Connection} upgrade [NC]
RewriteRule ^/?chats/ws$ "ws://127.0.0.1:8123/chats/ws" [P,L]

RewriteRule ^/?chats$ /chats/ [R=302,L]

ProxyPass        /chats/ http://127.0.0.1:8123/chats/ connectiontimeout=5 timeout=3600
ProxyPassReverse /chats/ http://127.0.0.1:8123/chats/

RequestHeader set X-Forwarded-Proto "https"
```

Drei Feinheiten, die leicht schiefgehen und hier bewusst so gelöst sind:

| Zeile | Warum |
| --- | --- |
| Die `RewriteRule` fürs WebSocket steht **ganz oben** | Sonst reicht die HTTP-Regel darunter das Protokoll-Upgrade als gewöhnliche Anfrage weiter, und der Chat bleibt stumm. |
| `/chats` → `/chats/` als **RewriteRule**, nicht `RedirectMatch` | Eine vorhandene `ProxyPass /`-Catch-all greift früher als `mod_alias` und verschluckt die Umleitung. Nachgemessen: mit `RedirectMatch` landete `/chats` bei GameRoom. |
| `ProxyPass /chats**/**` mit Schrägstrich | `ProxyPass /chats` vergleicht stumpf den Präfix und würde auch `/chatsammlung` einfangen. |

Die ganze Konfiguration wurde mit einem echten Apache 2.4 gegengeprüft –
inklusive WebSocket, Bildversand, PWA-Geltungsbereich und der Frage, ob
`/chatsammlung` weiterhin bei GameRoom landet.

## Auf Knopfdruck aus GitHub ausliefern

Wenn du künftig nicht mehr auf den Server willst: der Workflow
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) macht das
Ganze aus GitHub heraus – testet vorher und startet danach neu.

Er läuft **nur auf Knopfdruck** (Actions → „Auf den Server ausliefern" → *Run
workflow*) und tut ohne die folgenden Secrets gar nichts:

| Secret | Inhalt |
| --- | --- |
| `DEPLOY_HOST` | `megamc.de` |
| `DEPLOY_USER` | SSH-Benutzer |
| `DEPLOY_SSH_KEY` | privater Schlüssel; der öffentliche gehört in dessen `~/.ssh/authorized_keys` |
| `DEPLOY_PORT` | optional, Standard 22 |
| `DEPLOY_KNOWN_HOSTS` | optional, Ausgabe von `ssh-keyscan megamc.de` – damit ist der Server fest verankert |

Der Benutzer braucht auf dem Server passwortlosen `sudo` für genau zwei Befehle:

```
deployuser ALL=(root) NOPASSWD: /usr/bin/systemctl restart fluesterchat, \
                                /usr/bin/systemctl is-active fluesterchat
```

Voraussetzung: die Erstinstallation (oben) ist einmal gelaufen.

## Von Hand statt per Skript

```bash
sudo useradd --system --home-dir /opt/fluesterchat --shell /usr/sbin/nologin fluesterchat
sudo git clone -b claude/chat-website-no-signup-qpswkk \
     https://github.com/DerAlpha/chat.git /opt/fluesterchat
cd /opt/fluesterchat && sudo npm ci --omit=dev
sudo mkdir -p /var/lib/fluesterchat
sudo chown -R fluesterchat:fluesterchat /opt/fluesterchat /var/lib/fluesterchat

sudo cp deploy/fluesterchat.service /etc/systemd/system/
# ExecStart prüfen: der Pfad muss zu `which node` passen
sudo systemctl daemon-reload && sudo systemctl enable --now fluesterchat
curl http://127.0.0.1:8123/chats/healthz
```

## Einstellungen ändern

Ohne die Unit anzufassen – in `/etc/fluesterchat.env`:

```bash
PORT=8123
BASE_PATH=/chats
TRUST_PROXY=1
ROOM_IDLE_TTL_HOURS=168
MAX_BLOB_BYTES=12582912
```

`sudo systemctl restart fluesterchat` danach.

## Aktualisieren

```bash
cd /opt/fluesterchat
sudo -u fluesterchat git pull
sudo -u fluesterchat npm ci --omit=dev
sudo systemctl restart fluesterchat
```

Laufende Chats überstehen den Neustart: der Dienst schreibt seinen Stand beim
`SIGTERM` weg und liest ihn beim Start wieder ein.

## Nachsehen, wenn etwas klemmt

```bash
systemctl status fluesterchat
journalctl -u fluesterchat -f
curl -i http://127.0.0.1:8123/chats/healthz     # ohne Apache
curl -i https://megamc.de/chats/healthz          # mit Apache
```

| Beobachtung | Wahrscheinliche Ursache |
| --- | --- |
| `/chats` zeigt GameRoom | Der Block steht **unter** der Catch-all-Regel. Er muss darüber. |
| Seite lädt, aber bleibt bei „Verbindung wird hergestellt …" | `proxy_wstunnel` fehlt oder die WebSocket-Regel steht nicht oben. |
| Bilder kommen nicht an | `LimitRequestBody` im Apache kleiner als `MAX_BLOB_BYTES` (12 MB). |
| Kamera und Mikrofon gehen nicht | Nur über HTTPS erlaubt – auf megamc.de ist das gegeben. |
| Nach einem Update bleibt die alte Fassung | Service Worker: einmal hart neu laden. Die Version im Cache-Namen wechselt bei jeder Änderung an `sw.js`. |

## Wieder entfernen

```bash
sudo systemctl disable --now fluesterchat
sudo rm /etc/systemd/system/fluesterchat.service && sudo systemctl daemon-reload
sudo rm -rf /opt/fluesterchat /var/lib/fluesterchat
sudo userdel fluesterchat
# und den Block wieder aus dem Apache-vhost löschen
```
