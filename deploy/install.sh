#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Installiert Flüsterchat als eigenen Dienst unter /opt/fluesterchat.
#
# Was dieses Skript anfasst:
#   - legt den Systembenutzer "fluesterchat" an (falls nicht vorhanden)
#   - /opt/fluesterchat        (Programmcode)
#   - /var/lib/fluesterchat    (Daten)
#   - /etc/systemd/system/fluesterchat.service
#
# Was es NICHT anfasst: deine Apache-Konfiguration und alles andere auf dem
# Server. Der Apache-Block wird am Ende nur ausgegeben, eingefügt wird er
# von Hand - damit nichts an deiner bestehenden Seite kaputtgeht.
#
# Aufruf:  sudo bash deploy/install.sh
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="${REPO:-https://github.com/DerAlpha/chat.git}"
BRANCH="${BRANCH:-claude/chat-website-no-signup-qpswkk}"
APP_DIR="${APP_DIR:-/opt/fluesterchat}"
DATA_DIR="${DATA_DIR:-/var/lib/fluesterchat}"
SERVICE_USER="${SERVICE_USER:-fluesterchat}"
PORT="${PORT:-8123}"
BASE_PATH="${BASE_PATH:-/chats}"

die() { echo "FEHLER: $*" >&2; exit 1; }
info() { echo "  ->  $*"; }

[[ $EUID -eq 0 ]] || die "Bitte mit sudo ausführen."
command -v git >/dev/null || die "git fehlt (apt install git)."
command -v node >/dev/null || die "node fehlt. Node 20.11 oder neuer wird gebraucht."
command -v npm  >/dev/null || die "npm fehlt."

NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node $NODE_MAJOR ist zu alt, mindestens 20 wird gebraucht."

# Port schon belegt? Dann lieber abbrechen als der bestehenden Seite ins Gehege kommen.
if command -v ss >/dev/null && ss -ltn "( sport = :$PORT )" | grep -q ":$PORT"; then
  if ! systemctl is-active --quiet fluesterchat; then
    die "Port $PORT ist belegt - bitte mit PORT=<frei> erneut aufrufen."
  fi
fi

echo "== Benutzer =="
if id "$SERVICE_USER" >/dev/null 2>&1; then
  info "Benutzer $SERVICE_USER existiert bereits"
else
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  info "Benutzer $SERVICE_USER angelegt"
fi

echo "== Code =="
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" remote set-url origin "$REPO"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
  info "Vorhandene Installation auf den neuesten Stand gebracht"
else
  mkdir -p "$APP_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
  info "Nach $APP_DIR geklont"
fi

echo "== Abhängigkeiten =="
( cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund )
info "express und ws installiert (sonst nichts)"

echo "== Verzeichnisse =="
mkdir -p "$DATA_DIR"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR" "$DATA_DIR"
chmod 750 "$DATA_DIR"
info "$DATA_DIR gehört $SERVICE_USER"

echo "== Dienst =="
sed -e "s|^ExecStart=.*|ExecStart=$NODE_BIN server/index.js|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" \
    -e "s|^Environment=PORT=.*|Environment=PORT=$PORT|" \
    -e "s|^Environment=BASE_PATH=.*|Environment=BASE_PATH=$BASE_PATH|" \
    -e "s|^Environment=DATA_DIR=.*|Environment=DATA_DIR=$DATA_DIR|" \
    -e "s|^ReadWritePaths=.*|ReadWritePaths=$DATA_DIR|" \
    -e "s|^User=.*|User=$SERVICE_USER|" \
    -e "s|^Group=.*|Group=$SERVICE_USER|" \
    "$APP_DIR/deploy/fluesterchat.service" > /etc/systemd/system/fluesterchat.service
systemctl daemon-reload
systemctl enable --now fluesterchat
sleep 2
systemctl is-active --quiet fluesterchat || {
  journalctl -u fluesterchat -n 30 --no-pager
  die "Der Dienst ist nicht hochgekommen - Ausgabe siehe oben."
}
info "fluesterchat läuft"

echo "== Selbsttest =="
if curl -fsS "http://127.0.0.1:$PORT$BASE_PATH/healthz" >/dev/null; then
  info "Healthcheck auf 127.0.0.1:$PORT$BASE_PATH/healthz antwortet"
else
  die "Healthcheck antwortet nicht."
fi

cat <<INFO

===========================================================================
Der Dienst läuft. Was jetzt noch von Hand passieren muss:

1) Apache-Module (einmalig):
     sudo a2enmod proxy proxy_http proxy_wstunnel rewrite headers

2) Den Block aus $APP_DIR/deploy/apache-chats.conf in den
   <VirtualHost *:443> von megamc.de einfügen - WICHTIG: VOR den
   bestehenden ProxyPass-Regeln. Die erste passende Regel gewinnt.

3) Prüfen und übernehmen:
     sudo apache2ctl configtest
     sudo systemctl reload apache2

4) Aufrufen:  https://megamc.de/chats

Nichts anderes auf dem Server wurde verändert.
===========================================================================
INFO
