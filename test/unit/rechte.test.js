/**
 * Rechte in Gruppen, das Nachlegen von Plaetzen und das Verlassen.
 *
 * Alles drei entscheidet der Server - hier wird nachgeprueft, dass er es
 * auch dann entscheidet, wenn die Oberflaeche gar nicht gefragt hat.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, Room, BadRequest } from '../../server/store.js';

function tempStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluesterchat-rechte-'));
  const store = new Store({ dataDir });
  return { store, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const platz = (n) => ({ id: `${'B'.repeat(21)}${n}`, wrapped: 'x'.repeat(40) });

/** Eine Gruppe mit Anleger und einem beigetretenen Mitglied. */
function gruppe(store) {
  const room = store.createRoom(ROOM, { slots: [platz('1'), platz('2')] });
  const anleger = store.seatCreator(room);
  const { member } = store.claimSlot(platz('1').id);
  return { room, anleger, member };
}

test('Wer die Gruppe anlegt, ist Verwalter - wer beitritt, nicht', () => {
  const { store, cleanup } = tempStore();
  try {
    const { anleger, member } = gruppe(store);
    assert.equal(anleger.role, 'admin');
    assert.equal(member.role, 'member');
  } finally {
    cleanup();
  }
});

test('Nur ein Verwalter darf Rechte vergeben', () => {
  const { store, cleanup } = tempStore();
  try {
    const { room, anleger, member } = gruppe(store);
    assert.throws(() => store.setRole(room, member, anleger.id, 'member'), BadRequest);
    // Und der Anleger ist danach immer noch Verwalter.
    assert.equal(room.members.get(anleger.id).role, 'admin');

    store.setRole(room, anleger, member.id, 'admin');
    assert.equal(room.members.get(member.id).role, 'admin');
  } finally {
    cleanup();
  }
});

test('Der letzte Verwalter kann sich seine Rechte nicht selbst nehmen', () => {
  const { store, cleanup } = tempStore();
  try {
    const { room, anleger, member } = gruppe(store);
    assert.throws(() => store.setRole(room, anleger, anleger.id, 'member'), /Verwalter/);
    // Zu zweit geht es: dann bleibt ja noch einer.
    store.setRole(room, anleger, member.id, 'admin');
    store.setRole(room, anleger, anleger.id, 'member');
    assert.equal(room.members.get(anleger.id).role, 'member');
  } finally {
    cleanup();
  }
});

test('Plaetze lassen sich nachlegen - aber nicht ueber die Obergrenze', () => {
  const { store, cleanup } = tempStore();
  try {
    const { room } = gruppe(store);
    assert.equal(room.capacity, 3);
    assert.equal(store.addSlots(room, [platz('3')]), 4);
    assert.equal(room.slots.size, 3);

    // Dieselbe Kennung ein zweites Mal waere ein zweiter Zugang mit demselben Code.
    assert.throws(() => store.addSlots(room, [platz('3')]), /vergeben/);

    const zuviele = Array.from({ length: 40 }, (unused, i) => ({ id: `${'C'.repeat(20)}${String(i).padStart(2, '0')}`, wrapped: 'x' }));
    assert.throws(() => store.addSlots(room, zuviele), /gross/);
  } finally {
    cleanup();
  }
});

test('Wer geht, hinterlaesst Grabsteine statt Nachrichten', () => {
  const { store, cleanup } = tempStore();
  try {
    const { room, anleger, member } = gruppe(store);
    const meine = store.appendMessage(room, member, 'geheim-1', []);
    store.appendMessage(room, anleger, 'bleibt', []);

    const { empty } = store.leaveRoom(room, member);
    assert.equal(empty, false);
    const grabstein = room.messages.find((m) => m.id === meine.id);
    assert.equal(grabstein.gone, true);
    assert.equal(grabstein.deleted, true);
    assert.equal(grabstein.ct, '');
    // Die Nachricht des anderen ist unangetastet.
    assert.equal(room.messages.find((m) => m.from === anleger.id).ct, 'bleibt');
    // Und der Gegangene zaehlt nicht mehr mit.
    assert.equal(store.activeMembers(room).length, 1);
    assert.equal(room.members.get(member.id).nickCt, null);
  } finally {
    cleanup();
  }
});

test('Geht der Letzte, ist der Raum leer', () => {
  const { store, cleanup } = tempStore();
  try {
    const { room, anleger, member } = gruppe(store);
    assert.equal(store.leaveRoom(room, member).empty, false);
    assert.equal(store.leaveRoom(room, anleger).empty, true);
    // Ein zweites Mal aendert nichts mehr.
    assert.equal(store.leaveRoom(room, anleger).alreadyGone, true);
  } finally {
    cleanup();
  }
});

test('Ein Gegangener bekommt keine Rechte mehr', () => {
  const { store, cleanup } = tempStore();
  try {
    const { room, anleger, member } = gruppe(store);
    store.leaveRoom(room, member);
    assert.throws(() => store.setRole(room, anleger, member.id, 'admin'), /Mitglied/);
  } finally {
    cleanup();
  }
});

test('Rollen ueberleben das Speichern und Laden', () => {
  const { store, cleanup } = tempStore();
  try {
    const { room, anleger, member } = gruppe(store);
    store.leaveRoom(room, member);
    const kopie = JSON.parse(JSON.stringify(room.toJSON()));
    const geladen = Room.fromJSON(kopie);
    assert.equal(geladen.members.get(anleger.id).role, 'admin');
    assert.equal(geladen.members.get(member.id).left, true);
  } finally {
    cleanup();
  }
});

test('Wer gegangen ist, kommt mit seinem alten Token nicht zurueck', () => {
  const { store, cleanup } = tempStore();
  try {
    const { room, member } = gruppe(store);
    store.leaveRoom(room, member);
    const zurueck = store.joinRoom(room, member.token);
    // Kein Wiedereinstieg: in einer Gruppe braucht es einen Platz, und der
    // alte ist verbraucht.
    assert.equal(zurueck.returning, undefined);
    assert.equal(zurueck.error, 'need_slot');
  } finally {
    cleanup();
  }
});

test('Geht der letzte Verwalter, rueckt jemand nach', () => {
  const { store, cleanup } = tempStore();
  try {
    const { room, anleger, member } = gruppe(store);
    assert.equal(store.adminCount(room), 1);
    store.leaveRoom(room, anleger);
    // Sonst waere die Gruppe fuehrungslos - niemand koennte sie je wieder
    // erweitern oder ihr Bild aendern.
    assert.equal(room.members.get(member.id).role, 'admin');
    assert.equal(store.adminCount(room), 1);
  } finally {
    cleanup();
  }
});

test('In einem Zweiergespraech rueckt niemand nach - dort gibt es keine Rollen', () => {
  const { store, cleanup } = tempStore();
  try {
    const room = store.createRoom(ROOM);
    const { member: eins } = store.joinRoom(room, null);
    const { member: zwei } = store.joinRoom(room, null);
    store.leaveRoom(room, eins);
    assert.equal(room.members.get(zwei.id).role, 'member');
  } finally {
    cleanup();
  }
});
