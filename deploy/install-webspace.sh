#!/bin/sh
# ---------------------------------------------------------------------------
# Flüsterchat auf klassischen Webspace installieren (lima-city & Co.).
#
# Braucht weder root noch Node - nur eine Shell, curl oder wget, und tar.
# Es wird ausschliesslich innerhalb deines Webspace geschrieben.
#
#   sh install-webspace.sh --archive ~/fluesterchat-webspace.zip
#   sh install-webspace.sh --source ~/entpacktes-paket
#   sh install-webspace.sh                      # laedt von GitHub
#
# Weitere Schalter: --docroot ~/html, --url https://…, --data ~/…, --force
#
# Erneut ausführen = aktualisieren. Der Installer merkt sich Document Root,
# Datenordner und Adresse in ~/.fluesterchat-install.conf und legt
# ~/fluesterchat-update.sh an - danach genuegt zum Aktualisieren:
#
#   ssh BENUTZER@SERVER 'sh ~/fluesterchat-update.sh'
#
# Angetastet wird ausschliesslich, was beim letzten Mal selbst installiert
# wurde. Gespeicherte Chats, eine eigene api/lib/config.local.php und alles
# Fremde im Verzeichnis bleiben, wo sie sind.
# ---------------------------------------------------------------------------
set -eu

BRANCH="claude/chat-website-no-signup-qpswkk"
REPO_URL="https://codeload.github.com/DerAlpha/chat/tar.gz/refs/heads/$BRANCH"
INSTALLER_URL="https://raw.githubusercontent.com/DerAlpha/chat/refs/heads/$BRANCH/deploy/install-webspace.sh"
CONF="$HOME/.fluesterchat-install.conf"
UPDATER="$HOME/fluesterchat-update.sh"
MARKER=".fluesterchat"
TAB=$(printf '\t')

# Ohne diese Dateien ist die Installation unvollstaendig.
REQUIRED="index.html .htaccess .user.ini api/index.php img/icon.svg js/app.js"

DOCROOT=""
SITE_URL=""
DATA_DIR=""
ARCHIVE=""
SOURCE=""
FORCE=0

say()  { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }
die()  { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }

# Die Hilfe ist der Kommentarblock oben - bis zur naechsten Trennlinie und
# keine Zeile weiter. Die fruehere Fassung zaehlte feste Zeilennummern ab und
# druckte nach einer Erweiterung des Textes den Anfang des Programms mit aus.
usage() {
    awk 'NR <= 2 { next } /^# -{10,}/ { exit } { sub(/^# ?/, ""); print }' "$0"
}

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
        -h|--help) usage; exit 0 ;;
        *) die "Unbekannte Option: $1" ;;
    esac
done

# ---------------------------------------------------------------------------
# Merkdatei
#
# Bewusst kein Shell-Format. Frueher wurde sie mit `.` eingelesen - dann
# entscheidet ein einzelnes Apostroph im Pfad ueber Erfolg oder wortlosen
# Abbruch, und eine verfaelschte Datei kann Variablen des Installers setzen,
# bis hin zu FORCE. Jetzt sind es schlichte, durch Tabulatoren getrennte
# Felder, die niemand interpretiert:
#
#   install<TAB>docroot<TAB>datenordner<TAB>adresse
# ---------------------------------------------------------------------------

conf_entries() {
    [ -f "$CONF" ] || return 0
    grep "^install$TAB" "$CONF" 2>/dev/null || true
}

conf_field() { printf '%s\n' "$1" | cut -d"$TAB" -f"$2"; }

# Ein Pfad mit Tabulator oder Zeilenumbruch sprengt jedes Zeilenformat -
# lieber gleich und deutlich ablehnen als spaeter still danebengreifen.
check_plain() {
    case "$1" in
        *"$TAB"*) die "$2 enthält einen Tabulator - damit kommt der Installer nicht klar." ;;
    esac
    [ "$(printf '%s' "$1" | wc -l | tr -d ' ')" = "0" ] || die "$2 enthält einen Zeilenumbruch."
}

# ---------------------------------------------------------------------------
# Markierung im Docroot
#
# Sie haelt fest, wohin installiert wurde und welche Dateien dabei entstanden
# sind. Der Pfad darin ist wichtig: eine Sicherungskopie des Docroots traegt
# die Markierung mit, nennt darin aber den urspruenglichen Ort. Nur daran ist
# eine Kopie zu erkennen - sonst greift die Suche nach vorhandenen
# Installationen daneben und raeumt die Sicherung ab.
# ---------------------------------------------------------------------------

marker_docroot() { sed -n 's/^docroot=//p' "$1" 2>/dev/null | head -1; }
marker_files()   { sed -n 's/^datei=//p'   "$1" 2>/dev/null; }

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

# Echte Installationen an ihrer Markierung finden - Kopien uebergehen.
find_installed() {
    for entry in "$HOME"/*/ "$HOME"/*/*/; do
        [ -f "$entry$MARKER" ] || continue
        here=${entry%/}
        recorded=$(marker_docroot "$entry$MARKER")
        # Ohne vermerkten Pfad: Markierung aus einer aelteren Fassung, die
        # zaehlt mit. Steht dort ein anderer Pfad, ist es eine Kopie.
        if [ -n "$recorded" ] && [ "$recorded" != "$here" ]; then
            continue
        fi
        printf '%s\n' "$here"
    done
}

if [ -z "$DOCROOT" ]; then
    entries=$(conf_entries)
    count=$(printf '%s' "$entries" | grep -c . || true)
    if [ "$count" = "1" ]; then
        DOCROOT=$(conf_field "$entries" 2)
        [ -n "$DATA_DIR" ] || DATA_DIR=$(conf_field "$entries" 3)
        [ -n "$SITE_URL" ] || SITE_URL=$(conf_field "$entries" 4)
        say "aus $CONF übernommen"
    elif [ "$count" != "0" ]; then
        printf '\nEs sind mehrere Installationen vermerkt:\n'
        printf '%s\n' "$entries" | while IFS= read -r line; do
            [ -n "$line" ] && printf '    %s\n' "$(conf_field "$line" 2)"
        done
        die "Bitte mit --docroot sagen, welche gemeint ist."
    fi
fi

if [ -z "$DOCROOT" ]; then
    installed=$(find_installed)
    count=$(printf '%s' "$installed" | grep -c . || true)
    if [ "$count" = "1" ]; then
        DOCROOT="$installed"
        say "vorhandene Installation gefunden"
    elif [ "$count" != "0" ]; then
        printf '\nEs gibt mehrere Installationen:\n'
        printf '%s\n' "$installed" | sed 's/^/    /'
        die "Bitte mit --docroot sagen, welche gemeint ist."
    fi
fi

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
check_plain "$DOCROOT" "Der Document Root"
say "$DOCROOT"

# Nichts Fremdes überschreiben. Die Markierung allein genuegt dafuer nicht:
# sie ist eine Punktdatei, die beim Leerraeumen per FTP gern stehenbleibt.
# Erst zusammen mit einer erkennbar eigenen Datei heisst sie "das ist unseres".
OURS=0
if [ -f "$DOCROOT/$MARKER" ] && [ -f "$DOCROOT/api/index.php" ]; then
    OURS=1
fi
if [ "$OURS" -eq 0 ] && [ "$FORCE" -eq 0 ]; then
    unexpected=$(ls -A "$DOCROOT" 2>/dev/null | grep -v -E "^(index\.html?|\.ftpquota|\.well-known|cgi-bin|$MARKER)$" || true)
    if [ -n "$unexpected" ]; then
        printf '\nIn %s liegt schon etwas anderes:\n' "$DOCROOT"
        printf '%s\n' "$unexpected" | sed 's/^/    /'
        die "Zur Sicherheit abgebrochen. Mit --force trotzdem installieren (vorhandene Dateien gleichen Namens werden ersetzt)."
    fi
fi

# --- Datenordner -----------------------------------------------------------
step "Datenordner"
if [ -z "$DATA_DIR" ]; then
    parent=$(dirname "$DOCROOT")
    # Nur wenn der Docroot unmittelbar im Home liegt, ist sein Elternordner
    # verlaesslich ausserhalb des Webs. Bei einer Installation im Unterordner
    # einer bestehenden Seite waere er sonst schlicht abrufbar.
    if [ "$parent" = "$HOME" ]; then
        DATA_DIR="$parent/fluesterchat-data"
    else
        DATA_DIR="$HOME/fluesterchat-data"
    fi
    # Eine zweite Installation darf sich den Datenordner nicht mit der ersten
    # teilen - sonst sieht eine Testinstanz die echten Chats und loescht beim
    # Aufraeumen darin mit.
    for line in $(conf_entries | tr ' ' '\001'); do
        line=$(printf '%s' "$line" | tr '\001' ' ')
        [ "$(conf_field "$line" 3)" = "$DATA_DIR" ] || continue
        [ "$(conf_field "$line" 2)" = "$DOCROOT" ] && continue
        DATA_DIR="$DATA_DIR-$(basename "$DOCROOT")"
        say "Datenordner bereits von einer anderen Installation belegt"
        break
    done
fi
check_plain "$DATA_DIR" "Der Datenordner"

DATA_INSIDE=0
case "$DATA_DIR/" in
    "$DOCROOT"/*) DATA_INSIDE=1 ;;
esac

DATA_OUTSIDE=0
if [ "$DATA_INSIDE" -eq 1 ]; then
    warn "$DATA_DIR liegt INNERHALB des Document Roots."
    warn "Dort schützt ihn nur .htaccess - auf Servern ohne AllowOverride ist"
    warn "er von außen abrufbar. Besser --data auf einen Ordner außerhalb setzen."
    mkdir -p "$DATA_DIR" 2>/dev/null || true
elif mkdir -p "$DATA_DIR" 2>/dev/null && [ -w "$DATA_DIR" ]; then
    chmod 770 "$DATA_DIR" 2>/dev/null || true
    say "$DATA_DIR (außerhalb des Docroots - gut)"
    DATA_OUTSIDE=1
else
    say "Neben dem Docroot ist kein Schreiben möglich - die App legt sich später api/data an."
fi

# Riegel sofort vorlegen, nicht erst beim ersten Zugriff der App.
if [ -d "$DATA_DIR" ] && [ -w "$DATA_DIR" ] && [ ! -f "$DATA_DIR/.htaccess" ]; then
    {
        printf '# Von Flüsterchat angelegt: hier liegen verschlüsselte Chats.\n'
        printf 'Require all denied\n'
        printf '<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n'
    } > "$DATA_DIR/.htaccess" 2>/dev/null || true
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

# --- Neuen Stand zusammenstellen -------------------------------------------
# Erst vollstaendig danebenlegen und pruefen, dann anfassen. Ein halb
# heruntergeladenes oder beschnittenes Paket darf eine laufende Installation
# nicht einmal beruehren.
NEW="$TMP/neu"
mkdir -p "$NEW"
if [ "$LAYOUT" = "repo" ]; then
    cp -R "$TMP/src/public/." "$NEW/"
    mkdir -p "$NEW/api"
    cp -R "$TMP/src/php/api/." "$NEW/api/"
    cp "$TMP/src/php/site/.htaccess" "$NEW/.htaccess"
    cp "$TMP/src/php/site/.user.ini" "$NEW/.user.ini"
else
    cp -R "$TMP/src/." "$NEW/"
    rm -f "$NEW/install-webspace.sh"
fi
for needed in $REQUIRED; do
    [ -f "$NEW/$needed" ] || die "In der Quelle fehlt $needed - da stimmt etwas nicht. Es wurde nichts verändert."
done

# Was jetzt ausgeliefert wird - relativ zum Docroot, eine Zeile je Datei.
( cd "$NEW" && find . -type f | sed 's|^\./||' | sort ) > "$TMP/dateien.neu"

# --- Installieren ----------------------------------------------------------
step "Installieren"

# Was beim letzten Mal von uns kam. Ohne diese Liste - etwa bei einer
# Installation aus einer aelteren Fassung - wird nichts geloescht: lieber eine
# verwaiste Datei zu viel als eine fremde zu wenig.
: > "$TMP/dateien.alt"
if [ -f "$DOCROOT/$MARKER" ]; then
    marker_files "$DOCROOT/$MARKER" | sort > "$TMP/dateien.alt"
fi

# Darüberkopieren statt vorher abzuräumen. Das ist der Kern der Sache: frueher
# loeschte der Installer api/ vollstaendig und traf damit api/data - dort legt
# die App alle Chats ab, wenn neben dem Docroot nicht geschrieben werden darf.
# Der Aktualisierer versprach im selben Atemzug das Gegenteil.
cp -R "$NEW/." "$DOCROOT/"

# Verwaistes aus der letzten Fassung entfernen - ausschliesslich Dateien, die
# nachweislich von uns stammen und heute nicht mehr dazugehoeren.
if [ -s "$TMP/dateien.alt" ]; then
    entfernt=0
    while IFS= read -r rel; do
        [ -n "$rel" ] || continue
        grep -qxF "$rel" "$TMP/dateien.neu" && continue
        if [ -f "$DOCROOT/$rel" ]; then
            rm -f "$DOCROOT/$rel"
            entfernt=$((entfernt + 1))
        fi
    done < "$TMP/dateien.alt"
    [ "$entfernt" -eq 0 ] || say "$entfernt Datei(en) aus der alten Fassung entfernt"
    # Leergewordene eigene Ordner aufräumen, die tiefsten zuerst.
    for dir in css js img api/lib api; do
        if [ -d "$DOCROOT/$dir" ]; then
            rmdir "$DOCROOT/$dir" 2>/dev/null || true
        fi
    done
fi

if [ "$DATA_OUTSIDE" -eq 1 ] && [ ! -f "$DOCROOT/api/lib/config.local.php" ]; then
    printf "<?php\nreturn [\n    'dataDir' => '%s',\n];\n" "$DATA_DIR" > "$DOCROOT/api/lib/config.local.php"
    say "Datenpfad in api/lib/config.local.php eingetragen"
fi

{
    printf '# Von install-webspace.sh angelegt. Nicht von Hand ändern.\n'
    printf 'docroot=%s\n' "$DOCROOT"
    printf 'zeit=%s\n' "$(date)"
    sed 's/^/datei=/' "$TMP/dateien.neu"
} > "$DOCROOT/$MARKER"

chmod 644 "$DOCROOT/.htaccess" "$DOCROOT/.user.ini" 2>/dev/null || true
say "$(wc -l < "$TMP/dateien.neu" | tr -d ' ') Dateien liegen bereit"

# --- Nachsehen -------------------------------------------------------------
step "Kurze Kontrolle"
for needed in $REQUIRED; do
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

# --- Fuers naechste Mal merken ---------------------------------------------
# Ab hier ist die Installation fertig und benutzbar. Was jetzt noch schiefgeht,
# darf den Lauf nicht als gescheitert dastehen lassen - sonst greift jemand in
# eine intakte Seite ein.
step "Aktualisieren vorbereiten"
UPDATER_OK=0
OTHERS=$(conf_entries)
if {
    printf '# Von install-webspace.sh angelegt. Ein Eintrag je Installation:\n'
    printf '# install<TAB>docroot<TAB>datenordner<TAB>adresse\n'
    printf '%s\n' "$OTHERS" | while IFS= read -r line; do
        [ -n "$line" ] || continue
        [ "$(conf_field "$line" 2)" = "$DOCROOT" ] || printf '%s\n' "$line"
    done
    printf 'install%s%s%s%s%s%s\n' "$TAB" "$DOCROOT" "$TAB" "$DATA_DIR" "$TAB" "$SITE_URL"
} > "$CONF.neu" 2>/dev/null && mv "$CONF.neu" "$CONF" 2>/dev/null; then
    chmod 600 "$CONF" 2>/dev/null || true
    say "$CONF geschrieben"
    UPDATER_OK=1
else
    rm -f "$CONF.neu" 2>/dev/null || true
    warn "$CONF liess sich nicht schreiben (Home nicht beschreibbar?)."
    warn "Die Installation ist trotzdem in Ordnung - zum Aktualisieren"
    warn "einfach denselben Befehl noch einmal ausführen."
fi

# Der Aktualisierer holt sich jedes Mal den aktuellen Installer - so wandern
# auch Verbesserungen am Installer selbst mit. Er arbeitet alle vermerkten
# Installationen ab, damit eine zweite Instanz die erste nicht verdraengt.
if [ "$UPDATER_OK" -eq 1 ]; then
    if cat > "$UPDATER.neu" <<UPDATER_EOF
#!/bin/sh
# Flüsterchat aktualisieren - angelegt von install-webspace.sh.
#
#   sh ~/fluesterchat-update.sh
#
# Holt die neueste Fassung und legt sie über jede vermerkte Installation.
# Angetastet wird nur, was beim letzten Mal selbst installiert wurde: die
# eigene api/lib/config.local.php und alle gespeicherten Chats bleiben.
set -eu
CONF="\$HOME/.fluesterchat-install.conf"
[ -f "\$CONF" ] || {
    printf 'Keine Installation gefunden (%s fehlt).\n' "\$CONF" >&2
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
# Eine Fehlerseite mit Rueckgabewert 200 ist noch lange kein Installer.
head -1 "\$TMP/install.sh" | grep -q '^#!/bin/sh' || {
    printf 'Der geladene Installer sieht nicht wie ein Shell-Skript aus.\n' >&2
    exit 1
}
TAB=\$(printf '\t')
grep "^install\$TAB" "\$CONF" > "\$TMP/liste" || {
    printf 'In %s steht keine Installation.\n' "\$CONF" >&2
    exit 1
}
FEHLER=0
while IFS= read -r zeile; do
    [ -n "\$zeile" ] || continue
    ziel=\$(printf '%s\n' "\$zeile" | cut -d"\$TAB" -f2)
    daten=\$(printf '%s\n' "\$zeile" | cut -d"\$TAB" -f3)
    adresse=\$(printf '%s\n' "\$zeile" | cut -d"\$TAB" -f4)
    if [ ! -d "\$ziel" ]; then
        printf '\nÜbersprungen (gibt es nicht mehr): %s\n' "\$ziel" >&2
        continue
    fi
    sh "\$TMP/install.sh" --update --docroot "\$ziel" --data "\$daten" --url "\$adresse" "\$@" || FEHLER=1
done < "\$TMP/liste"
exit \$FEHLER
UPDATER_EOF
    then
        mv "$UPDATER.neu" "$UPDATER" 2>/dev/null || true
        chmod 755 "$UPDATER" 2>/dev/null || true
        say "$UPDATER angelegt"
    else
        rm -f "$UPDATER.neu" 2>/dev/null || true
        warn "$UPDATER liess sich nicht anlegen."
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
if [ "$UPDATER_OK" -eq 1 ]; then
    printf '\nSpäter aktualisieren - ein Befehl, mehr nicht:\n'
    printf '    sh ~/fluesterchat-update.sh\n'
    printf 'oder vom eigenen Rechner aus, ohne sich anzumelden:\n'
    printf "    ssh BENUTZER@SERVER 'sh ~/fluesterchat-update.sh'\n"
fi
printf '%s\n' '---------------------------------------------------------------'
