import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, Room, safeEqual, ROOM_ID_RE } from '../../server/store.js';
import { config } from '../../server/config.js';
import { RateLimiter, perMinute } from '../../server/ratelimit.js';

function tempStore(now) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluesterchat-store-'));
  const store = new Store({ dataDir, now });
  return { store, dataDir, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';

test('Raum-IDs muessen 22 URL-sichere Zeichen haben', () => {
  assert.ok(ROOM_ID_RE.test(ROOM));
  assert.ok(ROOM_ID_RE.test('aZ0-_aZ0-_aZ0-_aZ0-_aZ'));
  assert.ok(!ROOM_ID_RE.test('zu-kurz'));
  assert.ok(!ROOM_ID_RE.test(`${ROOM}A`));
  assert.ok(!ROOM_ID_RE.test('AAAAAAAAAAAAAAAAAAAA/.'));
});

test('safeEqual vergleicht korrekt und ohne Absturz', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', null), false);
  assert.equal(safeEqual(undefined, undefined), false);
  assert.equal(safeEqual('', ''), true);
});

test('Ein Raum nimmt hoechstens zwei Mitglieder auf', async () => {
  const { store, cleanup } = tempStore();
  try {
    await store.init();
    const room = store.createRoom(ROOM);
    const first = store.joinRoom(room, null);
    const second = store.joinRoom(room, null);
    const third = store.joinRoom(room, null);
    assert.ok(first.member && second.member);
    assert.equal(third.error, 'room_full');
    assert.notEqual(first.member.id, second.member.id);

    const back = store.joinRoom(room, first.member.token);
    assert.equal(back.member.id, first.member.id);
    assert.equal(back.returning, true);
  } finally {
    await store.close();
    cleanup();
  }
});

test('Ein falsches Token belegt keinen fremden Platz', async () => {
  const { store, cleanup } = tempStore();
  try {
    await store.init();
    const room = store.createRoom(ROOM);
    store.joinRoom(room, null);
    store.joinRoom(room, null);
    const attacker = store.joinRoom(room, 'erfundenes-token');
    assert.equal(attacker.error, 'room_full');
    assert.equal(room.members.size, 2);
  } finally {
    await store.close();
    cleanup();
  }
});

test('Ungenutzte Raeume laufen frueher ab als benutzte', async () => {
  let now = 1_000_000;
  const { store, cleanup } = tempStore(() => now);
  try {
    await store.init();
    const unclaimed = store.createRoom(ROOM);
    const used = store.createRoom('BBBBBBBBBBBBBBBBBBBBBB');
    store.joinRoom(used, null);

    now += config.unclaimedRoomTtlMs + 1;
    assert.equal(store.isExpired(unclaimed), true);
    assert.equal(store.isExpired(used), false);

    const removed = await store.cleanup();
    assert.equal(removed, 1);
    assert.equal(store.rooms.has(ROOM), false);
    assert.equal(store.rooms.has('BBBBBBBBBBBBBBBBBBBBBB'), true);

    now += config.roomIdleTtlMs + 1;
    assert.equal(await store.cleanup(), 1);
    assert.equal(store.rooms.size, 0);
  } finally {
    await store.close();
    cleanup();
  }
});

test('Der Verlauf wird auf die Obergrenze gekuerzt', async () => {
  const { store, cleanup } = tempStore();
  try {
    await store.init();
    const room = store.createRoom(ROOM);
    const { member } = store.joinRoom(room, null);
    const limit = config.maxMessagesPerRoom;
    for (let i = 0; i < limit + 10; i += 1) store.appendMessage(room, member, `ct-${i}`);
    assert.equal(room.messages.length, limit);
    assert.equal(room.messages[0].ct, 'ct-10');
    assert.equal(room.seq, limit + 10);
  } finally {
    await store.close();
    cleanup();
  }
});

test('Snapshot ueberlebt einen Neustart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluesterchat-persist-'));
  try {
    const first = new Store({ dataDir });
    await first.init();
    const room = first.createRoom(ROOM);
    const { member } = first.joinRoom(room, null);
    first.appendMessage(room, member, 'geheimes-chiffrat');
    await first.persist();
    await first.close();

    const second = new Store({ dataDir });
    await second.init();
    const restored = second.getRoom(ROOM);
    assert.ok(restored, 'Raum muss nach dem Neustart da sein');
    assert.equal(restored.messages.length, 1);
    assert.equal(restored.messages[0].ct, 'geheimes-chiffrat');
    assert.equal(restored.members.size, 1);
    assert.equal([...restored.members.values()][0].token, member.token);
    await second.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Ein kaputter Snapshot legt den Start nicht lahm', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluesterchat-broken-'));
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'rooms.json'), '{ das ist kein json');
    const store = new Store({ dataDir });
    await store.init();
    assert.equal(store.rooms.size, 0);
    assert.ok(store.createRoom(ROOM));
    await store.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Verwaiste Uploads werden nach einer Weile entsorgt', async () => {
  let now = 5_000_000;
  const { store, dataDir, cleanup } = tempStore(() => now);
  try {
    await store.init();
    const room = store.createRoom(ROOM);
    const { member } = store.joinRoom(room, null);
    const orphan = await store.putBlob(room, Buffer.from('nie-verwendet'));
    const used = await store.putBlob(room, Buffer.from('verwendet'));
    store.appendMessage(room, member, 'ct', [used.id]);

    now += 31 * 60 * 1000;
    store.sweepOrphanBlobs(room);
    assert.equal(room.blobs.has(orphan.id), false);
    assert.equal(room.blobs.has(used.id), true);
    assert.equal(room.blobBytes, used.size);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fs.existsSync(path.join(dataDir, 'blobs', ROOM, `${orphan.id}.bin`)), false);
  } finally {
    await store.close();
    cleanup();
  }
});

test('Das Speicherkontingent eines Raums wird durchgesetzt', async () => {
  const { store, cleanup } = tempStore();
  try {
    await store.init();
    const room = store.createRoom(ROOM);
    room.blobBytes = config.maxRoomBlobBytes - 10;
    await assert.rejects(() => store.putBlob(room, Buffer.alloc(100)), /Speicherplatz/);
  } finally {
    await store.close();
    cleanup();
  }
});

test('Lesestand kann nur vorwaerts laufen', async () => {
  const { store, cleanup } = tempStore();
  try {
    await store.init();
    const room = store.createRoom(ROOM);
    const { member } = store.joinRoom(room, null);
    store.appendMessage(room, member, 'a');
    store.appendMessage(room, member, 'b');
    assert.equal(store.markRead(room, member, 2), 2);
    assert.equal(store.markRead(room, member, 1), 2, 'darf nicht zurueckspringen');
    assert.equal(store.markRead(room, member, 99), 2, 'darf nicht ueber den Stand hinaus');
    assert.equal(store.markRead(room, member, 'quatsch'), 2);
  } finally {
    await store.close();
    cleanup();
  }
});

test('Room.fromJSON verkraftet Muell', () => {
  assert.equal(Room.fromJSON(null), null);
  assert.equal(Room.fromJSON({ id: 'zu-kurz' }), null);
  const room = Room.fromJSON({ id: ROOM, members: [{ id: 'x' }, null], messages: 'kein array' });
  assert.ok(room);
  assert.equal(room.members.size, 0, 'Mitglieder ohne Token werden verworfen');
  assert.deepEqual(room.messages, []);
});

test('Der Token-Bucket begrenzt und fuellt wieder auf', () => {
  const limiter = perMinute(3);
  let now = 0;
  assert.equal(limiter.take('ip', 1, now), true);
  assert.equal(limiter.take('ip', 1, now), true);
  assert.equal(limiter.take('ip', 1, now), true);
  assert.equal(limiter.take('ip', 1, now), false);
  assert.equal(limiter.retryAfter('ip', 1, now), 20);
  assert.equal(limiter.take('ip', 1, now + 20_000), true);
  assert.equal(limiter.take('andere-ip', 1, now), true, 'Schluessel sind unabhaengig');
});

test('Ungenutzte Buckets werden aufgeraeumt', () => {
  const limiter = new RateLimiter({ capacity: 5, refillPerMs: 1 / 1000, idleMs: 1000 });
  limiter.take('a', 1, 0);
  limiter.sweep(500);
  assert.equal(limiter.buckets.size, 1);
  limiter.sweep(2000);
  assert.equal(limiter.buckets.size, 0);
});
