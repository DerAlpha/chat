/**
 * Einmal-Plaetze: das Rueckgrat der Gruppen.
 *
 * Eine Gruppe wird angelegt, indem fuer jede Person ein eigener Code erzeugt
 * wird. Der Server sieht davon nur eine Kennung je Platz und ein verpacktes
 * Paket, das er nicht oeffnen kann. Wer den passenden Code hat, loest seinen
 * Platz ein - genau einmal.
 *
 * Was hier geprueft wird, ist der Teil, den der Server garantieren muss:
 * dass ein Platz nicht zweimal vergeben wird, dass die Raum-ID allein
 * niemanden hereinlaesst, und dass ein abgerissener Verbindungsversuch
 * niemanden aussperrt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../server/store.js';
import { config } from '../../server/config.js';

/** Eine Kennung in der Form, die der Server verlangt: 22 Zeichen base64url. */
let zaehler = 0;
const kennung = (name) => (name + 'x'.repeat(22)).slice(0, 22).replace(/[^A-Za-z0-9_-]/g, '_');
const frischeKennung = () => kennung(`platz${(zaehler += 1)}`);

async function frischerStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluesterchat-slots-'));
  const store = new Store({ dataDir: dir });
  await store.init();
  return { store, dir, weg: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Legt eine Gruppe mit n Plaetzen an. */
function gruppe(store, n) {
  const raumId = kennung('raum' + (zaehler += 1));
  const plaetze = Array.from({ length: n }, () => ({ id: frischeKennung(), wrapped: 'verpacktes-paket' }));
  const room = store.createRoom(raumId, { slots: plaetze });
  return { room, plaetze };
}

test('Ein Raum ohne Plaetze bleibt ein Zweierchat', async () => {
  const { store, weg } = await frischerStore();
  try {
    const room = store.createRoom(kennung('einzel'));
    assert.equal(room.capacity, 2);
    assert.equal(room.slots.size, 0);
  } finally {
    weg();
  }
});

test('Eine Gruppe hat einen Platz je Code, dazu den der anlegenden Person', async () => {
  const { store, weg } = await frischerStore();
  try {
    const { room } = gruppe(store, 4);
    assert.equal(room.slots.size, 4);
    assert.equal(room.capacity, 5);
  } finally {
    weg();
  }
});

test('Ein Platz laesst sich einloesen und liefert das verpackte Paket', async () => {
  const { store, weg } = await frischerStore();
  try {
    const { room, plaetze } = gruppe(store, 3);
    const ergebnis = store.claimSlot(plaetze[0].id);
    assert.equal(ergebnis.error, undefined);
    assert.equal(ergebnis.room.id, room.id);
    assert.equal(ergebnis.slot.wrapped, 'verpacktes-paket');
    assert.ok(ergebnis.member.token);
    assert.equal(room.members.size, 1);
  } finally {
    weg();
  }
});

/** Der Kern: ein Code ist einer. */
test('Ein verbrauchter Platz laesst sich nicht noch einmal einloesen', async () => {
  const { store, weg } = await frischerStore();
  try {
    const { room, plaetze } = gruppe(store, 2);
    const erster = store.claimSlot(plaetze[0].id);
    // Erst mit der Verbindung ist der Platz endgueltig weg.
    store.settleSlot(room, erster.member.id);

    const zweiter = store.claimSlot(plaetze[0].id);
    assert.equal(zweiter.error, 'slot_used');
    assert.equal(room.members.size, 1, 'es wurde ein zweiter Platz vergeben');
  } finally {
    weg();
  }
});

/**
 * Reisst die Leitung zwischen Einloesen und Verbinden ab, waere die Person
 * sonst fuer immer ausgesperrt - und der Platz fuer immer tot.
 */
test('Vor der ersten Verbindung darf man es noch einmal versuchen', async () => {
  const { store, weg } = await frischerStore();
  try {
    const { room, plaetze } = gruppe(store, 2);
    const erster = store.claimSlot(plaetze[0].id);
    const nochmal = store.claimSlot(plaetze[0].id);

    assert.equal(nochmal.error, undefined);
    assert.equal(nochmal.returning, true);
    // Dasselbe Mitglied, dasselbe Token - kein zweiter Platz.
    assert.equal(nochmal.member.id, erster.member.id);
    assert.equal(nochmal.member.token, erster.member.token);
    assert.equal(room.members.size, 1);
  } finally {
    weg();
  }
});

test('Eine unbekannte Platzkennung fuehrt nirgendwohin', async () => {
  const { store, weg } = await frischerStore();
  try {
    gruppe(store, 2);
    assert.equal(store.claimSlot(kennung('gibtsnicht')).error, 'slot_unknown');
  } finally {
    weg();
  }
});

/**
 * Der Fund aus der Architekturpruefung: bisher belegte jeder, der die Raum-ID
 * kannte, einfach einen Platz. Bei zwei Personen ein enges Fenster, bei
 * zwoelf eine offene Tuer.
 */
test('Die Raum-ID allein laesst niemanden in eine Gruppe', async () => {
  const { store, weg } = await frischerStore();
  try {
    const { room } = gruppe(store, 5);
    const ergebnis = store.joinRoom(room, null);
    assert.equal(ergebnis.error, 'need_slot');
    assert.equal(room.members.size, 0);
  } finally {
    weg();
  }
});

test('Ein Zweierchat kommt weiterhin ohne Platz aus', async () => {
  const { store, weg } = await frischerStore();
  try {
    const room = store.createRoom(kennung('einzel2'));
    assert.equal(store.joinRoom(room, null).error, undefined);
    assert.equal(store.joinRoom(room, null).error, undefined);
    // Und der dritte ist einer zu viel.
    assert.equal(store.joinRoom(room, null).error, 'room_full');
  } finally {
    weg();
  }
});

test('Mit seinem Token kehrt ein Gruppenmitglied zurueck', async () => {
  const { store, weg } = await frischerStore();
  try {
    const { room, plaetze } = gruppe(store, 3);
    const beigetreten = store.claimSlot(plaetze[1].id);
    store.settleSlot(room, beigetreten.member.id);

    const zurueck = store.joinRoom(room, beigetreten.member.token);
    assert.equal(zurueck.error, undefined);
    assert.equal(zurueck.returning, true);
    assert.equal(zurueck.member.id, beigetreten.member.id);
    assert.equal(room.members.size, 1);
  } finally {
    weg();
  }
});

test('Jeder Platz fuehrt zu einem eigenen Mitglied', async () => {
  const { store, weg } = await frischerStore();
  try {
    const { room, plaetze } = gruppe(store, 4);
    const mitglieder = plaetze.map((platz) => {
      const ergebnis = store.claimSlot(platz.id);
      store.settleSlot(room, ergebnis.member.id);
      return ergebnis.member;
    });
    assert.equal(room.members.size, 4);
    assert.equal(new Set(mitglieder.map((m) => m.id)).size, 4);
    assert.equal(new Set(mitglieder.map((m) => m.token)).size, 4);
  } finally {
    weg();
  }
});

/**
 * Wer die Gruppe anlegt, hat selbst keinen Code - er hat die Codes ja gerade
 * erst fuer die anderen erzeugt. Ohne einen eigenen Weg hinein waere er aus
 * seiner eigenen Gruppe ausgesperrt.
 */
test('Wer die Gruppe anlegt, bekommt seinen Platz beim Anlegen', async () => {
  const { store, weg } = await frischerStore();
  try {
    const { room, plaetze } = gruppe(store, 3);
    const anleger = store.seatCreator(room);
    assert.ok(anleger?.token);
    assert.equal(room.members.size, 1);

    // Mit seinem Token kommt er wieder herein ...
    assert.equal(store.joinRoom(room, anleger.token).returning, true);
    // ... ohne Token weiterhin niemand.
    assert.equal(store.joinRoom(room, null).error, 'need_slot');

    // Und alle Codes sind noch frei: sein Platz ist der zusaetzliche.
    for (const platz of plaetze) {
      assert.equal(store.claimSlot(platz.id).error, undefined);
    }
    assert.equal(room.members.size, 4);
    assert.equal(room.capacity, 4);
  } finally {
    weg();
  }
});

test('Ein zweites Mal wird der Platz des Anlegers nicht vergeben', async () => {
  const { store, weg } = await frischerStore();
  try {
    const { room } = gruppe(store, 2);
    assert.ok(store.seatCreator(room));
    assert.equal(store.seatCreator(room), null, 'der Platz wurde zweimal vergeben');
    assert.equal(room.members.size, 1);
  } finally {
    weg();
  }
});

test('In einem Zweierchat gibt es keinen Platz des Anlegers', async () => {
  const { store, weg } = await frischerStore();
  try {
    const room = store.createRoom(kennung('einzel3'));
    assert.equal(store.seatCreator(room), null);
    assert.equal(room.members.size, 0);
  } finally {
    weg();
  }
});

test('Zwei gleiche Platzkennungen werden abgelehnt', async () => {
  const { store, weg } = await frischerStore();
  try {
    const doppelt = frischeKennung();
    assert.throws(
      () => store.createRoom(kennung('doppel'), { slots: [{ id: doppelt, wrapped: 'a' }, { id: doppelt, wrapped: 'b' }] }),
      (fehler) => fehler.code === 'slot_exists',
    );
  } finally {
    weg();
  }
});

test('Eine Platzkennung aus einer anderen Gruppe wird abgelehnt', async () => {
  const { store, weg } = await frischerStore();
  try {
    const { plaetze } = gruppe(store, 1);
    assert.throws(
      () => store.createRoom(kennung('zweite'), { slots: [{ id: plaetze[0].id, wrapped: 'x' }] }),
      (fehler) => fehler.code === 'slot_exists',
    );
  } finally {
    weg();
  }
});

test('Eine zu grosse Gruppe wird abgelehnt', async () => {
  const { store, weg } = await frischerStore();
  try {
    const zuviele = Array.from({ length: config.maxRoomCapacity }, () => ({ id: frischeKennung(), wrapped: 'x' }));
    assert.throws(() => store.createRoom(kennung('riesig'), { slots: zuviele }), (fehler) => fehler.code === 'too_many_slots');
  } finally {
    weg();
  }
});

test('Unsinnige Plaetze werden abgelehnt', async () => {
  const { store, weg } = await frischerStore();
  try {
    const wirft = (slots) => {
      let gefangen = null;
      try { store.createRoom(kennung('a' + (zaehler += 1)), { slots }); } catch (fehler) { gefangen = fehler; }
      return gefangen?.code ?? null;
    };
    assert.equal(wirft([{ id: 'zu-kurz', wrapped: 'x' }]), 'bad_slot_id');
    assert.equal(wirft([{ id: frischeKennung(), wrapped: '' }]), 'bad_slot');
    assert.equal(wirft([{ id: frischeKennung(), wrapped: 'x'.repeat(config.maxWrappedKeyChars + 1) }]), 'bad_slot');
  } finally {
    weg();
  }
});

test('Plaetze ueberleben einen Neustart des Servers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluesterchat-slots-'));
  try {
    const ersterStore = new Store({ dataDir: dir });
    await ersterStore.init();
    const { room, plaetze } = gruppe(ersterStore, 3);
    const raumId = room.id;
    const beigetreten = ersterStore.claimSlot(plaetze[0].id);
    ersterStore.settleSlot(room, beigetreten.member.id);
    await ersterStore.close();

    const zweiterStore = new Store({ dataDir: dir });
    await zweiterStore.init();
    const wieder = zweiterStore.getRoom(raumId);
    assert.ok(wieder, 'der Raum ist beim Neustart verlorengegangen');
    assert.equal(wieder.capacity, 4);
    assert.equal(wieder.slots.size, 3);
    // Der verbrauchte Platz bleibt verbraucht ...
    assert.equal(zweiterStore.claimSlot(plaetze[0].id).error, 'slot_used');
    // ... und ein unbenutzter laesst sich weiterhin einloesen.
    assert.equal(zweiterStore.claimSlot(plaetze[1].id).error, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Mit dem Raum verschwinden auch seine Plaetze', async () => {
  const { store, weg } = await frischerStore();
  try {
    const { room, plaetze } = gruppe(store, 2);
    await store.deleteRoom(room.id, 'test');
    assert.equal(store.claimSlot(plaetze[0].id).error, 'slot_unknown');
    assert.equal(store.slotIndex.size, 0);
  } finally {
    weg();
  }
});
