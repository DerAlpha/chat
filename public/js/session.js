/**
 * Was dieses Geraet sich merkt: die eigenen Chats (Code, Schluessel, Token)
 * und ein paar Einstellungen. Alles bleibt lokal - der Server bekommt davon
 * nur die Raum-ID und das Token zu sehen.
 */

/**
 * Alles, was diese App im Speicher des Geraets ablegt, faengt damit an.
 *
 * Wichtig fuers Loeschen: die App wohnt womoeglich unter einem Unterpfad
 * einer Domain, auf der noch ganz andere Seiten liegen. Ein pauschales
 * localStorage.clear() wuerde deren Daten gleich mit wegraeumen. Deshalb wird
 * nur weggeworfen, was dieses Praefix traegt.
 */
const KEY_PREFIX = 'fc:';
const SESSIONS_KEY = `${KEY_PREFIX}sessions:v1`;
const PREFS_KEY = `${KEY_PREFIX}prefs:v1`;

const DEFAULT_PREFS = {
  lang: null,
  /** Ein paar Zeilen ueber sich - gehen verschluesselt in jeden Chat mit. */
  bio: '',
  theme: 'auto',
  sound: true,
  notifications: false,
  /** Zuletzt als Reaktion benutzte Emoji, neuestes zuerst. */
  recentEmoji: [],
  /** Anrufe nur über den Relaisdienst leiten - verbirgt die eigene Adresse. */
  hideIp: false,
  /**
   * Die Fassung, die beim letzten Besuch lief.
   *
   * Ist sie gesetzt und stimmt nicht mehr, hat es zwischendurch eine
   * Aktualisierung gegeben - dann geht die Liste der Änderungen von selbst
   * auf. Beim allerersten Besuch bleibt sie zu; wer die App gerade erst
   * gefunden hat, will keine Chronik lesen.
   */
  seenVersion: null,
  /** Zeitstempel des neuesten Eintrags, den man schon gesehen hat. */
  seenChangelog: null,
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Privater Modus oder voller Speicher: die App laeuft weiter, merkt sich aber nichts.
    return false;
  }
}

export const storageAvailable = (() => {
  try {
    const probe = '__fc_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
})();

// ------------------------------------------------------------------- Chats

/** Der juengere der beiden Zeitpunkte: eigener Besuch oder letzte Nachricht. */
const zuletzt = (session) => Math.max(session?.lastActivity ?? 0, session?.lastMessageAt ?? 0);

/** @returns {Array<object>} Alle bekannten Chats, zuletzt benutzte zuerst. */
export function listSessions() {
  const sessions = readJson(SESSIONS_KEY, []);
  if (!Array.isArray(sessions)) return [];
  return sessions
    .filter((entry) => entry && typeof entry.roomId === 'string' && typeof entry.code === 'string')
    // Nach oben kommt, wo zuletzt etwas los war - eigener Besuch ODER eine
    // eingegangene Nachricht. Nur nach dem Besuch zu sortieren hiesse: ein
    // Chat mit drei neuen Nachrichten bleibt unten, weil man laenger nicht
    // hineingesehen hat.
    .sort((a, b) => zuletzt(b) - zuletzt(a));
}

export function getSession(roomId) {
  return listSessions().find((entry) => entry.roomId === roomId) ?? null;
}

/** Legt einen Chat an oder aktualisiert ihn. */
export function saveSession(session) {
  const sessions = listSessions().filter((entry) => entry.roomId !== session.roomId);
  sessions.unshift({ ...session, lastActivity: session.lastActivity ?? Date.now() });
  writeJson(SESSIONS_KEY, sessions.slice(0, 50));
  return session;
}

export function patchSession(roomId, patch) {
  const existing = getSession(roomId);
  if (!existing) return null;
  const merged = { ...existing, ...patch };
  saveSession(merged);
  return merged;
}

/**
 * Mehrere Chats in einem Zug aendern.
 *
 * Die Uebersicht auf der Startseite bekommt alle paar Sekunden neue Zahlen
 * fuer alle Chats auf einmal. Jeden einzeln zu speichern hiesse: bei zehn
 * Chats zehnmal die ganze Liste lesen und zehnmal die ganze Liste schreiben -
 * und das im Sekundentakt, waehrend jemand scrollt.
 *
 * @param {Map<string, object>|Record<string, object>} patches
 * @returns {boolean} ob sich ueberhaupt etwas geaendert hat
 */
export function patchSessions(patches) {
  const eintraege = patches instanceof Map ? patches : new Map(Object.entries(patches));
  if (eintraege.size === 0) return false;
  const sessions = listSessions();
  let geaendert = false;
  const neu = sessions.map((session) => {
    const patch = eintraege.get(session.roomId);
    if (!patch) return session;
    const zusammen = { ...session, ...patch };
    if (Object.keys(patch).every((schluessel) => session[schluessel] === patch[schluessel])) return session;
    geaendert = true;
    return zusammen;
  });
  if (geaendert) writeJson(SESSIONS_KEY, neu);
  return geaendert;
}

/**
 * Wirft alles weg, was diese App gespeichert hat - und nichts sonst.
 *
 * @returns {number} wie viele Eintraege entfernt wurden
 */
export function wipeStorage() {
  try {
    const unsere = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const schluessel = localStorage.key(i);
      if (schluessel?.startsWith(KEY_PREFIX)) unsere.push(schluessel);
    }
    for (const schluessel of unsere) localStorage.removeItem(schluessel);
    return unsere.length;
  } catch {
    // Kein Speicher, nichts zu loeschen.
    return 0;
  }
}

export function removeSession(roomId) {
  writeJson(SESSIONS_KEY, listSessions().filter((entry) => entry.roomId !== roomId));
}

// -------------------------------------------------------------- Einstellungen

export function getPrefs() {
  return { ...DEFAULT_PREFS, ...readJson(PREFS_KEY, {}) };
}

export function setPrefs(patch) {
  const merged = { ...getPrefs(), ...patch };
  writeJson(PREFS_KEY, merged);
  return merged;
}
