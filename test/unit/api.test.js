import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, makeRoom, randomRoomId } from '../helpers.js';

test('Healthcheck antwortet', async () => {
  await withServer(async (ctx) => {
    const res = await fetch(`${ctx.base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
});

test('Sicherheits-Header sind gesetzt', async () => {
  await withServer(async (ctx) => {
    const res = await fetch(`${ctx.base}/healthz`);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!csp.includes("'unsafe-inline'"), 'CSP darf kein unsafe-inline enthalten');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });
});

test('Raum anlegen, doppelt anlegen schlaegt fehl', async () => {
  await withServer(async (ctx) => {
    const roomId = randomRoomId();
    const first = await fetch(`${ctx.base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId }),
    });
    assert.equal(first.status, 201);

    const second = await fetch(`${ctx.base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId }),
    });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error, 'room_exists');
  });
});

test('Ungueltige Raum-IDs werden abgelehnt', async () => {
  await withServer(async (ctx) => {
    for (const roomId of ['', 'zu-kurz', 'x'.repeat(23), '../../etc/passwd', 'AAAA AAAAAAAAAAAAAAAAA']) {
      const res = await fetch(`${ctx.base}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId }),
      });
      assert.equal(res.status, 400, `erwartet 400 fuer ${JSON.stringify(roomId)}`);
    }
  });
});

test('Unbekannter Raum liefert 404', async () => {
  await withServer(async (ctx) => {
    const res = await fetch(`${ctx.base}/api/rooms/${randomRoomId()}`);
    assert.equal(res.status, 404);
  });
});

test('Raumstatus zeigt Belegung', async () => {
  await withServer(async (ctx) => {
    const roomId = await makeRoom(ctx);
    const res = await fetch(`${ctx.base}/api/rooms/${roomId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.members, 0);
    assert.equal(body.capacity, 2);
    assert.equal(body.full, false);
  });
});

test('Blob-Zugriff ohne gueltiges Token wird abgewiesen', async () => {
  await withServer(async (ctx) => {
    const roomId = await makeRoom(ctx);
    const res = await fetch(`${ctx.base}/api/rooms/${roomId}/blobs`, {
      method: 'POST',
      headers: { 'x-room-token': 'falsch' },
      body: Buffer.from('geheim'),
    });
    assert.equal(res.status, 401);
  });
});

test('Die Startseite wird fuer Deeplinks ausgeliefert', async () => {
  await withServer(async (ctx) => {
    const res = await fetch(`${ctx.base}/irgendein/pfad`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  });
});
