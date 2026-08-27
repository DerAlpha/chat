import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..');

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Ungueltiger Wert fuer ${name}: ${raw}`);
  }
  return value;
}

/**
 * Unterpfad, unter dem die App haengt: '' fuer die Wurzel, sonst z. B. '/chats'
 * (mit fuehrendem, ohne abschliessenden Schraegstrich).
 */
function basePath(name) {
  const raw = (process.env[name] ?? '').trim();
  if (!raw || raw === '/') return '';
  const segments = raw.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  const valid = segments.every(
    (segment) => /^[A-Za-z0-9._~-]+$/.test(segment) && segment !== '.' && segment !== '..',
  );
  if (!valid) throw new Error(`Ungueltiger Wert fuer ${name}: ${raw}`);
  return `/${segments.join('/')}`;
}

/** Kommagetrennte Liste aus der Umgebung, Leerraum wird weggeworfen. */
function list(name, fallback) {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const config = {
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, 'data'),

  host: process.env.HOST || '0.0.0.0',
  // Hinter einem Reverse Proxy, der NICHT abschneidet: BASE_PATH=/chats
  basePath: basePath('BASE_PATH'),
  port: int('PORT', 3000),
  trustProxy: bool('TRUST_PROXY', false),

  // Ein Raum verschwindet, wenn er so lange nicht benutzt wurde.
  roomIdleTtlMs: int('ROOM_IDLE_TTL_HOURS', 24 * 7) * HOUR,
  // Ein Code, dem nie jemand beigetreten ist, verfaellt frueher.
  unclaimedRoomTtlMs: int('UNCLAIMED_ROOM_TTL_HOURS', 24) * HOUR,
  cleanupIntervalMs: int('CLEANUP_INTERVAL_MINUTES', 5) * MINUTE,

  /** Ein Zweierchat: der Code verbindet genau zwei Geraete. */
  maxMembersPerRoom: 2,
  /** So gross darf eine Gruppe hoechstens werden - einschliesslich der Person, die sie anlegt. */
  maxRoomCapacity: int('MAX_ROOM_CAPACITY', 16),
  /** Obergrenze fuer ein verpacktes Platzpaket (Base64 des Gruppenschluessels samt Raum und Name). */
  maxWrappedKeyChars: int('MAX_WRAPPED_KEY_CHARS', 1024),
  // Wie viele Nachrichten beim Verbinden sofort mitkommen; aeltere holt der Client nach.
  welcomeHistory: int('WELCOME_HISTORY', 300),
  maxMessagesPerRoom: int('MAX_MESSAGES_PER_ROOM', 5000),
  // Groesse eines verschluesselten Nachrichtentextes (Base64) in Bytes.
  maxCiphertextBytes: int('MAX_CIPHERTEXT_BYTES', 64 * 1024),
  // Groesse eines einzelnen verschluesselten Anhangs in Bytes.
  maxBlobBytes: int('MAX_BLOB_BYTES', 12 * 1024 * 1024),
  maxRoomBlobBytes: int('MAX_ROOM_BLOB_BYTES', 150 * 1024 * 1024),
  // Ein Profilbild ist klein und quadratisch - 128 KB reichen dafuer mit
  // Abstand. Die Grenze haelt auch fest, wie viel Platz eine grosse Gruppe
  // hoechstens fuer Bilder braucht.
  maxAvatarBytes: int('MAX_AVATAR_BYTES', 128 * 1024),
  maxSocketsPerMember: int('MAX_SOCKETS_PER_MEMBER', 4),

  // Rate-Limits
  createRoomPerHour: int('CREATE_ROOM_PER_HOUR', 60),
  joinAttemptsPerHour: int('JOIN_ATTEMPTS_PER_HOUR', 300),
  // Die Uebersicht fragt alle paar Sekunden nach - sie darf das
  // Beitritts-Kontingent nicht aufbrauchen. Sonst kaeme jemand mit
  // offener App irgendwann in keinen Chat mehr hinein.
  overviewPerHour: int('OVERVIEW_PER_HOUR', 5000),
  uploadsPerHour: int('UPLOADS_PER_HOUR', 400),
  messagesPerMinute: int('MESSAGES_PER_MINUTE', 240),

  // --- Anrufe -------------------------------------------------------------
  // Adressen der Aushandlungs- und Relaisdienste. Mehrere durch Komma trennen.
  // Ohne Relais gehen Anrufe nur, wenn sich beide Geräte direkt finden.
  stunUrls: list('STUN_URLS', []),
  turnUrls: list('TURN_URLS', []),
  /** Gemeinsames Geheimnis mit dem Relaisdienst (siehe turn/index.js). */
  turnSecret: process.env.TURN_SECRET || '',
  turnRealm: process.env.TURN_REALM || 'fluesterchat',
  /** So lange gelten ausgegebene Zugangsdaten für den Relaisdienst. */
  turnTtlSeconds: int('TURN_TTL_SECONDS', 2 * 60 * 60),

  // --- GIF-Suche ----------------------------------------------------------
  // Ohne Schlüssel bleibt die Suche unsichtbar statt kaputt. Er bleibt hier
  // auf dem Server: Anfragen laufen über dieses Backend, damit Giphy weder
  // die IP-Adresse noch das Gerät der Nutzer zu sehen bekommt.
  giphyKey: process.env.GIPHY_KEY || '',
  giphyRating: process.env.GIPHY_RATING || 'pg-13',
  gifSearchesPerHour: int('GIF_SEARCHES_PER_HOUR', 300),

  heartbeatIntervalMs: 25 * 1000,
  persistDebounceMs: int('PERSIST_DEBOUNCE_MS', 1500),

  logLevel: process.env.LOG_LEVEL || 'info',
};

export const durations = { MINUTE, HOUR, DAY };
