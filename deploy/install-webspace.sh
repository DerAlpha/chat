#!/bin/sh
# ---------------------------------------------------------------------------
# Flüsterchat auf klassischen Webspace installieren (lima-city & Co.).
#
# Braucht weder root noch Node - nur eine Shell, curl oder wget, und tar.
# Es wird ausschliesslich innerhalb deines Webspace geschrieben.
#
#   sh install-webspace.sh --archive ~/fluesterchat-webspace.zip
#   sh install-webspace.sh --source ~/entpacktes-paket
#   sh install-webspace.sh                      # laedt von GitHub (oeffentliches Repo)
#
# Weitere Schalter: --docroot ~/html, --url https://…, --data ~/…, --force
#
# Erneut ausführen = aktualisieren. Eine eigene api/lib/config.local.php
# und der Datenordner bleiben dabei unangetastet. Der Installer merkt sich
# Docroot, Datenordner und Adresse in ~/.fluesterchat-install.conf und legt
# ~/fluesterchat-update.sh an - danach genuegt zum Aktualisieren:
#
#   ssh BENUTZER@SERVER 'sh ~/fluesterchat-update.sh'
# ---------------------------------------------------------------------------
set -eu

BRANCH="claude/chat-website-no-signup-qpswkk"
REPO_URL="https://codeload.github.com/DerAlpha/chat/tar.gz/refs/heads/$BRANCH"
INSTALLER_URL="https://raw.githubusercontent.com/DerAlpha/chat/refs/heads/$BRANCH/deploy/install-webspace.sh"
CONF="$HOME/.fluesterchat-install.conf"
UPDATER="$HOME/fluesterchat-update.sh"
DOCROOT=""
SITE_URL=""
DATA_DIR=""
ARCHIVE=""
SOURCE=""
FORCE=0
MARKER=".fluesterchat"

say()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }
die()  { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --docroot) DOCROOT="${2:-}"; shift 2 ;;
        --archive) ARCHIVE="${2:-}"; shift 2 ;;
        --source)  SOURCE="${2:-}"; shift 2 ;;
        --url)     SITE_URL="${2:-}"; shift 2 ;;
        --data)    DATA_DIR="${2:-}"; shift 2 ;;
        --force)   FORCE=1; shift ;;
        # --update ist nur noch Hoeflichkeit: gemerkte Werte gelten ohnehin.
        --update)  shift ;;
        -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "Unbekannte Option: $1" ;;
    esac
done

# --- Was beim letzten Mal galt ----------------------------------------------
# Gesetzte Schalter haben Vorrang; alles andere kommt aus der Merkdatei.
# So ist ein blosses erneutes Ausfuehren schon die Aktualisierung.
if [ -f "$CONF" ]; then
    OLD_DOCROOT=""; OLD_DATA_DIR=""; OLD_SITE_URL=""
    # shellcheck disable=SC1090
    . "$CONF" 2>/dev/null || true
    [ -n "$DOCROOT" ]  || DOCROOT="$OLD_DOCROOT"
    [ -n "$DATA_DIR" ] || DATA_DIR="$OLD_DATA_DIR"
    [ -n "$SITE_URL" ] || SITE_URL="$OLD_SITE_URL"
    KNOWN=1
else
    KNOWN=0
fi

# --- Werkzeuge -------------------------------------------------------------
step "Werkzeuge"
FETCH=""
if [ -z "$SOURCE" ] && [ -z "$ARCHIVE" ]; then
    if command -v curl >/dev/null 2>&1; then
        FETCH="curl -fsSL -o"
    elif command -v wget >/dev/null 2>&1; then
        FETCH="wget -qO"
    else
        die "Weder curl noch wget vorhanden. Dann das Paket hochladen und --archive verwenden."
    fi
    say "Herunterladen mit ${FETCH%% *}"
fi
command -v tar >/dev/null 2>&1 || die "tar fehlt."
say "Entpacken mit tar"

# --- Document Root ---------------------------------------------------------
step "Document Root"
[ "$KNOWN" -eq 1 ] && say "aus $CONF übernommen"

# Zeigt, was im Home liegt - damit man beim Nachbessern nicht raten muss.
list_candidates() {
    printf '\nVerzeichnisse in %s:\n' "$HOME"
    found=0
    for entry in "$HOME"/*/; do
        [ -d "$entry" ] || continue
        found=1
        name=$(basename "$entry")
        if [ -w "$entry" ]; then
            printf '    %-28s (beschreibbar)\n' "$name"
        else
            printf '    %-28s (nur lesbar)\n' "$name"
        fi
    done
    [ "$found" -eq 1 ] || printf '    (keine)\n'
    printf '\nDen richtigen Namen nennt das Panel des Hosters als "Document Root".\n'
    printf 'Dann erneut mit:  --docroot %s/NAME\n' "$HOME"
}

if [ -z "$DOCROOT" ]; then
    # "default-website" ist der Vorgabename bei lima-city.
    for candidate in "$HOME/html" "$HOME/www" "$HOME/public_html" "$HOME/htdocs" \
                     "$HOME/httpdocs" "$HOME/web" "$HOME/webseiten" "$HOME/default-website"; do
        if [ -d "$candidate" ]; then
            if [ -n "$DOCROOT" ]; then
                list_candidates
                die "Mehrere mögliche Verzeichnisse gefunden. Bitte --docroot angeben."
            fi
            DOCROOT="$candidate"
        fi
    done
fi
if [ -z "$DOCROOT" ]; then
    list_candidates
    die "Kein Document Root gefunden."
fi
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

# --- Quelle beschaffen -----------------------------------------------------
step "Quelle"
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t fluesterchat)
trap 'rm -rf "$TMP"' EXIT INT TERM
mkdir -p "$TMP/src"

if [ -n "$SOURCE" ]; then
    [ -d "$SOURCE" ] || die "$SOURCE ist kein Verzeichnis."
    cp -R "$SOURCE/." "$TMP/src/"
    say "aus $SOURCE"
elif [ -n "$ARCHIVE" ]; then
    [ -f "$ARCHIVE" ] || die "$ARCHIVE gibt es nicht."
    case "$ARCHIVE" in
        *.zip)
            command -v unzip >/dev/null 2>&1 || die "unzip fehlt - dann bitte ein .tar.gz nehmen."
            unzip -oq "$ARCHIVE" -d "$TMP/src" || die "ZIP liess sich nicht entpacken."
            ;;
        *.tar.gz|*.tgz)
            tar -xzf "$ARCHIVE" -C "$TMP/src" || die "Archiv liess sich nicht entpacken."
            ;;
        *) die "Unbekanntes Format: $ARCHIVE (erwartet .zip oder .tar.gz)" ;;
    esac
    # Steckt alles in einem einzelnen Unterordner? Dann eine Ebene hoch.
    inner=$(ls -A "$TMP/src" | head -2)
    if [ "$(ls -A "$TMP/src" | wc -l)" = "1" ] && [ -d "$TMP/src/$inner" ]; then
        mv "$TMP/src/$inner" "$TMP/unwrapped" && rm -rf "$TMP/src" && mv "$TMP/unwrapped" "$TMP/src"
    fi
    say "aus $ARCHIVE"
else
    $FETCH "$TMP/app.tar.gz" "$REPO_URL" || die "Download fehlgeschlagen. Ist das Repo öffentlich? Sonst das Paket hochladen und --archive verwenden."
    mkdir -p "$TMP/repo"
    tar -xzf "$TMP/app.tar.gz" -C "$TMP/repo" --strip-components=1 || die "Archiv liess sich nicht entpacken."
    rm -rf "$TMP/src" && mv "$TMP/repo" "$TMP/src"
    say "von GitHub geladen"
fi

# Zwei Formen sind zulässig: das Repo (public/ + php/) oder das fertige Paket.
if [ -d "$TMP/src/public" ] && [ -d "$TMP/src/php/api" ]; then
    LAYOUT="repo"
elif [ -f "$TMP/src/index.html" ] && [ -d "$TMP/src/api" ]; then
    LAYOUT="paket"
else
    die "Die Quelle sieht weder nach Projektverzeichnis noch nach fertigem Paket aus."
fi
say "$(du -sh "$TMP/src" 2>/dev/null | cut -f1), Form: $LAYOUT"

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
if [ "$LAYOUT" = "repo" ]; then
    cp -R "$TMP/src/public/." "$DOCROOT/"
    mkdir -p "$DOCROOT/api"
    cp -R "$TMP/src/php/api/." "$DOCROOT/api/"
    cp "$TMP/src/php/site/.htaccess" "$DOCROOT/.htaccess"
    cp "$TMP/src/php/site/.user.ini" "$DOCROOT/.user.ini"
else
    cp -R "$TMP/src/." "$DOCROOT/"
    rm -f "$DOCROOT/install-webspace.sh"
fi
[ -n "$KEEP_CONFIG" ] && cp "$KEEP_CONFIG" "$DOCROOT/api/lib/config.local.php"

if [ "$DATA_OUTSIDE" -eq 1 ] && [ ! -f "$DOCROOT/api/lib/config.local.php" ]; then
    printf "<?php\nreturn [\n    'dataDir' => '%s',\n];\n" "$DATA_DIR" > "$DOCROOT/api/lib/config.local.php"
    say "Datenpfad in api/lib/config.local.php eingetragen"
fi

date > "$DOCROOT/$MARKER"
chmod 644 "$DOCROOT/.htaccess" "$DOCROOT/.user.ini" 2>/dev/null || true
say "$(find "$DOCROOT" -type f | wc -l | tr -d ' ') Dateien liegen bereit"

# --- Fuers naechste Mal merken ---------------------------------------------
step "Aktualisieren vorbereiten"
# Beim naechsten Mal soll niemand mehr Pfade heraussuchen muessen.
{
    printf '# Von install-webspace.sh angelegt. Wird beim Aktualisieren gelesen.\n'
    printf "OLD_DOCROOT='%s'\n"  "$DOCROOT"
    printf "OLD_DATA_DIR='%s'\n" "$DATA_DIR"
    printf "OLD_SITE_URL='%s'\n" "$SITE_URL"
} > "$CONF"
chmod 600 "$CONF" 2>/dev/null || true
say "$CONF geschrieben"

# Der Aktualisierer holt sich jedes Mal den aktuellen Installer - so wandern
# auch Verbesserungen am Installer selbst mit.
cat > "$UPDATER" <<UPDATER_EOF
#!/bin/sh
# Flüsterchat aktualisieren - angelegt von install-webspace.sh.
#
#   sh ~/fluesterchat-update.sh
#
# Holt die neueste Fassung und legt sie über die vorhandene Installation.
# Docroot und Datenordner stehen in ~/.fluesterchat-install.conf; die eigene
# api/lib/config.local.php und alle gespeicherten Chats bleiben unangetastet.
set -eu
[ -f "\$HOME/.fluesterchat-install.conf" ] || {
    printf 'Keine Installation gefunden (%s fehlt).\n' "\$HOME/.fluesterchat-install.conf" >&2
    exit 1
}
TMP=\$(mktemp -d 2>/dev/null || mktemp -d -t fluesterchat)
trap 'rm -rf "\$TMP"' EXIT INT TERM
if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "\$TMP/install.sh" '$INSTALLER_URL'
elif command -v wget >/dev/null 2>&1; then
    wget -qO "\$TMP/install.sh" '$INSTALLER_URL'
else
    printf 'Weder curl noch wget vorhanden.\n' >&2
    exit 1
fi
[ -s "\$TMP/install.sh" ] || { printf 'Der Installer kam leer an.\n' >&2; exit 1; }
sh "\$TMP/install.sh" --update "\$@"
UPDATER_EOF
chmod 755 "$UPDATER" 2>/dev/null || true
say "$UPDATER angelegt"

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
printf '\nSpäter aktualisieren - ein Befehl, mehr nicht:\n'
printf '    sh ~/fluesterchat-update.sh\n'
printf 'oder vom eigenen Rechner aus, ohne sich anzumelden:\n'
printf "    ssh BENUTZER@SERVER 'sh ~/fluesterchat-update.sh'\n"
printf '%s\n' '---------------------------------------------------------------'
