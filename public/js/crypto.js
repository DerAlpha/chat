/**
 * Ende-zu-Ende-Verschluesselung.
 *
 * Der Einmal-Code ist das gemeinsame Geheimnis. Aus ihm entstehen zwei Dinge:
 *   1. die Raum-ID, die der Server sieht (ein Hash - daraus laesst sich der Code nicht zurueckrechnen),
 *   2. der AES-GCM-Schluessel, der den Server nie erreicht.
 *
 * Der Code steht ausschliesslich im URL-Fragment (#...). Fragmente werden
 * nie an den Server geschickt.
 */

/** Crockford-Base32: ohne I, L, O, U - damit nichts verwechselt wird. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
const GROUP = 4;
const PBKDF2_ITERATIONS = 250_000;
const IV_BYTES = 12;
const ROOM_ID_LENGTH = 22;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const cryptoAvailable = typeof crypto !== 'undefined' && !!crypto.subtle;

/** Erzeugt einen frischen Einmal-Code, z. B. "H7Q2-9XKM-3BTV". */
export function generateCode() {
  const raw = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(raw);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    // Ablehnungsverfahren waere hier unnoetig: 256 ist ein Vielfaches von 32,
    // die Verteilung ueber das Alphabet bleibt also gleichmaessig.
    out += ALPHABET[raw[i] % ALPHABET.length];
  }
  return formatCode(out);
}

/** Macht aus "h7q29xkm3btv" ein sauberes "H7Q2-9XKM-3BTV". */
export function formatCode(code) {
  const clean = normalizeCode(code);
  return clean.match(new RegExp(`.{1,${GROUP}}`, 'g'))?.join('-') ?? clean;
}

/**
 * Raeumt Tippfehler auf: Kleinbuchstaben, Trennzeichen und die klassischen
 * Verwechslungen O/0 sowie I/L/1.
 */
export function normalizeCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .slice(0, CODE_LENGTH);
}

export function isCompleteCode(input) {
  const clean = normalizeCode(input);
  if (clean.length !== CODE_LENGTH) return false;
  return [...clean].every((char) => ALPHABET.includes(char));
}

export const codeLength = CODE_LENGTH;

// --------------------------------------------------------------- Ableitungen

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return new Uint8Array(digest);
}

/** Die einzige Information ueber den Code, die der Server je zu sehen bekommt. */
export async function deriveRoomId(code) {
  const clean = normalizeCode(code);
  const digest = await sha256(`fluesterchat:room:v1:${clean}`);
  return toBase64Url(digest).slice(0, ROOM_ID_LENGTH);
}

/**
 * Leitet den Nachrichtenschluessel ab. PBKDF2 mit 250.000 Runden macht das
 * Durchprobieren der 60 Code-Bits fuer Aussenstehende teuer.
 */
export async function deriveKey(code) {
  const clean = normalizeCode(code);
  const salt = await sha256(`fluesterchat:salt:v1:${clean}`);
  const material = await crypto.subtle.importKey('raw', encoder.encode(clean), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/** Macht aus rohen Schluesselbytes einen benutzbaren AES-GCM-Schluessel. */
export function importKey(rawBytes) {
  return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// ------------------------------------------------------------ Ver-/Entschluesseln

/** Verschluesselt beliebige Bytes zu `iv || ciphertext`. */
export async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return out;
}

/** Gegenstueck zu `encryptBytes`. Wirft, wenn Schluessel oder Daten nicht passen. */
export async function decryptBytes(key, payload) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.length <= IV_BYTES) throw new Error('Chiffrat zu kurz.');
  const iv = bytes.subarray(0, IV_BYTES);
  const cipher = bytes.subarray(IV_BYTES);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new Uint8Array(plain);
}

/** Verschluesselt ein JSON-Objekt und liefert Base64. */
export async function encryptJson(key, value) {
  return toBase64(await encryptBytes(key, encoder.encode(JSON.stringify(value))));
}

/** Entschluesselt Base64 zurueck zu einem JSON-Objekt. */
export async function decryptJson(key, base64) {
  const plain = await decryptBytes(key, fromBase64(base64));
  return JSON.parse(decoder.decode(plain));
}

// ------------------------------------------------------------------- Base64

export function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Kurze, zufaellige ID fuer lokale Zwecke (z. B. optimistische Nachrichten). */
export function randomId(bytes = 9) {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return toBase64Url(raw);
}
