/**
 * Ende-zu-Ende-Verschluesselung.
 *
 * Der Einmal-Code ist das gemeinsame Geheimnis. Aus ihm entstehen zwei Dinge:
 *   1. die Raum-ID, die der Server sieht,
 *   2. der AES-GCM-Schluessel, der den Server nie erreicht.
 *
 * Beide stammen aus EINER teuren PBKDF2-Ableitung. Das ist wichtig: waere die
 * Raum-ID ein billiger Ein-Runden-Hash desselben Codes, koennte jemand mit
 * Kenntnis der Raum-ID den 60-Bit-Coderaum guenstig durchprobieren und danach
 * einmalig den Schluessel ableiten - die 250.000 Runden waeren wertlos. So
 * kostet jeder einzelne Rateversuch den vollen PBKDF2-Aufwand.
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
/** 32 Byte Schluessel + 16 Byte Raum-ID; 16 Byte ergeben in base64url genau 22 Zeichen. */
const DERIVED_BITS = 384;
const KEY_BYTES = 32;
const ROOM_ID_BYTES = 16;

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

/**
 * Leitet Raum-ID und Nachrichtenschluessel in einem Zug ab.
 *
 * Beides kommt aus demselben PBKDF2-Lauf mit 250.000 Runden. Wer nur die
 * Raum-ID kennt, muss fuer jeden Rateversuch dieselbe teure Ableitung rechnen.
 *
 * @param {string} code
 * @returns {Promise<{roomId: string, keyRaw: Uint8Array}>}
 */
export async function deriveSecrets(code) {
  const clean = normalizeCode(code);
  const salt = await sha256(`fluesterchat:salt:v2:${clean}`);
  const material = await crypto.subtle.importKey('raw', encoder.encode(clean), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    DERIVED_BITS,
  ));
  return {
    keyRaw: bits.slice(0, KEY_BYTES),
    roomId: toBase64Url(bits.slice(KEY_BYTES, KEY_BYTES + ROOM_ID_BYTES)),
  };
}

/**
 * Dasselbe fuer einen Gruppen-Code - nur mit anderem Ziel.
 *
 * Bei einem Zweierchat IST der Code der Raum: aus ihm entstehen Raum-ID und
 * Schluessel, und beide Seiten rechnen dasselbe aus. In einer Gruppe geht das
 * nicht. Dort hat jede Person ihren eigenen Code, und alle sollen trotzdem
 * denselben Schluessel benutzen. Also zeigt ein Gruppen-Code nicht auf einen
 * Raum, sondern auf einen PLATZ: dort liegt der gemeinsame Gruppenschluessel,
 * verpackt mit einem Schluessel, den nur dieser eine Code hergibt.
 *
 * Der Server sieht den Platz und ein Paket, das er nicht oeffnen kann. Wer
 * den Code hat, kann es oeffnen - genau einmal, danach ist der Platz weg.
 *
 * Eigener Salz-Text, damit aus demselben Code niemals derselbe Wert
 * herauskommt wie bei einem Zweierchat: die beiden Welten sollen sich nicht
 * ins Gehege kommen.
 *
 * @param {string} code
 * @returns {Promise<{slotId: string, wrapKeyRaw: Uint8Array}>}
 */
export async function deriveSlot(code) {
  const clean = normalizeCode(code);
  const salt = await sha256(`fluesterchat:slot:v1:${clean}`);
  const material = await crypto.subtle.importKey('raw', encoder.encode(clean), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    DERIVED_BITS,
  ));
  return {
    wrapKeyRaw: bits.slice(0, KEY_BYTES),
    slotId: toBase64Url(bits.slice(KEY_BYTES, KEY_BYTES + ROOM_ID_BYTES)),
  };
}

/**
 * Eine gewuerfelte Raum-ID.
 *
 * Bei einem Zweierchat faellt die Raum-ID aus dem Code heraus - beide Seiten
 * rechnen dieselbe aus. In einer Gruppe gibt es keinen gemeinsamen Code, aus
 * dem sich das ableiten liesse: jede Person hat einen eigenen. Also wuerfelt
 * der Anleger den Raum und legt ihn allen anderen ins Platzpaket.
 */
export function randomRoomId() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(ROOM_ID_BYTES)));
}

/**
 * Ein frischer Gruppenschluessel.
 *
 * Bewusst gewuerfelt und nicht aus irgendeinem Code abgeleitet: kein
 * einzelner Code darf den Schluessel der ganzen Gruppe hergeben. Wer einen
 * Code abfaengt, bekommt einen Platz - nicht die Gruppe.
 */
export function generateGroupKey() {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/**
 * Verpackt den Gruppenschluessel fuer genau einen Platz.
 *
 * Mit verpackt wird, wozu er gehoert: Raum und Name. So kann ein
 * untergeschobener Server niemanden in einen fremden Raum lotsen - der
 * Client vergleicht, was er auspackt, mit dem, was ihm der Server sagt.
 *
 * @param {Uint8Array} wrapKeyRaw Aus dem Code des Teilnehmers.
 * @param {{key: Uint8Array, roomId: string, name: string}} inhalt
 */
export async function wrapGroupKey(wrapKeyRaw, { key, roomId, name }) {
  const wrapper = await importKey(wrapKeyRaw);
  return encryptJson(wrapper, { k: toBase64(key), r: roomId, n: name ?? '' });
}

/**
 * Packt wieder aus. Gibt `null` zurueck, wenn das Paket nicht zu diesem Code
 * gehoert - dann stimmt etwas nicht, und niemand sollte weitermachen.
 *
 * @returns {Promise<{key: Uint8Array, roomId: string, name: string}|null>}
 */
export async function unwrapGroupKey(wrapKeyRaw, packet) {
  try {
    const wrapper = await importKey(wrapKeyRaw);
    const inhalt = await decryptJson(wrapper, packet);
    const key = fromBase64(String(inhalt?.k ?? ''));
    if (key.length !== KEY_BYTES || typeof inhalt?.r !== 'string' || !inhalt.r) return null;
    return { key, roomId: inhalt.r, name: typeof inhalt.n === 'string' ? inhalt.n : '' };
  } catch {
    return null;
  }
}

/**
 * Nur die Raum-ID. Kostet genauso viel wie `deriveSecrets` - wer beides
 * braucht, ruft besser einmal `deriveSecrets` auf.
 */
export async function deriveRoomId(code) {
  return (await deriveSecrets(code)).roomId;
}

/** Nur die Schluesselbytes. Gleiche Kosten wie `deriveSecrets`. */
export async function deriveKey(code) {
  return (await deriveSecrets(code)).keyRaw;
}

/**
 * Der Schluessel hinter einer selbst gewaehlten Zeichenfolge.
 *
 * Gebraucht fuers Verstecken eines Chats: die Zeichenfolge waehlt der Nutzer,
 * sie ist also viel schwaecher als ein Einmal-Code. Deshalb dieselben 250.000
 * Runden - und ein ZUFAELLIGES Salz je Chat, nicht eines aus der Zeichenfolge.
 * Sonst ergaebe dieselbe Zeichenfolge ueberall denselben Schluessel, und wer
 * einen Versteck-Block knackt, haette alle anderen gleich mit.
 *
 * Weil das Salz zufaellig ist, muss beim Suchen jeder Block einzeln probiert
 * werden. Das ist gewollt: es gibt keinen billigen Index, an dem sich ablesen
 * liesse, wie viele Verstecke dieselbe Zeichenfolge tragen.
 *
 * @param {string} zeichenfolge
 * @param {Uint8Array} salz
 */
export async function deriveHideKey(zeichenfolge, salz) {
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(zeichenfolge), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salz, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    KEY_BYTES * 8,
  ));
  return importKey(bits);
}

/** Frisches Salz fuer ein Versteck. */
export function randomSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
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
