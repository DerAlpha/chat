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
  port: int('PORT', 3000),
  trustProxy: bool('TRUST_PROXY', false),

  // Ein Raum verschwindet, wenn er so lange nicht benutzt wurde.
  roomIdleTtlMs: int('ROOM_IDLE_TTL_HOURS', 24 * 7) * HOUR,
  // Ein Code, dem nie jemand beigetreten ist, verfaellt frueher.
  unclaimedRoomTtlMs: int('UNCLAIMED_ROOM_TTL_HOURS', 24) * HOUR,
  cleanupIntervalMs: int('CLEANUP_INTERVAL_MINUTES', 5) * MINUTE,

  maxMembersPerRoom: 2,
  // Wie viele Nachrichten beim Verbinden sofort mitkommen; aeltere holt der Client nach.
  welcomeHistory: int('WELCOME_HISTORY', 300),
  maxMessagesPerRoom: int('MAX_MESSAGES_PER_ROOM', 5000),
  // Groesse eines verschluesselten Nachrichtentextes (Base64) in Bytes.
  maxCiphertextBytes: int('MAX_CIPHERTEXT_BYTES', 64 * 1024),
  // Groesse eines einzelnen verschluesselten Anhangs in Bytes.
  maxBlobBytes: int('MAX_BLOB_BYTES', 12 * 1024 * 1024),
  maxRoomBlobBytes: int('MAX_ROOM_BLOB_BYTES', 150 * 1024 * 1024),
  maxSocketsPerMember: int('MAX_SOCKETS_PER_MEMBER', 4),

  // Rate-Limits
  createRoomPerHour: int('CREATE_ROOM_PER_HOUR', 60),
  joinAttemptsPerHour: int('JOIN_ATTEMPTS_PER_HOUR', 300),
  uploadsPerHour: int('UPLOADS_PER_HOUR', 400),
  messagesPerMinute: int('MESSAGES_PER_MINUTE', 240),

  heartbeatIntervalMs: 25 * 1000,
  persistDebounceMs: int('PERSIST_DEBOUNCE_MS', 1500),

  logLevel: process.env.LOG_LEVEL || 'info',
};

export const durations = { MINUTE, HOUR, DAY };
