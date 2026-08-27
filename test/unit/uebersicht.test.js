/**
 * Die Kurzfassung mehrerer Raeume auf einmal.
 *
 * Die App haelt genau eine Verbindung - zu dem Chat, der offen ist. Ueber
 * alle anderen weiss sie nichts: nicht, ob dort etwas angekommen ist, wann
 * zuletzt etwas kam, und nicht, ob dort jemand schreibt. Genau das liefert
 * dieser eine Aufruf.
 *
 * Geprueft wird vor allem das, was hier schiefgehen darf und nicht schiefgehen
 * DARF: dass ohne gueltiges Token nichts herauskommt - auch nicht die
 * Auskunft, ob es den Raum ueberhaupt gibt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, makeRoom, randomRoomId, TestClient, b64 } from '../helpers.js';

async function twoMembers(ctx) {
  const roomId = await makeRoom(ctx);
  const a = await new TestClient(ctx, roomId).opened();
  const welcomeA = await a.next('welcome');
  const b = await new TestClient(ctx, roomId).opened();
  const welcomeB = await b.next('welcome');
  return { roomId, a, b, welcomeA, welcomeB };
}

const uebersicht = async (ctx, rooms) => {
  const res = await fetch(`${ctx.base}/api/overview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rooms }),
  });
  return { status: res.status, body: await res.json() };
};

test('Ohne Neues steht die Null da', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA } = await twoMembers(ctx);
    const { body } = await uebersicht(ctx, [{ roomId, token: welcomeA.you.token, seq: 0 }]);
    assert.equal(body.rooms.length, 1);
    assert.equal(body.rooms[0].roomId, roomId);
    assert.equal(body.rooms[0].unread, 0);
    assert.equal(body.rooms[0].lastMessageAt, 0);
    assert.equal(body.rooms[0].typing, false);
    a.close();
    b.close();
  });
});

test('Fremde Nachrichten werden gezaehlt, eigene nicht', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA } = await twoMembers(ctx);
    b.send({ t: 'msg', cid: 'c1', ct: b64('eins') });
    b.send({ t: 'msg', cid: 'c2', ct: b64('zwei') });
    a.send({ t: 'msg', cid: 'c3', ct: b64('von mir') });
    await a.next('ack');

    const { body } = await uebersicht(ctx, [{ roomId, token: welcomeA.you.token, seq: 0 }]);
    const eintrag = body.rooms[0];
    assert.equal(eintrag.unread, 2, 'die eigene Nachricht darf nicht mitzaehlen');
    assert.ok(eintrag.lastMessageAt > 0, 'die Zeit der letzten fremden Nachricht fehlt');
    a.close();
    b.close();
  });
});

/**
 * Der eigentliche Punkt: die Zeitangabe in der Uebersicht soll sagen, wann
 * zuletzt etwas KAM - nicht, wann man selbst zuletzt da war.
 */
test('Die Zeit gehoert zur letzten fremden Nachricht, nicht zur eigenen', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA } = await twoMembers(ctx);
    b.send({ t: 'msg', cid: 'c1', ct: b64('von drueben') });
    const fremd = await a.next('msg');
    await new Promise((fertig) => setTimeout(fertig, 25));
    a.send({ t: 'msg', cid: 'c2', ct: b64('von mir, spaeter') });
    const eigen = await a.next('ack');
    assert.ok(eigen);

    const { body } = await uebersicht(ctx, [{ roomId, token: welcomeA.you.token, seq: 999 }]);
    assert.equal(body.rooms[0].unread, 0, 'alles gelesen');
    assert.equal(body.rooms[0].lastMessageAt, fremd.message.ts, 'es wird die eigene Zeit gemeldet');
    a.close();
    b.close();
  });
});

test('Was schon gelesen ist, zaehlt nicht mehr', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA } = await twoMembers(ctx);
    b.send({ t: 'msg', cid: 'c1', ct: b64('eins') });
    const erste = await a.next('msg');
    b.send({ t: 'msg', cid: 'c2', ct: b64('zwei') });
    await a.next('msg');

    const { body } = await uebersicht(ctx, [{ roomId, token: welcomeA.you.token, seq: erste.message.seq }]);
    assert.equal(body.rooms[0].unread, 1);
    a.close();
    b.close();
  });
});

test('Tippen ist von aussen zu sehen - und hoert von selbst wieder auf', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA } = await twoMembers(ctx);
    b.send({ t: 'typing', on: true });
    await a.next('typing');

    const an = await uebersicht(ctx, [{ roomId, token: welcomeA.you.token, seq: 0 }]);
    assert.equal(an.body.rooms[0].typing, true);

    b.send({ t: 'typing', on: false });
    await a.next('typing');
    const aus = await uebersicht(ctx, [{ roomId, token: welcomeA.you.token, seq: 0 }]);
    assert.equal(aus.body.rooms[0].typing, false);
    a.close();
    b.close();
  });
});

test('Das eigene Tippen meldet die Uebersicht nicht zurueck', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA } = await twoMembers(ctx);
    a.send({ t: 'typing', on: true });
    await b.next('typing');
    const { body } = await uebersicht(ctx, [{ roomId, token: welcomeA.you.token, seq: 0 }]);
    assert.equal(body.rooms[0].typing, false, 'man schreibt sich nicht selbst an');
    a.close();
    b.close();
  });
});

// ------------------------------------------------------------- Was nicht darf

test('Ohne gueltiges Token gibt es keine Auskunft', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b } = await twoMembers(ctx);
    b.send({ t: 'msg', cid: 'c1', ct: b64('geheim') });
    await a.next('msg');

    const { body } = await uebersicht(ctx, [{ roomId, token: 'falsch', seq: 0 }]);
    assert.deepEqual(body.rooms, [], 'ein falsches Token darf gar nichts liefern');
    a.close();
    b.close();
  });
});

/**
 * Mit falschem Token gibt es nichts ueber den INHALT - keine Zahl, keine
 * Zeit, kein Tippen. Dass es den Raum gibt, verraet die Antwort schon
 * (naemlich dadurch, dass "gone" fehlt), und das ist in Ordnung: wer die
 * Raum-ID hat, bekommt dieselbe Auskunft ohnehin von GET api/rooms/:id, ganz
 * ohne Token. Die Raum-ID selbst ist der Hash eines Codes - wer sie raten
 * kann, kann auch den Code raten.
 */
test('Ein falsches Token gibt nichts ueber den Inhalt her', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b } = await twoMembers(ctx);
    b.send({ t: 'msg', cid: 'c1', ct: b64('geheim') });
    await a.next('msg');
    b.send({ t: 'typing', on: true });
    await a.next('typing');

    const { body } = await uebersicht(ctx, [{ roomId, token: 'falsch', seq: 0 }]);
    for (const eintrag of body.rooms) {
      assert.equal(eintrag.unread, undefined);
      assert.equal(eintrag.lastMessageAt, undefined);
      assert.equal(eintrag.typing, undefined);
    }
    a.close();
    b.close();
  });
});

test('Ein geloeschter Raum wird als weg gemeldet', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA } = await twoMembers(ctx);
    const token = welcomeA.you.token;
    a.close();
    b.close();
    await fetch(`${ctx.base}/api/rooms/${roomId}`, { method: 'DELETE', headers: { 'x-room-token': token } });

    const { body } = await uebersicht(ctx, [{ roomId, token, seq: 0 }]);
    assert.equal(body.rooms.length, 1);
    assert.equal(body.rooms[0].gone, true);
  });
});

test('Unsinn in der Anfrage bringt nichts zum Einsturz', async () => {
  await withServer(async (ctx) => {
    for (const koerper of [{}, { rooms: 'nein' }, { rooms: [null, 7, 'x'] }, { rooms: [{ roomId: 'zu kurz' }] }]) {
      const res = await fetch(`${ctx.base}/api/overview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(koerper),
      });
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).rooms, []);
    }
  });
});

test('Mehrere Raeume kommen in einer Antwort', async () => {
  await withServer(async (ctx) => {
    const eins = await twoMembers(ctx);
    const zwei = await twoMembers(ctx);
    eins.b.send({ t: 'msg', cid: 'c1', ct: b64('hallo') });
    await eins.a.next('msg');

    const { body } = await uebersicht(ctx, [
      { roomId: eins.roomId, token: eins.welcomeA.you.token, seq: 0 },
      { roomId: zwei.roomId, token: zwei.welcomeA.you.token, seq: 0 },
    ]);
    assert.equal(body.rooms.length, 2);
    const nachRaum = Object.fromEntries(body.rooms.map((r) => [r.roomId, r]));
    assert.equal(nachRaum[eins.roomId].unread, 1);
    assert.equal(nachRaum[zwei.roomId].unread, 0);
    for (const client of [eins.a, eins.b, zwei.a, zwei.b]) client.close();
  });
});
