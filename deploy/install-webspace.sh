#!/bin/sh
# ---------------------------------------------------------------------------
# Flüsterchat auf klassischen Webspace installieren (lima-city & Co.).
#
# Braucht weder root noch Node - nur eine Shell, curl oder wget, und tar.
# Es wird ausschliesslich innerhalb deines Webspace geschrieben.
#
#   sh install-webspace.sh                      # Docroot wird gesucht
#   sh install-webspace.sh --docroot ~/html     # oder selbst angeben
#   sh install-webspace.sh --url https://fluester.4lima.de
#
# Erneut ausführen = aktualisieren. Eine eigene api/lib/config.local.php
# und der Datenordner bleiben dabei unangetastet.
# ---------------------------------------------------------------------------
set -eu

REPO_URL="https://codeload.github.com/DerAlpha/chat/tar.gz/refs/heads/claude/chat-website-no-signup-qpswkk"
DOCROOT=""
SITE_URL=""
DATA_DIR=""
FORCE=0
MARKER=".fluesterchat"

say()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }
die()  { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --docroot) DOCROOT="${2:-}"; shift 2 ;;
        --url)     SITE_URL="${2:-}"; shift 2 ;;
        --data)    DATA_DIR="${2:-}"; shift 2 ;;
        --force)   FORCE=1; shift ;;
        -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "Unbekannte Option: $1" ;;
    esac
done

# --- Werkzeuge -------------------------------------------------------------
step "Werkzeuge"
if command -v curl >/dev/null 2>&1; then
    FETCH="curl -fsSL -o"
elif command -v wget >/dev/null 2>&1; then
    FETCH="wget -qO"
else
    die "Weder curl noch wget vorhanden - dann bitte den Weg per FTP nehmen."
fi
command -v tar >/dev/null 2>&1 || die "tar fehlt."
say "Herunterladen mit ${FETCH%% *}, entpacken mit tar"

# --- Document Root ---------------------------------------------------------
step "Document Root"
if [ -z "$DOCROOT" ]; then
    for candidate in "$HOME/html" "$HOME/www" "$HOME/public_html" "$HOME/htdocs"; do
        if [ -d "$candidate" ]; then
            [ -n "$DOCROOT" ] && die "Mehrere mögliche Verzeichnisse gefunden. Bitte --docroot angeben."
            DOCROOT="$candidate"
        fi
    done
fi
[ -n "$DOCROOT" ] || die "Kein Document Root gefunden. Bitte --docroot <pfad> angeben (steht im lima-city-Panel unter Domains)."
[ -d "$DOCROOT" ] || die "$DOCROOT gibt es nicht."
[ -w "$DOCROOT" ] || die "In $DOCROOT darf nicht geschrieben werden."
DOCROOT=$(cd "$DOCROOT" && pwd)
say "$DOCROOT"

# Nichts Fremdes überschreiben.
if [ ! -f "$DOCROOT/$MARKER" ] && [ "$FORCE" -eq 0 ]; then
    unexpected=$(ls -A "$DOCROOT" 2>/dev/null | grep -v -E '^(index\.html?|\.ftpquota|\.well-known|cgi-bin)$' || true)
    if [ -n "$unexpected" ]; then
        printf '\nIn %s liegt schon etwas anderes:\n' "$DOCROOT"
        printf '%s\n' "$unexpected" | sed 's/^/    /'
        die "Zur Sicherheit abgebrochen. Mit --force trotzdem installieren (vorhandene Dateien gleichen Namens werden ersetzt)."
    fi
fi

# --- Datenordner -----------------------------------------------------------
step "Datenordner"
[ -n "$DATA_DIR" ] || DATA_DIR="$(dirname "$DOCROOT")/fluesterchat-data"
if mkdir -p "$DATA_DIR" 2>/dev/null && [ -w "$DATA_DIR" ]; then
    chmod 770 "$DATA_DIR" 2>/dev/null || true
    say "$DATA_DIR (ausserhalb des Docroots - gut)"
    DATA_OUTSIDE=1
else
    say "Neben dem Docroot ist kein Schreiben möglich - die App legt sich später api/data an."
    DATA_OUTSIDE=0
fi

# --- Herunterladen ---------------------------------------------------------
step "Herunterladen"
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t fluesterchat)
trap 'rm -rf "$TMP"' EXIT INT TERM
$FETCH "$TMP/app.tar.gz" "$REPO_URL" || die "Download fehlgeschlagen: $REPO_URL"
mkdir -p "$TMP/src"
tar -xzf "$TMP/app.tar.gz" -C "$TMP/src" --strip-components=1 || die "Archiv liess sich nicht entpacken."
[ -d "$TMP/src/public" ] && [ -d "$TMP/src/php/api" ] || die "Archiv sieht nicht wie erwartet aus."
say "$(du -sh "$TMP/src" 2>/dev/null | cut -f1) entpackt"

# --- Eigene Einstellungen retten -------------------------------------------
KEEP_CONFIG=""
if [ -f "$DOCROOT/api/lib/config.local.php" ]; then
    KEEP_CONFIG="$TMP/config.local.php"
    cp "$DOCROOT/api/lib/config.local.php" "$KEEP_CONFIG"
    say "Vorhandene config.local.php wird behalten"
fi

# --- Installieren ----------------------------------------------------------
step "Installieren"
# Alte Fassungen unserer eigenen Ordner weg, damit keine Reste liegenbleiben.
for dir in css js img api; do
    rm -rf "$DOCROOT/$dir"
done
cp -R "$TMP/src/public/." "$DOCROOT/"
mkdir -p "$DOCROOT/api"
cp -R "$TMP/src/php/api/." "$DOCROOT/api/"
cp "$TMP/src/php/site/.htaccess" "$DOCROOT/.htaccess"
cp "$TMP/src/php/site/.user.ini" "$DOCROOT/.user.ini"
[ -n "$KEEP_CONFIG" ] && cp "$KEEP_CONFIG" "$DOCROOT/api/lib/config.local.php"

if [ "$DATA_OUTSIDE" -eq 1 ] && [ ! -f "$DOCROOT/api/lib/config.local.php" ]; then
    printf "<?php\nreturn [\n    'dataDir' => '%s',\n];\n" "$DATA_DIR" > "$DOCROOT/api/lib/config.local.php"
    say "Datenpfad in api/lib/config.local.php eingetragen"
fi

date > "$DOCROOT/$MARKER"
chmod 644 "$DOCROOT/.htaccess" "$DOCROOT/.user.ini" 2>/dev/null || true
say "$(find "$DOCROOT" -type f | wc -l | tr -d ' ') Dateien liegen bereit"

# --- Nachsehen -------------------------------------------------------------
step "Kurze Kontrolle"
for needed in index.html .htaccess .user.ini api/index.php img/icon.svg js/app.js; do
    [ -f "$DOCROOT/$needed" ] || die "$needed fehlt - die Installation ist unvollständig."
done
say "Alle erwarteten Dateien sind da"

if command -v php >/dev/null 2>&1; then
    PHP_OK=$(php -r 'echo PHP_VERSION_ID >= 80100 ? "ja" : "nein";' 2>/dev/null || echo "?")
    PHP_VER=$(php -r 'echo PHP_VERSION;' 2>/dev/null || echo "unbekannt")
    if [ "$PHP_OK" = "ja" ]; then
        say "PHP auf der Kommandozeile: $PHP_VER"
    else
        say "Achtung: PHP auf der Kommandozeile ist $PHP_VER."
        say "Entscheidend ist die Version des Webservers - die steht im Panel."
    fi
fi

printf '\n%s\n' '---------------------------------------------------------------'
printf 'Fertig.\n\n'
if [ -n "$SITE_URL" ]; then
    printf 'Jetzt aufrufen:   %s/api/setup-check.php\n' "${SITE_URL%/}"
    printf 'Danach los:       %s/\n' "${SITE_URL%/}"
else
    printf 'Jetzt im Browser: https://DEINE-DOMAIN/api/setup-check.php\n'
    printf 'Danach los:       https://DEINE-DOMAIN/\n'
fi
printf '\nDie Prüfseite sagt, ob PHP-Version, Rechte und .htaccess passen.\n'
printf 'Wenn dort "Alles bereit" steht, kann api/setup-check.php weg.\n'
printf '%s\n' '---------------------------------------------------------------'
