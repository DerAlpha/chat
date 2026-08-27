/**
 * Die zweite Schicht über einem Anruf.
 *
 * WebRTC verschlüsselt Ton und Bild bereits selbst (DTLS-SRTP). Der Schlüssel
 * dafür entsteht beim Handschlag zwischen den beiden Geräten - und weil die
 * Aushandlung darüber verschlüsselt über den Server läuft, kann sich der
 * Server dort nicht dazwischenschieben.
 *
 * Bleibt ein Rest: der Handschlag selbst. Wer es schaffte, ihn zu brechen -
 * heute nicht, aber "heute nicht" ist bei einer Aufzeichnung kein starkes
 * Argument -, käme an den Inhalt. Deshalb wird hier jedes einzelne Bild und
 * jedes Tonpaket noch einmal verschlüsselt, mit einem Schlüssel, der aus dem
 * Code des Chats entsteht. Diesen Code hat der Server nie gesehen.
 *
 * Das Format eines Pakets nach der Behandlung:
 *
 *   [Kopf im Klartext][Geheimtext + Prüfsumme][Zufallszahl 12 B][Kopflänge 1 B]
 *
 * Der Kopf bleibt lesbar, weil der Browser ihn braucht, um das Bild in
 * RTP-Pakete zu zerlegen - bei VP8 sind das drei Bytes, bei einem
 * Schlüsselbild zehn, bei Ton eines. Verschwiegen wird damit nichts: dort
 * steht nur, wie gross das Bild ist und ob es ein Schlüsselbild war. Der Kopf
 * geht als "zusätzliche Daten" in die Prüfsumme ein - wer ihn verändert,
 * fliegt beim Entschlüsseln auf.
 */

/** So viele Bytes bleiben vorn im Klartext, je nach Art des Pakets. */
export const CLEAR_HEADER = { key: 10, delta: 3, audio: 1 };

/** AES-GCM: 12 Byte Zufall je Paket, 16 Byte Prüfsumme. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Kürzer als das kann kein behandeltes Paket sein. */
export const MIN_SEALED = IV_BYTES + TAG_BYTES + 1;

/**
 * Leitet den Schlüssel für genau diesen Anruf ab.
 *
 * Aus dem Chatschlüssel, nicht der Chatschlüssel selbst: ein zweiter Zweck
 * bekommt einen zweiten Schlüssel. Und die Kennung des Anrufs geht mit ein,
 * damit zwei Anrufe im selben Chat nicht denselben Schlüssel benutzen.
 *
 * @param {Uint8Array} roomKeyBytes Die rohen Bytes des Chatschlüssels.
 * @param {string} callId Kennung dieses Anrufs.
 */
export async function deriveMediaKey(roomKeyBytes, callId) {
  const base = await crypto.subtle.importKey('raw', roomKeyBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('fluesterchat-call-media'),
      info: new TextEncoder().encode(callId),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Wie viele Bytes vorn im Klartext bleiben müssen. */
export function headerLength(kind, type) {
  if (kind === 'audio') return CLEAR_HEADER.audio;
  return type === 'key' ? CLEAR_HEADER.key : CLEAR_HEADER.delta;
}

/**
 * Verschlüsselt ein Paket und hängt Zufallszahl und Kopflänge hinten an.
 *
 * @param {CryptoKey} key
 * @param {ArrayBuffer|Uint8Array} data Das ganze Paket, Kopf inklusive.
 * @param {number} clear Wie viele Bytes vorn unverschlüsselt bleiben.
 * @returns {Promise<ArrayBuffer>}
 */
export async function seal(key, data, clear) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  // Ein sehr kurzes Paket hat keinen Rumpf, den man verschlüsseln könnte.
  const head = Math.min(clear, bytes.length);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const header = bytes.subarray(0, head);
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: header },
    key,
    bytes.subarray(head),
  ));

  const out = new Uint8Array(head + cipher.length + IV_BYTES + 1);
  out.set(header, 0);
  out.set(cipher, head);
  out.set(iv, head + cipher.length);
  out[out.length - 1] = head;
  return out.buffer;
}

/**
 * Macht `seal` rückgängig. Gibt `null` zurück, wenn das Paket nicht passt -
 * dann wird es verworfen, statt Müll an den Decoder zu geben.
 *
 * @param {CryptoKey} key
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function open(key, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < MIN_SEALED) return null;
  const head = bytes[bytes.length - 1];
  const cipherEnd = bytes.length - IV_BYTES - 1;
  // Behauptet ein Paket einen Kopf, der gar nicht hineinpasst, ist es kaputt.
  // Am Entschlüsseln scheiterte es ohnehin - aber ohne Rechenarbeit ist es
  // billiger, und die Absichten des Formats stehen so schwarz auf weiss da.
  if (head > cipherEnd - TAG_BYTES) return null;

  const header = bytes.subarray(0, head);
  const iv = bytes.subarray(cipherEnd, bytes.length - 1);
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: header },
      key,
      bytes.subarray(head, cipherEnd),
    ));
  } catch {
    // Falscher Schlüssel oder unterwegs verändert - beides heisst: weg damit.
    return null;
  }

  const out = new Uint8Array(head + plain.length);
  out.set(header, 0);
  out.set(plain, head);
  return out.buffer;
}
