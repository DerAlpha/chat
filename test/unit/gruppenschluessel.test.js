/**
 * Der Schluesselbau fuer Gruppen.
 *
 * Bei einem Zweierchat IST der Code der Raum - beide Seiten rechnen aus
 * demselben Code dasselbe aus. In einer Gruppe hat jede Person ihren eigenen
 * Code, und alle sollen trotzdem denselben Schluessel benutzen. Also zeigt
 * ein Gruppen-Code auf einen Platz, und dort liegt der gemeinsame Schluessel,
 * verpackt mit einem Schluessel, den nur dieser eine Code hergibt.
 *
 * Was hier geprueft wird, ist genau das, worauf die ganze Gruppe steht: dass
 * ein einzelner Code die Gruppe nicht hergibt, dass ein Platz nur mit dem
 * richtigen Code aufgeht, und dass ein untergeschobener Raum auffliegt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveSecrets, deriveSlot, generateCode, generateGroupKey, normalizeCode,
  toBase64, unwrapGroupKey, wrapGroupKey,
} from '../../public/js/crypto.js';

const RAUM = 'AbCdEfGhIjKlMnOpQrStUv';

test('Ein Gruppen-Code ergibt Platzkennung und Verpackungsschluessel', async () => {
  const { slotId, wrapKeyRaw } = await deriveSlot('ABCD-EFGH-JKMN');
  // Dieselbe Form wie eine Raum-ID: 22 Zeichen base64url.
  assert.match(slotId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(wrapKeyRaw.length, 32);
});

test('Derselbe Code ergibt immer denselben Platz', async () => {
  const einmal = await deriveSlot('ABCD-EFGH-JKMN');
  // Schreibweise darf keine Rolle spielen - genau wie beim Zweierchat.
  const zweimal = await deriveSlot('abcdefghjkmn');
  assert.equal(einmal.slotId, zweimal.slotId);
  assert.deepEqual(einmal.wrapKeyRaw, zweimal.wrapKeyRaw);
});

test('Zwei Codes ergeben zwei verschiedene Plaetze', async () => {
  const a = await deriveSlot('ABCD-EFGH-JKMN');
  const b = await deriveSlot('ABCD-EFGH-JKMP');
  assert.notEqual(a.slotId, b.slotId);
  assert.notDeepEqual(a.wrapKeyRaw, b.wrapKeyRaw);
});

/**
 * Die beiden Welten duerfen sich nicht ins Gehege kommen: derselbe Code darf
 * nicht gleichzeitig einen Zweierchat und einen Gruppenplatz adressieren.
 */
test('Aus einem Code wird als Platz etwas anderes als als Raum', async () => {
  const code = 'ABCD-EFGH-JKMN';
  const raum = await deriveSecrets(code);
  const platz = await deriveSlot(code);
  assert.notEqual(platz.slotId, raum.roomId);
  assert.notDeepEqual(platz.wrapKeyRaw, raum.keyRaw);
});

test('Ein Gruppenschluessel ist gewuerfelt, nicht abgeleitet', () => {
  const a = generateGroupKey();
  const b = generateGroupKey();
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
  // Und nicht etwa lauter Nullen.
  assert.ok(a.some((byte) => byte !== 0));
});

test('Was fuer einen Platz verpackt wurde, geht mit dessen Code wieder auf', async () => {
  const code = generateCode();
  const { wrapKeyRaw } = await deriveSlot(code);
  const key = generateGroupKey();

  const paket = await wrapGroupKey(wrapKeyRaw, { key, roomId: RAUM, name: 'Kegelclub' });
  const auf = await unwrapGroupKey(wrapKeyRaw, paket);

  assert.ok(auf, 'das Paket ging nicht auf');
  assert.deepEqual(auf.key, key);
  assert.equal(auf.roomId, RAUM);
  assert.equal(auf.name, 'Kegelclub');
});

/**
 * Der Kern der Sache: Wer den Code einer anderen Person abfaengt, bekommt
 * ihren Platz - aber nicht die Plaetze der anderen. Ein Code gibt die Gruppe
 * nicht her.
 */
test('Mit einem fremden Code geht ein Paket nicht auf', async () => {
  const meiner = await deriveSlot(generateCode());
  const fremder = await deriveSlot(generateCode());
  const paket = await wrapGroupKey(meiner.wrapKeyRaw, { key: generateGroupKey(), roomId: RAUM, name: '' });
  assert.equal(await unwrapGroupKey(fremder.wrapKeyRaw, paket), null);
});

test('Alle Plaetze einer Gruppe fuehren zu demselben Schluessel', async () => {
  const key = generateGroupKey();
  const codes = [generateCode(), generateCode(), generateCode()];
  const plaetze = await Promise.all(codes.map((code) => deriveSlot(code)));
  const pakete = await Promise.all(
    plaetze.map((platz) => wrapGroupKey(platz.wrapKeyRaw, { key, roomId: RAUM, name: 'Verein' })),
  );

  // Jeder packt sein eigenes Paket aus - und alle haben denselben Schluessel.
  for (let i = 0; i < codes.length; i += 1) {
    const auf = await unwrapGroupKey(plaetze[i].wrapKeyRaw, pakete[i]);
    assert.ok(auf, `Platz ${i} ging nicht auf`);
    assert.deepEqual(auf.key, key);
    assert.equal(auf.roomId, RAUM);
  }
  // Die Plaetze selbst sind alle verschieden - der Server sieht drei Fremde.
  assert.equal(new Set(plaetze.map((p) => p.slotId)).size, 3);
  // Und die Pakete sehen auch alle anders aus, obwohl dasselbe drinsteckt.
  assert.equal(new Set(pakete).size, 3);
});

test('Ein veraendertes Paket geht nicht auf', async () => {
  const { wrapKeyRaw } = await deriveSlot(generateCode());
  const paket = await wrapGroupKey(wrapKeyRaw, { key: generateGroupKey(), roomId: RAUM, name: '' });
  // Ein einziges Zeichen im Geheimtext drehen.
  const bytes = Buffer.from(paket, 'base64');
  bytes[bytes.length - 5] ^= 0x01;
  assert.equal(await unwrapGroupKey(wrapKeyRaw, bytes.toString('base64')), null);
});

test('Auch Unsinn statt eines Pakets bringt nichts zum Einsturz', async () => {
  const { wrapKeyRaw } = await deriveSlot(generateCode());
  for (const unsinn of ['', 'kein-base64!', 'AAAA', toBase64(new Uint8Array(8))]) {
    assert.equal(await unwrapGroupKey(wrapKeyRaw, unsinn), null);
  }
});

/**
 * Der Raum wird mitverpackt. Ein Server, der einen Platz zu einem anderen
 * Raum zuordnet, faellt damit auf - er kann das Paket ja nicht umschreiben.
 */
test('Der Raum steckt im Paket und laesst sich nicht vertauschen', async () => {
  const { wrapKeyRaw } = await deriveSlot(generateCode());
  const paket = await wrapGroupKey(wrapKeyRaw, { key: generateGroupKey(), roomId: RAUM, name: '' });
  const auf = await unwrapGroupKey(wrapKeyRaw, paket);
  assert.equal(auf.roomId, RAUM);
  assert.notEqual(auf.roomId, 'einAndererRaum_______x');
});

test('Ein Paket ohne Schluessel oder ohne Raum wird abgelehnt', async () => {
  const { wrapKeyRaw } = await deriveSlot(generateCode());
  const { importKey, encryptJson } = await import('../../public/js/crypto.js');
  const wrapper = await importKey(wrapKeyRaw);

  // Zu kurzer Schluessel.
  const kurz = await encryptJson(wrapper, { k: toBase64(new Uint8Array(16)), r: RAUM, n: '' });
  assert.equal(await unwrapGroupKey(wrapKeyRaw, kurz), null);

  // Gar kein Raum.
  const ohneRaum = await encryptJson(wrapper, { k: toBase64(generateGroupKey()), r: '', n: '' });
  assert.equal(await unwrapGroupKey(wrapKeyRaw, ohneRaum), null);
});

test('Der Normalisierer behandelt beide Welten gleich', async () => {
  // Damit ein abgetippter Gruppen-Code genauso nachsichtig ist wie ein
  // Zweierchat-Code: Kleinschreibung, Leerzeichen, fehlende Bindestriche.
  assert.equal(normalizeCode('abcd efgh jkmn'), 'ABCDEFGHJKMN');
  const a = await deriveSlot('abcd efgh jkmn');
  const b = await deriveSlot('ABCD-EFGH-JKMN');
  assert.equal(a.slotId, b.slotId);
});
