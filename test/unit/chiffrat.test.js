/**
 * Was als Chiffrat durchgeht - und was nicht.
 *
 * Der Server sieht nur einen Text und reicht ihn weiter; entschluesseln kann
 * ihn nur das Gegenueber. Genau deshalb muss er wenigstens pruefen, dass es
 * ueberhaupt Text ist. PHP tat das nicht: aus `ct: 123` wurde "123", aus
 * einem Feld "Array" (samt Warnung im Protokoll). Beides landete unloeschbar
 * im Verlauf, unlesbar fuer jeden. Node wies es seit jeher ab.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, TestClient, b64 } from '../helpers.js';
import { phpVorhanden, withPhp } from '../php-server.js';

let zaehler = 0;
const frisch = (was) => (`${was}${(zaehler += 1)}${'x'.repeat(22)}`).slice(0, 22);

/** Alles, was kein Text ist - und ein Text als Gegenprobe. */
const FAELLE = [
  ['Zahl', 123],
  ['Wahrheitswert', true],
  ['Feld', ['a', 'b']],
  ['Objekt', { a: 1 }],
  ['fehlt', undefined],
  ['leer', ''],
  ['Text', null],
];

const wert = (name) => (name === 'Text' ? b64('echte nachricht') : FAELLE.find(([n]) => n === name)[1]);

/** @returns {Promise<Record<string, string>>} je Fall: 'angenommen' oder der Fehlercode */
async function gegenNode() {
  return withServer(async (ctx) => {
    const roomId = frisch('raum');
    const angelegt = await fetch(`${ctx.base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, slots: [{ id: frisch('platz'), wrapped: 'p' }] }),
    }).then((a) => a.json());
    const c = await new TestClient(ctx, roomId, angelegt.you.token).opened();
    await c.next('welcome');

    const ergebnis = {};
    for (const [name] of FAELLE) {
      const ct = wert(name);
      c.send({ t: 'msg', cid: name, ...(ct === undefined ? {} : { ct }) });
      ergebnis[name] = await Promise.race([
        c.next('ack', 2000).then(() => 'angenommen'),
        c.next('err', 2000).then((f) => f.code),
      ]);
    }
    c.close();
    return ergebnis;
  });
}

async function gegenPhp() {
  return withPhp({}, async ({ base }) => {
    const roomId = frisch('raum');
    const angelegt = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, slots: [{ id: frisch('platz'), wrapped: 'p' }] }),
    }).then((a) => a.json());

    const ergebnis = {};
    for (const [name] of FAELLE) {
      const ct = wert(name);
      const antwort = await fetch(`${base}/api/rooms/${roomId}/frames`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-room-token': angelegt.you.token },
        body: JSON.stringify({ frames: [{ t: 'msg', cid: name, ...(ct === undefined ? {} : { ct }) }] }),
      });
      const rumpf = await antwort.json();
      // Ein Fehler kommt bei PHP entweder als Frame zurueck oder als Status.
      const fehler = (rumpf.direct ?? []).find((f) => f.t === 'err');
      ergebnis[name] = fehler ? fehler.code : (antwort.ok ? 'angenommen' : rumpf.error);
    }
    return ergebnis;
  });
}

const erwartet = {
  Zahl: 'empty_message',
  Wahrheitswert: 'empty_message',
  Feld: 'empty_message',
  Objekt: 'empty_message',
  fehlt: 'empty_message',
  leer: 'empty_message',
  Text: 'angenommen',
};

test('Node nimmt nur Text als Chiffrat an', async () => {
  assert.deepEqual(await gegenNode(), erwartet);
});

test('PHP nimmt genau dasselbe an', { skip: phpVorhanden ? false : 'PHP nicht vorhanden' }, async () => {
  assert.deepEqual(await gegenPhp(), erwartet);
});
