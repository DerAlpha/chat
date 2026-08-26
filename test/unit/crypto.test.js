import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCode, formatCode, normalizeCode, isCompleteCode, codeLength,
  deriveRoomId, deriveKey, importKey, encryptJson, decryptJson,
  encryptBytes, decryptBytes, toBase64, fromBase64, randomId,
} from '../../public/js/crypto.js';
import { ROOM_ID_RE } from '../../server/store.js';

test('Codes haben die richtige Form und keine verwechselbaren Zeichen', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.ok(isCompleteCode(code));
    assert.equal(normalizeCode(code).length, codeLength);
    assert.ok(!/[ILOU]/.test(code), `Code enthaelt verwechselbares Zeichen: ${code}`);
  }
});

test('Codes sind nicht vorhersagbar', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(generateCode());
  assert.equal(seen.size, 500);
});

test('Tippfehler beim Eingeben werden korrigiert', () => {
  assert.equal(normalizeCode('h7q2 9xkm 3btv'), 'H7Q29XKM3BTV');
  assert.equal(normalizeCode('h7q2-9xkm-3btv'), 'H7Q29XKM3BTV');
  assert.equal(normalizeCode('OIL'), '011', 'O wird 0, I und L werden 1');
  assert.equal(normalizeCode('oil'), '011');
  assert.equal(normalizeCode('!!!ABC???'), 'ABC');
  assert.equal(normalizeCode('ABCDEFGHJKMNPQRST'), 'ABCDEFGHJKMN', 'wird auf 12 Zeichen gekuerzt');
  assert.equal(normalizeCode(null), '');
  assert.equal(normalizeCode(undefined), '');
});

test('formatCode gruppiert in Viererbloecken', () => {
  assert.equal(formatCode('h7q29xkm3btv'), 'H7Q2-9XKM-3BTV');
  assert.equal(formatCode('H7Q2-9XKM-3BTV'), 'H7Q2-9XKM-3BTV');
  assert.equal(formatCode('AB'), 'AB');
  assert.equal(formatCode(''), '');
});

test('Unvollstaendige Codes werden erkannt', () => {
  assert.equal(isCompleteCode('H7Q2-9XKM-3BT'), false);
  assert.equal(isCompleteCode(''), false);
  assert.equal(isCompleteCode('H7Q2-9XKM-3BTV'), true);
});

test('Die Raum-ID passt zum Serverformat und ist stabil', async () => {
  const code = generateCode();
  const roomId = await deriveRoomId(code);
  assert.match(roomId, ROOM_ID_RE, 'muss dem Serverformat entsprechen');
  assert.equal(roomId, await deriveRoomId(code.toLowerCase()));
  assert.equal(roomId, await deriveRoomId(normalizeCode(code)));
  assert.notEqual(roomId, await deriveRoomId(generateCode()));
});

test('Aus der Raum-ID laesst sich der Code nicht ablesen', async () => {
  const code = 'H7Q2-9XKM-3BTV';
  const roomId = await deriveRoomId(code);
  assert.ok(!roomId.includes('H7Q2'));
  assert.ok(!roomId.toUpperCase().includes(normalizeCode(code).slice(0, 4)));
});

test('Nachrichten lassen sich mit demselben Code ver- und entschluesseln', async () => {
  const code = generateCode();
  const keyA = await importKey(await deriveKey(code));
  const keyB = await importKey(await deriveKey(code.toLowerCase().replace(/-/g, '')));
  const payload = { v: 1, kind: 'text', text: 'Hallo! Umlaute: äöüß, Emoji: 🎉👋', ts: 123 };
  const ct = await encryptJson(keyA, payload);
  assert.deepEqual(await decryptJson(keyB, ct), payload);
});

test('Ein falscher Code entschluesselt nichts', async () => {
  const keyA = await importKey(await deriveKey(generateCode()));
  const keyB = await importKey(await deriveKey(generateCode()));
  const ct = await encryptJson(keyA, { text: 'geheim' });
  await assert.rejects(() => decryptJson(keyB, ct));
});

test('Manipulierte Chiffrate werden erkannt (AES-GCM)', async () => {
  const key = await importKey(await deriveKey(generateCode()));
  const ct = await encryptJson(key, { text: 'unveraendert' });
  const bytes = fromBase64(ct);
  bytes[bytes.length - 1] ^= 0x01;
  await assert.rejects(() => decryptJson(key, toBase64(bytes)), 'ein gekipptes Bit muss auffallen');

  const shortened = toBase64(fromBase64(ct).subarray(0, 8));
  await assert.rejects(() => decryptJson(key, shortened), /zu kurz/i);
});

test('Gleiche Nachricht ergibt unterschiedliche Chiffrate (frischer IV)', async () => {
  const key = await importKey(await deriveKey(generateCode()));
  const first = await encryptJson(key, { text: 'gleich' });
  const second = await encryptJson(key, { text: 'gleich' });
  assert.notEqual(first, second);
  assert.deepEqual(await decryptJson(key, first), await decryptJson(key, second));
});

test('Binaerdaten ueberstehen die Verschluesselung unveraendert', async () => {
  const key = await importKey(await deriveKey(generateCode()));
  const original = new Uint8Array(64 * 1024);
  for (let i = 0; i < original.length; i += 1) original[i] = (i * 31) % 256;
  const sealed = await encryptBytes(key, original);
  assert.equal(sealed.length, original.length + 12 + 16, 'IV plus Authentifizierungs-Tag');
  assert.deepEqual(await decryptBytes(key, sealed), original);
});

test('Base64 haelt auch grosse Datenmengen aus', () => {
  const bytes = new Uint8Array(300 * 1024);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});

test('randomId liefert eindeutige, URL-sichere IDs', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i += 1) {
    const id = randomId();
    assert.match(id, /^[A-Za-z0-9_-]+$/);
    ids.add(id);
  }
  assert.equal(ids.size, 1000);
});
