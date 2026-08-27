/**
 * Was dieses Geraet sich merkt: die eigenen Chats (Code, Schluessel, Token)
 * und ein paar Einstellungen. Alles bleibt lokal - der Server bekommt davon
 * nur die Raum-ID und das Token zu sehen.
 */

const SESSIONS_KEY = 'fc:sessions:v1';
const PREFS_KEY = 'fc:prefs:v1';

const DEFAULT_PREFS = {
  lang: null,
  theme: 'auto',
  sound: true,
  notifications: false,
  /** Zuletzt als Reaktion benutzte Emoji, neuestes zuerst. */
  recentEmoji: [],
  /** Anrufe nur über den Relaisdienst leiten - verbirgt die eigene Adresse. */
  hideIp: false,
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
