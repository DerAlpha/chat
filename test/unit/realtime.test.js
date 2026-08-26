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

test('Zwei Teilnehmer verbinden sich und sehen einander', async () => {
  await withServer(async (ctx) => {
    const { a, b, welcomeA, welcomeB } = await twoMembers(ctx);
    assert.equal(welcomeA.members.length, 1);
    assert.equal(welcomeB.members.length, 2);
    assert.notEqual(welcomeA.you.id, welcomeB.you.id);
    assert.ok(welcomeA.you.token && welcomeA.you.token !== welcomeB.you.token);

    const presence = await a.next('presence');
    assert.equal(presence.from, welcomeB.you.id);
    assert.equal(presence.online, true);
    a.close();
    b.close();
  });
});

test('Ein dritter Teilnehmer wird abgewiesen (Einmal-Code)', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b } = await twoMembers(ctx);
    const third = new TestClient(ctx, roomId);
    const closed = await third.waitClose();
    assert.equal(closed.code, 4003);
    assert.equal(closed.reason, 'room_full');

    const status = await (await fetch(`${ctx.base}/api/rooms/${roomId}`)).json();
    assert.equal(status.full, true);
    a.close();
    b.close();
  });
});

test('Mit Token kehrt dasselbe Mitglied zurueck', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA } = await twoMembers(ctx);
    a.close();
    const again = await new TestClient(ctx, roomId, welcomeA.you.token).opened();
    const welcome = await again.next('welcome');
    assert.equal(welcome.you.id, welcomeA.you.id);
    assert.equal(welcome.you.returning, true);
    again.close();
    b.close();
  });
});

test('Unbekannter Raum schliesst die Verbindung mit 4004', async () => {
  await withServer(async (ctx) => {
    const client = new TestClient(ctx, randomRoomId());
    const closed = await client.waitClose();
    assert.equal(closed.code, 4004);
  });
});

test('Nachricht wird zugestellt und quittiert', async () => {
  await withServer(async (ctx) => {
    const { a, b, welcomeA } = await twoMembers(ctx);
    a.send({ t: 'msg', cid: 'c1', ct: b64('hallo') });
    const ack = await a.next('ack');
    assert.equal(ack.cid, 'c1');
    assert.equal(ack.seq, 1);

    const received = await b.next('msg');
    assert.equal(received.message.ct, b64('hallo'));
    assert.equal(received.message.from, welcomeA.you.id);
    assert.equal(received.message.seq, 1);
    a.close();
    b.close();
  });
});

test('Ein Zweitgeraet bekommt eigene Nachrichten genau einmal', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA } = await twoMembers(ctx);
    const a2 = await new TestClient(ctx, roomId, welcomeA.you.token).opened();
    await a2.next('welcome');

    a.send({ t: 'msg', cid: 'c1', ct: b64('von A') });
    await a.next('ack');
    await b.next('msg');
    await a2.next('msg');
    await new Promise((resolve) => setTimeout(resolve, 150));

    const copies = a2.frames.filter((f) => f.t === 'msg');
    assert.equal(copies.length, 1, 'Zweitgeraet darf die Nachricht nur einmal erhalten');
    a.close();
    a2.close();
    b.close();
  });
});

test('Tippanzeige und Lesebestaetigung werden weitergereicht', async () => {
  await withServer(async (ctx) => {
    const { a, b, welcomeB } = await twoMembers(ctx);
    b.send({ t: 'typing', on: true });
    const typing = await a.next('typing');
    assert.equal(typing.from, welcomeB.you.id);
    assert.equal(typing.on, true);

    a.send({ t: 'msg', cid: 'm', ct: b64('gelesen?') });
    await a.next('ack');
    await b.next('msg');
    b.send({ t: 'read', seq: 1 });
    const read = await a.next('read');
    assert.equal(read.seq, 1);
    assert.equal(read.from, welcomeB.you.id);
    a.close();
    b.close();
  });
});

test('Nachricht bearbeiten und loeschen', async () => {
  await withServer(async (ctx) => {
    const { a, b } = await twoMembers(ctx);
    a.send({ t: 'msg', cid: 'm', ct: b64('erste Fassung') });
    const ack = await a.next('ack');
    await b.next('msg');

    a.send({ t: 'edit', id: ack.id, ct: b64('zweite Fassung') });
    const edited = await b.next('edit');
    assert.equal(edited.ct, b64('zweite Fassung'));
    assert.ok(edited.editedAt > 0);

    a.send({ t: 'del', id: ack.id });
    const deleted = await b.next('del');
    assert.equal(deleted.id, ack.id);
    a.close();
    b.close();
  });
});

test('Fremde Nachrichten kann man weder bearbeiten noch loeschen', async () => {
  await withServer(async (ctx) => {
    const { a, b } = await twoMembers(ctx);
    a.send({ t: 'msg', cid: 'm', ct: b64('meins') });
    const ack = await a.next('ack');
    await b.next('msg');

    b.send({ t: 'del', id: ack.id });
    const err = await b.next('err');
    assert.equal(err.code, 'not_owner');

    b.send({ t: 'edit', id: ack.id, ct: b64('gekapert') });
    const err2 = await b.next('err');
    assert.equal(err2.code, 'not_owner');
    a.close();
    b.close();
  });
});

test('Reaktionen kommen an und lassen sich zuruecknehmen', async () => {
  await withServer(async (ctx) => {
    const { a, b, welcomeB } = await twoMembers(ctx);
    a.send({ t: 'msg', cid: 'm', ct: b64('bild') });
    const ack = await a.next('ack');
    await b.next('msg');

    b.send({ t: 'react', id: ack.id, ct: b64('herz') });
    const react = await a.next('react');
    assert.equal(react.from, welcomeB.you.id);
    assert.equal(react.ct, b64('herz'));

    b.send({ t: 'react', id: ack.id, ct: null });
    const removed = await a.next('react');
    assert.equal(removed.ct, null);
    a.close();
    b.close();
  });
});

test('Verlauf wird beim Wiederverbinden mitgeliefert', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA } = await twoMembers(ctx);
    for (let i = 0; i < 5; i += 1) {
      a.send({ t: 'msg', cid: `c${i}`, ct: b64(`nachricht ${i}`) });
      await a.next('ack');
    }
    a.close();
    const again = await new TestClient(ctx, roomId, welcomeA.you.token).opened();
    const welcome = await again.next('welcome');
    assert.equal(welcome.messages.length, 5);
    assert.equal(welcome.messages[4].ct, b64('nachricht 4'));
    assert.equal(welcome.hasMore, false);
    again.close();
    b.close();
  });
});

test('Aeltere Nachrichten lassen sich nachladen', async () => {
  await withServer(async (ctx) => {
    const { a, b } = await twoMembers(ctx);
    for (let i = 0; i < 8; i += 1) {
      a.send({ t: 'msg', cid: `c${i}`, ct: b64(`n${i}`) });
      await a.next('ack');
    }
    b.send({ t: 'history', before: 4, limit: 2 });
    const page = await b.next('history');
    assert.equal(page.messages.length, 2);
    assert.deepEqual(page.messages.map((m) => m.seq), [2, 3]);
    assert.equal(page.hasMore, true);
    a.close();
    b.close();
  });
});

test('Zu grosse Nachrichten werden abgelehnt', async () => {
  await withServer(async (ctx) => {
    const { a, b } = await twoMembers(ctx);
    a.send({ t: 'msg', cid: 'big', ct: 'A'.repeat(70 * 1024) });
    const err = await a.next('err');
    assert.equal(err.code, 'message_too_large');
    a.close();
    b.close();
  });
});

test('Kaputte Frames stuerzen den Server nicht ab', async () => {
  await withServer(async (ctx) => {
    const { a, b } = await twoMembers(ctx);
    a.ws.send('kein json');
    assert.equal((await a.next('err')).code, 'bad_json');
    a.send({ nix: 1 });
    assert.equal((await a.next('err')).code, 'bad_frame');
    a.send({ t: 'gibtsnicht' });
    assert.equal((await a.next('err')).code, 'unknown_frame');
    a.send({ t: 'ping' });
    assert.ok(await a.next('pong'));
    a.close();
    b.close();
  });
});

test('Chat verbrennen loescht den Raum fuer beide', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b } = await twoMembers(ctx);
    a.send({ t: 'msg', cid: 'm', ct: b64('bis gleich') });
    await a.next('ack');
    b.send({ t: 'burn' });
    assert.ok(await a.next('burned'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const res = await fetch(`${ctx.base}/api/rooms/${roomId}`);
    assert.equal(res.status, 404);
  });
});

test('Praesenz meldet das Gehen des Gegenuebers', async () => {
  await withServer(async (ctx) => {
    const { a, b, welcomeB } = await twoMembers(ctx);
    await a.next('presence');
    b.close();
    const presence = await a.next('presence');
    assert.equal(presence.from, welcomeB.you.id);
    assert.equal(presence.online, false);
    assert.ok(presence.lastSeen > 0);
    a.close();
  });
});
