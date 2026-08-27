/**
 * Die zweite Schicht über Ton und Bild eines Anrufs.
 *
 * Geprüft wird das, was zählt: dass ein behandeltes Paket ohne den richtigen
 * Schlüssel nichts hergibt, dass der Kopf im Klartext bleibt (der Browser
 * braucht ihn), dass er trotzdem nicht unbemerkt verändert werden kann - und
 * dass beide Seiten aus demselben Code denselben Schlüssel ableiten,
 * verschiedene Anrufe aber verschiedene.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEAR_HEADER, MIN_SEALED, deriveMediaKey, headerLength, open, seal,
} from '../../public/js/framecrypto.js';

const roomKey = new Uint8Array(32).fill(7);
const andererRaum = new Uint8Array(32).fill(9);

/** Ein Paket, wie es aus dem Encoder käme: Kopf plus Rumpf. */
const paket = (laenge = 200) => {
  const bytes = new Uint8Array(laenge);
  for (let i = 0; i < laenge; i += 1) bytes[i] = (i * 31 + 5) & 0xff;
  return bytes;
};

const bytesVon = (buffer) => new Uint8Array(buffer);

test('Ein behandeltes Paket lässt sich mit demselben Schlüssel wieder öffnen', async () => {
  const key = await deriveMediaKey(roomKey, 'anruf-1');
  const klar = paket();
  const zu = await seal(key, klar, CLEAR_HEADER.delta);
  const auf = await open(key, zu);
  assert.deepEqual(bytesVon(auf), klar);
});

test('Der Geheimtext sieht anders aus als das Original', async () => {
  const key = await deriveMediaKey(roomKey, 'anruf-1');
  const klar = paket();
  const zu = bytesVon(await seal(key, klar, CLEAR_HEADER.delta));
  // Ab dem Kopf darf nichts mehr übereinstimmen.
  const rumpfGleich = zu.subarray(CLEAR_HEADER.delta, klar.length);
  assert.notDeepEqual(rumpfGleich, klar.subarray(CLEAR_HEADER.delta));
});

test('Der Kopf bleibt im Klartext - sonst käme der Browser nicht zurecht', async () => {
  const key = await deriveMediaKey(roomKey, 'anruf-1');
  const klar = paket();
  const zu = bytesVon(await seal(key, klar, CLEAR_HEADER.key));
  assert.deepEqual(zu.subarray(0, CLEAR_HEADER.key), klar.subarray(0, CLEAR_HEADER.key));
  // Und die Kopflänge steht ganz hinten, damit die Gegenseite sie kennt.
  assert.equal(zu[zu.length - 1], CLEAR_HEADER.key);
});

test('Ein veränderter Kopf fliegt auf', async () => {
  const key = await deriveMediaKey(roomKey, 'anruf-1');
  const zu = bytesVon(await seal(key, paket(), CLEAR_HEADER.key));
  zu[2] ^= 0xff;
  assert.equal(await open(key, zu), null);
});

test('Ein verändertes Byte im Rumpf fliegt auf', async () => {
  const key = await deriveMediaKey(roomKey, 'anruf-1');
  const zu = bytesVon(await seal(key, paket(), CLEAR_HEADER.delta));
  zu[60] ^= 0x01;
  assert.equal(await open(key, zu), null);
});

test('Mit dem falschen Schlüssel geht gar nichts auf', async () => {
  const meiner = await deriveMediaKey(roomKey, 'anruf-1');
  const fremder = await deriveMediaKey(andererRaum, 'anruf-1');
  const zu = await seal(meiner, paket(), CLEAR_HEADER.delta);
  assert.equal(await open(fremder, zu), null);
});

test('Jeder Anruf bekommt seinen eigenen Schlüssel', async () => {
  const ersterAnruf = await deriveMediaKey(roomKey, 'anruf-1');
  const zweiterAnruf = await deriveMediaKey(roomKey, 'anruf-2');
  const zu = await seal(ersterAnruf, paket(), CLEAR_HEADER.delta);
  assert.equal(await open(zweiterAnruf, zu), null);
});

test('Beide Seiten leiten aus demselben Code denselben Schlüssel ab', async () => {
  const hier = await deriveMediaKey(roomKey, 'anruf-7');
  const dort = await deriveMediaKey(roomKey.slice(), 'anruf-7');
  const zu = await seal(hier, paket(), CLEAR_HEADER.delta);
  assert.deepEqual(bytesVon(await open(dort, zu)), paket());
});

test('Zweimal dasselbe Paket ergibt zweimal etwas anderes', async () => {
  const key = await deriveMediaKey(roomKey, 'anruf-1');
  const klar = paket();
  const a = bytesVon(await seal(key, klar, CLEAR_HEADER.delta));
  const b = bytesVon(await seal(key, klar, CLEAR_HEADER.delta));
  // Gleiche Länge, aber andere Bytes: die Zufallszahl ist je Paket neu.
  assert.equal(a.length, b.length);
  assert.notDeepEqual(a, b);
});

test('Ein winziges Paket wird nicht zerbrochen', async () => {
  const key = await deriveMediaKey(roomKey, 'anruf-1');
  // Kürzer als der Kopf, der im Klartext bleiben soll.
  const klein = new Uint8Array([1, 2]);
  const zu = await seal(key, klein, CLEAR_HEADER.key);
  assert.deepEqual(bytesVon(await open(key, zu)), klein);
});

test('Müll wird verworfen statt an den Decoder gereicht', async () => {
  const key = await deriveMediaKey(roomKey, 'anruf-1');
  assert.equal(await open(key, new Uint8Array(0)), null);
  assert.equal(await open(key, new Uint8Array(MIN_SEALED - 1)), null);
  // Behauptet ein Paket einen längeren Kopf, als hineinpasst, ist es kaputt.
  const kaputt = new Uint8Array(MIN_SEALED + 10);
  kaputt[kaputt.length - 1] = 200;
  assert.equal(await open(key, kaputt), null);
});

test('Ton, Schlüsselbild und Zwischenbild lassen unterschiedlich viel offen', () => {
  assert.equal(headerLength('audio', 'key'), CLEAR_HEADER.audio);
  assert.equal(headerLength('video', 'key'), CLEAR_HEADER.key);
  assert.equal(headerLength('video', 'delta'), CLEAR_HEADER.delta);
  // Ein Schlüsselbild braucht mehr im Klartext als ein Zwischenbild.
  assert.ok(CLEAR_HEADER.key > CLEAR_HEADER.delta);
});
