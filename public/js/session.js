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

/** @returns {Array<object>} Alle bekannten Chats, zuletzt benutzte zuerst. */
export function listSessions() {
  const sessions = readJson(SESSIONS_KEY, []);
  if (!Array.isArray(sessions)) return [];
  return sessions
    .filter((entry) => entry && typeof entry.roomId === 'string' && typeof entry.code === 'string')
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
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
