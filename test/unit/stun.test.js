/**
 * Der STUN-Codec gegen die Vorgaben aus RFC 5389 und RFC 5769.
 *
 * RFC 5769 enthält vollständige Beispielnachrichten samt erwarteter
 * Prüfsummen. Gegen die zu testen ist deutlich mehr wert als gegen die eigene
 * Schreibroutine: ein Denkfehler, der beim Lesen und beim Schreiben derselbe
 * ist, fiele sonst nie auf.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTR, CLASS, METHOD, MessageBuilder, checkIntegrity, crc32, decode,
  decodeChannelData, decodeType, encodeChannelData, encodeType, longTermKey,
} from '../../turn/stun.js';

// --- Typ-Verschränkung -----------------------------------------------------

test('Methode und Klasse überstehen das Hin und Her im Typfeld', () => {
  for (const method of [METHOD.BINDING, METHOD.ALLOCATE, METHOD.REFRESH, METHOD.SEND,
    METHOD.DATA, METHOD.CREATE_PERMISSION, METHOD.CHANNEL_BIND]) {
    for (const klass of [CLASS.REQUEST, CLASS.INDICATION, CLASS.SUCCESS, CLASS.ERROR]) {
      const type = encodeType(method, klass);
      assert.deepEqual(decodeType(type), { method, klass }, `${method}/${klass}`);
    }
  }
});

test('Die bekannten Typwerte stimmen mit den Vorgaben überein', () => {
  // Aus RFC 5389 und RFC 5766 - wer hier danebenliegt, redet mit niemandem.
  assert.equal(encodeType(METHOD.BINDING, CLASS.REQUEST), 0x0001);
  assert.equal(encodeType(METHOD.BINDING, CLASS.SUCCESS), 0x0101);
  assert.equal(encodeType(METHOD.BINDING, CLASS.ERROR), 0x0111);
  assert.equal(encodeType(METHOD.ALLOCATE, CLASS.REQUEST), 0x0003);
  assert.equal(encodeType(METHOD.ALLOCATE, CLASS.SUCCESS), 0x0103);
  assert.equal(encodeType(METHOD.ALLOCATE, CLASS.ERROR), 0x0113);
  assert.equal(encodeType(METHOD.SEND, CLASS.INDICATION), 0x0016);
  assert.equal(encodeType(METHOD.DATA, CLASS.INDICATION), 0x0017);
  assert.equal(encodeType(METHOD.CHANNEL_BIND, CLASS.REQUEST), 0x0009);
});

// --- RFC 5769: die Beispielnachrichten -------------------------------------

/** 2.1 "Sample Request" - Anfrage mit Langzeit-Zugangsdaten und Prüfsumme. */
const RFC_REQUEST = Buffer.from([
  0x00, 0x01, 0x00, 0x58, 0x21, 0x12, 0xa4, 0x42, 0xb7, 0xe7, 0xa7, 0x01,
  0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae, 0x80, 0x22, 0x00, 0x10,
  0x53, 0x54, 0x55, 0x4e, 0x20, 0x74, 0x65, 0x73, 0x74, 0x20, 0x63, 0x6c,
  0x69, 0x65, 0x6e, 0x74, 0x00, 0x24, 0x00, 0x04, 0x6e, 0x00, 0x01, 0xff,
  0x80, 0x29, 0x00, 0x08, 0x93, 0x2f, 0xf9, 0xb1, 0x51, 0x26, 0x3b, 0x36,
  0x00, 0x06, 0x00, 0x09, 0x65, 0x76, 0x74, 0x6a, 0x3a, 0x68, 0x36, 0x76,
  0x59, 0x20, 0x20, 0x20, 0x00, 0x08, 0x00, 0x14, 0x9a, 0xea, 0xa7, 0x0c,
  0xbf, 0xd8, 0xcb, 0x56, 0x78, 0x1e, 0xf2, 0xb5, 0xb2, 0xd3, 0xf2, 0x49,
  0xc1, 0xb5, 0x71, 0xa2, 0x80, 0x28, 0x00, 0x04, 0xe5, 0x7a, 0x3b, 0xcf,
]);

/** 2.2 "Sample IPv4 Response" - mit XOR-MAPPED-ADDRESS 192.0.2.1:32853. */
const RFC_RESPONSE = Buffer.from([
  0x01, 0x01, 0x00, 0x3c, 0x21, 0x12, 0xa4, 0x42, 0xb7, 0xe7, 0xa7, 0x01,
  0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae, 0x80, 0x22, 0x00, 0x0b,
  0x74, 0x65, 0x73, 0x74, 0x20, 0x76, 0x65, 0x63, 0x74, 0x6f, 0x72, 0x20,
  0x00, 0x20, 0x00, 0x08, 0x00, 0x01, 0xa1, 0x47, 0xe1, 0x12, 0xa6, 0x43,
  0x00, 0x08, 0x00, 0x14, 0x2b, 0x91, 0xf5, 0x99, 0xfd, 0x9e, 0x90, 0xc3,
  0x8c, 0x74, 0x89, 0xf9, 0x2a, 0xf9, 0xba, 0x53, 0xf0, 0x6b, 0xe7, 0xd7,
  0x80, 0x28, 0x00, 0x04, 0xc0, 0x7d, 0x4c, 0x96,
]);

/** 2.4 "Sample Request with Long-Term Authentication". */
const RFC_LONGTERM = Buffer.from([
  0x00, 0x01, 0x00, 0x60, 0x21, 0x12, 0xa4, 0x42, 0x78, 0xad, 0x34, 0x33,
  0xc6, 0xad, 0x72, 0xc0, 0x29, 0xda, 0x41, 0x2e, 0x00, 0x06, 0x00, 0x12,
  0xe3, 0x83, 0x9e, 0xe3, 0x83, 0x88, 0xe3, 0x83, 0xaa, 0xe3, 0x83, 0x83,
  0xe3, 0x82, 0xaf, 0xe3, 0x82, 0xb9, 0x00, 0x00, 0x00, 0x15, 0x00, 0x1c,
  0x66, 0x2f, 0x2f, 0x34, 0x39, 0x39, 0x6b, 0x39, 0x35, 0x34, 0x64, 0x36,
  0x4f, 0x4c, 0x33, 0x34, 0x6f, 0x4c, 0x39, 0x46, 0x53, 0x54, 0x76, 0x79,
  0x36, 0x34, 0x73, 0x41, 0x00, 0x14, 0x00, 0x0b, 0x65, 0x78, 0x61, 0x6d,
  0x70, 0x6c, 0x65, 0x2e, 0x6f, 0x72, 0x67, 0x00, 0x00, 0x08, 0x00, 0x14,
  0xf6, 0x70, 0x24, 0x65, 0x6d, 0xd6, 0x4a, 0x3e, 0x02, 0xb8, 0xe0, 0x71,
  0x2e, 0x85, 0xc9, 0xa2, 0x8c, 0xa8, 0x96, 0x66,
]);

test('Die Beispielanfrage aus RFC 5769 wird richtig gelesen', () => {
  const message = decode(RFC_REQUEST);
  assert.ok(message, 'nicht als STUN erkannt');
  assert.equal(message.method, METHOD.BINDING);
  assert.equal(message.class, CLASS.REQUEST);
  assert.equal(message.text(ATTR.SOFTWARE), 'STUN test client');
  assert.equal(message.text(ATTR.USERNAME), 'evtj:h6vY');
});

test('Die Prüfsumme der Beispielanfrage stimmt', () => {
  const message = decode(RFC_REQUEST);
  const attr = message.attributes.find((a) => a.type === ATTR.FINGERPRINT);
  const bis = RFC_REQUEST.subarray(0, attr.start);
  const kopf = Buffer.from(bis);
  kopf.writeUInt16BE(attr.start + 8 - 20, 2);
  assert.equal((crc32(kopf) ^ 0x5354554e) >>> 0, attr.value.readUInt32BE(0));
});

test('Die Signatur der Beispielanfrage lässt sich nachrechnen', () => {
  // Kurzzeit-Zugangsdaten: der Schlüssel ist schlicht das Passwort.
  const message = decode(RFC_REQUEST);
  assert.equal(checkIntegrity(message, Buffer.from('VOkJxbRl1RmTxUk/WvJxBt', 'utf8')), true);
});

test('Eine verfälschte Nachricht fällt bei der Signaturprüfung durch', () => {
  const kaputt = Buffer.from(RFC_REQUEST);
  kaputt[30] ^= 0x01; // ein Byte im SOFTWARE-Attribut
  const message = decode(kaputt);
  assert.equal(checkIntegrity(message, Buffer.from('VOkJxbRl1RmTxUk/WvJxBt', 'utf8')), false);
});

test('Die Beispielantwort liefert die richtige Adresse zurück', () => {
  const message = decode(RFC_RESPONSE);
  assert.deepEqual(message.getAddress(ATTR.XOR_MAPPED_ADDRESS), {
    family: 'IPv4',
    address: '192.0.2.1',
    port: 32853,
  });
});

test('Langzeit-Zugangsdaten: der Schlüssel aus Benutzer, Bereich und Passwort', () => {
  const message = decode(RFC_LONGTERM);
  assert.equal(message.text(ATTR.REALM), 'example.org');
  // Der Benutzername ist absichtlich nicht-lateinisch (japanisch "Matrix").
  assert.equal(message.text(ATTR.USERNAME), 'マトリックス');
  const key = longTermKey(message.text(ATTR.USERNAME), 'example.org', 'TheMatrIX');
  assert.equal(checkIntegrity(message, key), true);
});

// --- Schreiben -------------------------------------------------------------

test('Selbst geschriebene Nachrichten lassen sich wieder lesen', () => {
  const gebaut = new MessageBuilder(METHOD.ALLOCATE, CLASS.SUCCESS)
    .addXorAddress(ATTR.XOR_RELAYED_ADDRESS, '198.51.100.7', 49152)
    .addXorAddress(ATTR.XOR_MAPPED_ADDRESS, '203.0.113.9', 54321)
    .addUInt32(ATTR.LIFETIME, 600)
    .addText(ATTR.SOFTWARE, 'Flüsterchat')
    .build();

  const message = decode(gebaut);
  assert.equal(message.method, METHOD.ALLOCATE);
  assert.equal(message.class, CLASS.SUCCESS);
  assert.deepEqual(message.getAddress(ATTR.XOR_RELAYED_ADDRESS), { family: 'IPv4', address: '198.51.100.7', port: 49152 });
  assert.deepEqual(message.getAddress(ATTR.XOR_MAPPED_ADDRESS), { family: 'IPv4', address: '203.0.113.9', port: 54321 });
  assert.equal(message.get(ATTR.LIFETIME).readUInt32BE(0), 600);
  assert.equal(message.text(ATTR.SOFTWARE), 'Flüsterchat');
});

test('Eine selbst signierte Nachricht prüft sich selbst', () => {
  const key = longTermKey('anna', 'fluesterchat', 'geheim');
  const gebaut = new MessageBuilder(METHOD.BINDING, CLASS.SUCCESS)
    .addText(ATTR.USERNAME, 'anna')
    .addText(ATTR.REALM, 'fluesterchat')
    .sign(key)
    .addFingerprint()
    .build();

  const message = decode(gebaut);
  assert.equal(checkIntegrity(message, key), true);
  assert.equal(checkIntegrity(message, longTermKey('anna', 'fluesterchat', 'falsch')), false);
});

test('Attribute werden auf vier Byte aufgefüllt, ohne die Länge zu verfälschen', () => {
  // "abc" ist drei Byte lang und braucht ein Füllbyte.
  const gebaut = new MessageBuilder(METHOD.BINDING, CLASS.REQUEST).addText(ATTR.SOFTWARE, 'abc').build();
  assert.equal(gebaut.length % 4, 0);
  assert.equal(gebaut.readUInt16BE(2), 8, 'Länge im Kopf');
  assert.equal(decode(gebaut).text(ATTR.SOFTWARE), 'abc');
});

test('Fehlerantworten tragen Nummer und Grund', () => {
  const gebaut = new MessageBuilder(METHOD.ALLOCATE, CLASS.ERROR).addError(401, 'Unauthorized').build();
  const value = decode(gebaut).get(ATTR.ERROR_CODE);
  assert.equal(value[2] * 100 + value[3], 401);
  assert.equal(value.subarray(4).toString('utf8'), 'Unauthorized');
});

// --- Was kein STUN ist -----------------------------------------------------

test('Fremder Verkehr auf dem Port wird nicht für STUN gehalten', () => {
  assert.equal(decode(Buffer.alloc(0)), null);
  assert.equal(decode(Buffer.from('GET / HTTP/1.1\r\n\r\n')), null);
  // Richtige Länge, falsche magische Zahl.
  const falsch = Buffer.alloc(20);
  falsch.writeUInt16BE(0x0001, 0);
  falsch.writeUInt32BE(0x11111111, 4);
  assert.equal(decode(falsch), null);
  // Die ersten beiden Bits müssen null sein.
  const kanal = Buffer.alloc(20);
  kanal[0] = 0x40;
  assert.equal(decode(kanal), null);
});

test('Eine abgeschnittene Nachricht wird abgelehnt', () => {
  assert.equal(decode(RFC_REQUEST.subarray(0, RFC_REQUEST.length - 4)), null);
});

// --- ChannelData -----------------------------------------------------------

test('ChannelData überlebt Hin- und Rückweg', () => {
  const daten = Buffer.from('Ein Medienpaket, so tun wir jedenfalls');
  const gebaut = encodeChannelData(0x4001, daten);
  assert.equal(gebaut.length % 4, 0, 'auf vier Byte aufgefüllt');
  const gelesen = decodeChannelData(gebaut);
  assert.equal(gelesen.channel, 0x4001);
  assert.deepEqual(gelesen.data, daten);
});

test('ChannelData und STUN werden auseinandergehalten', () => {
  assert.equal(decodeChannelData(RFC_REQUEST), null);
  assert.equal(decode(encodeChannelData(0x4000, Buffer.from('x'))), null);
});
