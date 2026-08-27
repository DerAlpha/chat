/**
 * STUN/TURN-Nachrichten lesen und schreiben (RFC 5389 und RFC 5766).
 *
 * Bewusst ohne Fremdbibliothek: dieser Dienst reicht die Medienströme fremder
 * Leute weiter. Was hier läuft, soll vollständig nachlesbar sein - und nicht
 * mit dem nächsten Abhängigkeits-Update zu etwas anderem werden.
 *
 * Aufbau einer Nachricht:
 *
 *   0                   1                   2                   3
 *   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |0 0|     Typ (14 Bit)          |         Länge (16 Bit)        |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |                    Magische Zahl 0x2112A442                   |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |                Vorgangsnummer (96 Bit)                        |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *
 * Danach Attribute als Typ-Länge-Wert, jeweils auf vier Byte aufgefüllt.
 */
import crypto from 'node:crypto';

export const MAGIC_COOKIE = 0x2112a442;
export const HEADER_BYTES = 20;

/** Nachrichtenklassen, die in den beiden Bits 4 und 8 des Typs stecken. */
export const CLASS = {
  REQUEST: 0x000,
  INDICATION: 0x010,
  SUCCESS: 0x100,
  ERROR: 0x110,
};

export const METHOD = {
  BINDING: 0x001,
  ALLOCATE: 0x003,
  REFRESH: 0x004,
  SEND: 0x006,
  DATA: 0x007,
  CREATE_PERMISSION: 0x008,
  CHANNEL_BIND: 0x009,
};

export const ATTR = {
  MAPPED_ADDRESS: 0x0001,
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  UNKNOWN_ATTRIBUTES: 0x000a,
  CHANNEL_NUMBER: 0x000c,
  LIFETIME: 0x000d,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  DONT_FRAGMENT: 0x001a,
  XOR_MAPPED_ADDRESS: 0x0020,
  RESERVATION_TOKEN: 0x0022,
  SOFTWARE: 0x8022,
  ALTERNATE_SERVER: 0x8023,
  FINGERPRINT: 0x8028,
};

/** Die Fehlernummern, die dieser Server tatsächlich vergibt. */
export const ERROR = {
  BAD_REQUEST: [400, 'Bad Request'],
  UNAUTHORIZED: [401, 'Unauthorized'],
  FORBIDDEN: [403, 'Forbidden'],
  ALLOCATION_MISMATCH: [437, 'Allocation Mismatch'],
  STALE_NONCE: [438, 'Stale Nonce'],
  WRONG_CREDENTIALS: [441, 'Wrong Credentials'],
  UNSUPPORTED_TRANSPORT: [442, 'Unsupported Transport Protocol'],
  ALLOCATION_QUOTA: [486, 'Allocation Quota Reached'],
  SERVER_ERROR: [500, 'Server Error'],
  INSUFFICIENT_CAPACITY: [508, 'Insufficient Capacity'],
};

const FINGERPRINT_XOR = 0x5354554e;

// ---------------------------------------------------------------- Typ-Rechnen

/**
 * Methode und Klasse stecken verschränkt im 14-Bit-Typ: die Klassenbits
 * sitzen an Position 4 und 8, die Methodenbits füllen den Rest auf. Das sieht
 * gewollt umständlich aus und ist es auch - historisch bedingt.
 */
export function encodeType(method, klass) {
  // Die Klassenbits liegen in den Konstanten oben schon an ihrem Platz
  // (Bit 4 und Bit 8) - sie werden nur dazugeodert, nicht verschoben.
  return ((method & 0x0f80) << 2) | ((method & 0x0070) << 1) | (method & 0x000f) | (klass & 0x0110);
}

export function decodeType(type) {
  const method = ((type & 0x3e00) >> 2) | ((type & 0x00e0) >> 1) | (type & 0x000f);
  return { method, klass: type & 0x0110 };
}

// -------------------------------------------------------------------- Adresse

function xorAddress(buffer, transactionId) {
  const family = buffer[1];
  const port = buffer.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16);
  if (family === 0x01) {
    const raw = buffer.subarray(4, 8);
    const out = Buffer.alloc(4);
    const cookie = Buffer.alloc(4);
    cookie.writeUInt32BE(MAGIC_COOKIE);
    for (let i = 0; i < 4; i += 1) out[i] = raw[i] ^ cookie[i];
    return { family: 'IPv4', address: [...out].join('.'), port };
  }
  if (family === 0x02) {
    const raw = buffer.subarray(4, 20);
    const mask = Buffer.concat([Buffer.alloc(4), transactionId]);
    mask.writeUInt32BE(MAGIC_COOKIE, 0);
    const out = Buffer.alloc(16);
    for (let i = 0; i < 16; i += 1) out[i] = raw[i] ^ mask[i];
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(out.readUInt16BE(i).toString(16));
    return { family: 'IPv6', address: parts.join(':'), port };
  }
  return null;
}

function encodeXorAddress(address, port, family, transactionId) {
  if (family === 'IPv6') {
    const out = Buffer.alloc(20);
    out[0] = 0;
    out[1] = 0x02;
    out.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 2);
    const raw = ipv6ToBuffer(address);
    const mask = Buffer.concat([Buffer.alloc(4), transactionId]);
    mask.writeUInt32BE(MAGIC_COOKIE, 0);
    for (let i = 0; i < 16; i += 1) out[4 + i] = raw[i] ^ mask[i];
    return out;
  }
  const out = Buffer.alloc(8);
  out[0] = 0;
  out[1] = 0x01;
  out.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 2);
  const raw = Buffer.from(address.split('.').map((part) => Number(part)));
  const cookie = Buffer.alloc(4);
  cookie.writeUInt32BE(MAGIC_COOKIE);
  for (let i = 0; i < 4; i += 1) out[4 + i] = raw[i] ^ cookie[i];
  return out;
}

function encodePlainAddress(address, port, family) {
  if (family === 'IPv6') {
    const out = Buffer.alloc(20);
    out[1] = 0x02;
    out.writeUInt16BE(port, 2);
    ipv6ToBuffer(address).copy(out, 4);
    return out;
  }
  const out = Buffer.alloc(8);
  out[1] = 0x01;
  out.writeUInt16BE(port, 2);
  Buffer.from(address.split('.').map(Number)).copy(out, 4);
  return out;
}

function ipv6ToBuffer(address) {
  const out = Buffer.alloc(16);
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':').filter(Boolean) : [];
  const right = tail ? tail.split(':').filter(Boolean) : [];
  const gap = 8 - left.length - right.length;
  const groups = [...left, ...Array(Math.max(0, gap)).fill('0'), ...right];
  for (let i = 0; i < 8; i += 1) out.writeUInt16BE(parseInt(groups[i] ?? '0', 16) || 0, i * 2);
  return out;
}

// ---------------------------------------------------------------------- Lesen

/**
 * Zerlegt eine Nachricht. Gibt `null` zurück, wenn es keine gültige ist -
 * auf einem offenen Port landet allerlei, das kein STUN sein will.
 */
export function decode(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_BYTES) return null;
  if ((buffer[0] & 0xc0) !== 0) return null;
  if (buffer.readUInt32BE(4) !== MAGIC_COOKIE) return null;
  const length = buffer.readUInt16BE(2);
  if (length % 4 !== 0) return null;
  if (buffer.length < HEADER_BYTES + length) return null;

  const type = buffer.readUInt16BE(0);
  const { method, klass } = decodeType(type);
  const transactionId = Buffer.from(buffer.subarray(8, 20));
  const attributes = [];
  let offset = HEADER_BYTES;
  const end = HEADER_BYTES + length;
  while (offset + 4 <= end) {
    const attrType = buffer.readUInt16BE(offset);
    const attrLength = buffer.readUInt16BE(offset + 2);
    const valueStart = offset + 4;
    const valueEnd = valueStart + attrLength;
    if (valueEnd > end) return null;
    attributes.push({
      type: attrType,
      value: Buffer.from(buffer.subarray(valueStart, valueEnd)),
      // Für MESSAGE-INTEGRITY und FINGERPRINT zählt, wo das Attribut anfängt.
      start: offset,
    });
    offset = valueEnd + ((4 - (attrLength % 4)) % 4);
  }

  return {
    type,
    method,
    class: klass,
    transactionId,
    attributes,
    raw: Buffer.from(buffer.subarray(0, end)),
    get(attrType) {
      return attributes.find((attr) => attr.type === attrType)?.value ?? null;
    },
    getAddress(attrType) {
      const value = attributes.find((attr) => attr.type === attrType)?.value;
      return value ? xorAddress(value, transactionId) : null;
    },
    text(attrType) {
      const value = attributes.find((attr) => attr.type === attrType)?.value;
      return value ? value.toString('utf8') : null;
    },
  };
}

// -------------------------------------------------------------------- Schreiben

export class MessageBuilder {
  constructor(method, klass, transactionId) {
    this.method = method;
    this.klass = klass;
    this.transactionId = transactionId ?? crypto.randomBytes(12);
    this.parts = [];
  }

  add(type, value) {
    const padding = (4 - (value.length % 4)) % 4;
    const head = Buffer.alloc(4);
    head.writeUInt16BE(type, 0);
    head.writeUInt16BE(value.length, 2);
    this.parts.push(head, value, Buffer.alloc(padding));
    return this;
  }

  addText(type, text) {
    return this.add(type, Buffer.from(text, 'utf8'));
  }

  addUInt32(type, value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0);
    return this.add(type, buffer);
  }

  addXorAddress(type, address, port, family = 'IPv4') {
    return this.add(type, encodeXorAddress(address, port, family, this.transactionId));
  }

  addAddress(type, address, port, family = 'IPv4') {
    return this.add(type, encodePlainAddress(address, port, family));
  }

  addError(code, reason) {
    const head = Buffer.alloc(4);
    head[2] = Math.floor(code / 100);
    head[3] = code % 100;
    return this.add(ATTR.ERROR_CODE, Buffer.concat([head, Buffer.from(reason, 'utf8')]));
  }

  /** Länge im Kopf zählt auch das noch nicht geschriebene Attribut mit. */
  #withLength(extra) {
    const body = Buffer.concat(this.parts);
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt16BE(encodeType(this.method, this.klass), 0);
    header.writeUInt16BE(body.length + extra, 2);
    header.writeUInt32BE(MAGIC_COOKIE, 4);
    this.transactionId.copy(header, 8);
    return Buffer.concat([header, body]);
  }

  /**
   * Signiert die Nachricht. Der Schlüssel ist bei Langzeit-Zugangsdaten
   * MD5(benutzer:bereich:passwort) - so schreibt es RFC 5389 vor, auch wenn
   * MD5 heute niemand mehr freiwillig wählen würde. Geschützt wird damit die
   * Zuordnung zum Konto, nicht der Inhalt: der Medienstrom darüber ist
   * ohnehin schon mit DTLS-SRTP verschlüsselt.
   */
  sign(key) {
    // 20 Byte HMAC plus 4 Byte Attributkopf.
    const partial = this.#withLength(24);
    const hmac = crypto.createHmac('sha1', key).update(partial).digest();
    this.add(ATTR.MESSAGE_INTEGRITY, hmac);
    return this;
  }

  /** Prüfsumme über alles davor - erkennt Verwechslungen mit anderen Protokollen. */
  addFingerprint() {
    const partial = this.#withLength(8);
    const crc = (crc32(partial) ^ FINGERPRINT_XOR) >>> 0;
    return this.addUInt32(ATTR.FINGERPRINT, crc);
  }

  build() {
    return this.#withLength(0);
  }
}

export function longTermKey(username, realm, password) {
  return crypto.createHash('md5').update(`${username}:${realm}:${password}`, 'utf8').digest();
}

/**
 * Prüft MESSAGE-INTEGRITY. Gerechnet wird über die Nachricht bis zum Beginn
 * des Attributs, mit einer Länge, die so tut, als endete sie dahinter.
 */
export function checkIntegrity(message, key) {
  const attr = message.attributes.find((a) => a.type === ATTR.MESSAGE_INTEGRITY);
  if (!attr || attr.value.length !== 20) return false;
  const upToAttribute = Buffer.from(message.raw.subarray(0, attr.start));
  upToAttribute.writeUInt16BE(attr.start + 24 - HEADER_BYTES, 2);
  const expected = crypto.createHmac('sha1', key).update(upToAttribute).digest();
  return expected.length === attr.value.length && crypto.timingSafeEqual(expected, attr.value);
}

// -------------------------------------------------------------------- CRC-32

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * TURN packt weitergereichte Daten in ChannelData-Nachrichten, sobald sich
 * beide auf eine Kanalnummer geeinigt haben. Die haben einen eigenen, viel
 * kürzeren Kopf - und die ersten beiden Bits sind 01 statt 00.
 */
export function isChannelData(buffer) {
  return buffer.length >= 4 && (buffer[0] & 0xc0) === 0x40;
}

export function decodeChannelData(buffer) {
  if (!isChannelData(buffer)) return null;
  const channel = buffer.readUInt16BE(0);
  const length = buffer.readUInt16BE(2);
  if (buffer.length < 4 + length) return null;
  return { channel, data: Buffer.from(buffer.subarray(4, 4 + length)) };
}

export function encodeChannelData(channel, data) {
  const padding = (4 - (data.length % 4)) % 4;
  const out = Buffer.alloc(4 + data.length + padding);
  out.writeUInt16BE(channel, 0);
  out.writeUInt16BE(data.length, 2);
  data.copy(out, 4);
  return out;
}
