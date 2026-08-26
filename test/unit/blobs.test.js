import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, makeRoom, TestClient, b64 } from '../helpers.js';

async function room(ctx) {
  const roomId = await makeRoom(ctx);
  const a = await new TestClient(ctx, roomId).opened();
  const welcomeA = await a.next('welcome');
  const b = await new TestClient(ctx, roomId).opened();
  const welcomeB = await b.next('welcome');
  return { roomId, a, b, welcomeA, welcomeB };
}

const upload = (ctx, roomId, token, body) =>
  fetch(`${ctx.base}/api/rooms/${roomId}/blobs`, {
    method: 'POST',
    headers: { 'x-room-token': token, 'content-type': 'application/octet-stream' },
    body,
  });

test('Anhang hochladen, an eine Nachricht haengen und wieder abrufen', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA, welcomeB } = await room(ctx);
    const payload = Buffer.from('so-tun-als-waere-das-ein-verschluesseltes-bild');

    const res = await upload(ctx, roomId, welcomeA.you.token, payload);
    assert.equal(res.status, 201);
    const blob = await res.json();
    assert.equal(blob.size, payload.length);

    a.send({ t: 'msg', cid: 'img', ct: b64('bildbeschreibung'), blobs: [blob.id] });
    await a.next('ack');
    const received = await b.next('msg');
    assert.deepEqual(received.message.att, [blob.id]);

    const download = await fetch(`${ctx.base}/api/rooms/${roomId}/blobs/${blob.id}`, {
      headers: { 'x-room-token': welcomeB.you.token },
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.equal(Buffer.from(await download.arrayBuffer()).toString(), payload.toString());
    a.close();
    b.close();
  });
});

test('Ein Anhang laesst sich nicht zweimal verwenden', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA } = await room(ctx);
    const blob = await (await upload(ctx, roomId, welcomeA.you.token, Buffer.from('daten'))).json();

    a.send({ t: 'msg', cid: '1', ct: b64('erste'), blobs: [blob.id] });
    await a.next('ack');
    a.send({ t: 'msg', cid: '2', ct: b64('zweite'), blobs: [blob.id] });
    const err = await a.next('err');
    assert.equal(err.code, 'blob_in_use');
    a.close();
    b.close();
  });
});

test('Unbekannte Anhang-IDs werden abgelehnt', async () => {
  await withServer(async (ctx) => {
    const { a, b } = await room(ctx);
    a.send({ t: 'msg', cid: '1', ct: b64('x'), blobs: ['AAAAAAAAAAAAAAAAAAAAAA'] });
    assert.equal((await a.next('err')).code, 'unknown_blob');
    a.close();
    b.close();
  });
});

test('Loeschen einer Nachricht entfernt auch den Anhang vom Server', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA, welcomeB } = await room(ctx);
    const blob = await (await upload(ctx, roomId, welcomeA.you.token, Buffer.from('bilddaten'))).json();
    a.send({ t: 'msg', cid: 'img', ct: b64('bild'), blobs: [blob.id] });
    const ack = await a.next('ack');
    await b.next('msg');

    a.send({ t: 'del', id: ack.id });
    await b.next('del');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const download = await fetch(`${ctx.base}/api/rooms/${roomId}/blobs/${blob.id}`, {
      headers: { 'x-room-token': welcomeB.you.token },
    });
    assert.equal(download.status, 404, 'Anhang muss nach dem Loeschen weg sein');
    a.close();
    b.close();
  });
});

test('Der Raum verschwindet samt Anhaengen beim Verbrennen', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA } = await room(ctx);
    const blob = await (await upload(ctx, roomId, welcomeA.you.token, Buffer.from('geheim'))).json();
    a.send({ t: 'msg', cid: 'img', ct: b64('bild'), blobs: [blob.id] });
    await a.next('ack');

    b.send({ t: 'burn' });
    await a.next('burned');
    await new Promise((resolve) => setTimeout(resolve, 150));

    const download = await fetch(`${ctx.base}/api/rooms/${roomId}/blobs/${blob.id}`, {
      headers: { 'x-room-token': welcomeA.you.token },
    });
    assert.equal(download.status, 404);
  });
});

test('Leere Uploads werden abgelehnt', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA } = await room(ctx);
    const res = await upload(ctx, roomId, welcomeA.you.token, Buffer.alloc(0));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'empty_blob');
    a.close();
    b.close();
  });
});

test('Zu grosse Uploads werden abgelehnt', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA } = await room(ctx);
    const res = await upload(ctx, roomId, welcomeA.you.token, Buffer.alloc(13 * 1024 * 1024, 7));
    assert.ok(res.status === 413 || res.status === 400, `unerwarteter Status ${res.status}`);
    a.close();
    b.close();
  });
});

test('Pfad-Tricks in der Anhang-ID greifen nicht', async () => {
  await withServer(async (ctx) => {
    const { roomId, a, b, welcomeA } = await room(ctx);
    for (const evil of ['..%2f..%2frooms.json', '%2e%2e%2f%2e%2e%2frooms.json']) {
      const res = await fetch(`${ctx.base}/api/rooms/${roomId}/blobs/${evil}`, {
        headers: { 'x-room-token': welcomeA.you.token },
      });
      assert.ok(res.status === 400 || res.status === 404, `unerwarteter Status ${res.status} fuer ${evil}`);
    }
    a.close();
    b.close();
  });
});
