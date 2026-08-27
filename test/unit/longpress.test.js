/**
 * onLongPress ohne Browser.
 *
 * Zwei Dinge lassen sich mit Playwright nicht prüfen, weil Chromium bei
 * Touch-Emulation immer "pointer: coarse" meldet: der selectstart-Wächter,
 * der genau für Notebooks mit Touchscreen gedacht ist (Hauptzeiger Maus,
 * trotzdem ein Finger auf dem Glas), und das genaue Verhalten des Fanghakens
 * für den Geisterklick. Beides hängt an wenigen Zeilen, deren Fehlverhalten
 * die Oberfläche für einen Moment taub macht - das gehört abgedeckt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// --- Ein Minimal-Browser, gerade genug für ui.js ---------------------------

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn, options) {
      const capture = options === true || options?.capture === true;
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ fn, capture });
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      const index = list.findIndex((entry) => entry.fn === fn);
      if (index >= 0) list.splice(index, 1);
    },
    listenerCount(type) { return (listeners.get(type) ?? []).length; },
    fire(type, props = {}) {
      const event = {
        type,
        button: 0,
        clientX: 0,
        clientY: 0,
        defaultPrevented: false,
        propagationStopped: false,
        ...props,
      };
      event.preventDefault = () => { event.defaultPrevented = true; };
      event.stopPropagation = () => { event.propagationStopped = true; };
      for (const entry of [...(listeners.get(type) ?? [])]) entry.fn(event);
      return event;
    },
  };
}

const fensterListener = eventTarget();
globalThis.window = {
  addEventListener: fensterListener.addEventListener,
  removeEventListener: fensterListener.removeEventListener,
};
globalThis.document = { getElementById: () => null, documentElement: {} };
// navigator ist in Node schreibgeschützt - also die Eigenschaft ersetzen.
Object.defineProperty(globalThis, 'navigator', {
  value: { vibrate: () => true },
  configurable: true,
  writable: true,
});

const { onLongPress } = await import('../../public/js/ui.js');

const warte = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ein Knopf, auf dem gedrückt wird - plus Zähler für die Aufrufe. */
function aufbau({ delay = 5 } = {}) {
  const node = eventTarget();
  const aufrufe = [];
  const ab = onLongPress(node, (event) => aufrufe.push(event.type), { delay });
  return { node, aufrufe, ab };
}

// --- selectstart -----------------------------------------------------------

test('Mit dem Finger wird das Markieren unterbunden', async () => {
  const { node } = aufbau();
  node.fire('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
  const event = node.fire('selectstart');
  assert.equal(event.defaultPrevented, true, 'die Markierung wurde nicht verhindert');
});

test('Mit der Maus bleibt das Markieren erlaubt', async () => {
  const { node } = aufbau();
  node.fire('pointerdown', { pointerType: 'mouse', clientX: 10, clientY: 10 });
  const event = node.fire('selectstart');
  assert.equal(event.defaultPrevented, false, 'am Schreibtisch darf markiert werden');
});

test('Nach dem Loslassen ist der Wächter wieder aus dem Weg', async () => {
  const { node } = aufbau();
  node.fire('pointerdown', { pointerType: 'touch' });
  node.fire('pointerup', { pointerType: 'touch' });
  const event = node.fire('selectstart');
  assert.equal(event.defaultPrevented, false, 'ohne Finger am Knopf darf markiert werden');
});

// --- Fanghaken für den Geisterklick ---------------------------------------

test('Der Klick zur gehaltenen Stelle wird geschluckt', async () => {
  const { node, aufrufe } = aufbau();
  node.fire('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 200 });
  await warte(20);
  assert.deepEqual(aufrufe, ['pointerdown'], 'das lange Drücken hat nicht ausgelöst');
  node.fire('pointerup', { pointerType: 'touch', clientX: 100, clientY: 200 });

  const event = fensterListener.fire('click', { clientX: 104, clientY: 197 });
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
});

test('Ein Klick woanders bleibt unangetastet', async () => {
  const { node } = aufbau();
  node.fire('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 200 });
  await warte(20);
  node.fire('pointerup', { pointerType: 'touch' });

  const event = fensterListener.fire('click', { clientX: 400, clientY: 600 });
  assert.equal(event.defaultPrevented, false, 'ein fremder Klick wurde verschluckt');
});

test('Kommt gar kein Klick, verschwindet der Fanghaken von selbst', async () => {
  const { node } = aufbau();
  const vorher = fensterListener.listenerCount('click');
  node.fire('pointerdown', { pointerType: 'touch', clientX: 5, clientY: 5 });
  await warte(20);
  node.fire('pointerup', { pointerType: 'touch' });
  assert.equal(fensterListener.listenerCount('click'), vorher + 1);
  // Der Fanghaken hält sich nur kurz - danach ist die Oberfläche wieder frei.
  await warte(450);
  assert.equal(fensterListener.listenerCount('click'), vorher, 'der Fanghaken blieb hängen');
});

test('Der bloße Mauszeiger schärft keinen Fanghaken', async () => {
  const { node } = aufbau();
  node.fire('pointerdown', { pointerType: 'mouse', clientX: 50, clientY: 50 });
  await warte(20);
  node.fire('pointerup', { pointerType: 'mouse', clientX: 50, clientY: 50 });
  fensterListener.fire('click', { clientX: 50, clientY: 50 });

  // Jetzt nur noch mit dem Zeiger darüber und wieder weg - ohne Taste.
  const vorher = fensterListener.listenerCount('click');
  node.fire('pointerleave', { pointerType: 'mouse' });
  assert.equal(fensterListener.listenerCount('click'), vorher, 'Überfahren hat einen Fanghaken gesetzt');
});

// --- Kontextmenü -----------------------------------------------------------

test('Nach einem Langdruck mit dem Finger wird ein Kontextmenü verschluckt', async () => {
  const { node, aufrufe } = aufbau();
  node.fire('pointerdown', { pointerType: 'touch' });
  await warte(20);
  assert.deepEqual(aufrufe, ['pointerdown']);
  node.fire('contextmenu');
  assert.deepEqual(aufrufe, ['pointerdown'], 'das Menü wurde ein zweites Mal geöffnet');
  // Aber nur genau eines.
  node.fire('contextmenu');
  assert.deepEqual(aufrufe, ['pointerdown', 'contextmenu']);
});

test('Nach einem Langdruck mit der Maus öffnet die rechte Taste sofort wieder', async () => {
  const { node, aufrufe } = aufbau();
  node.fire('pointerdown', { pointerType: 'mouse' });
  await warte(20);
  node.fire('pointerup', { pointerType: 'mouse' });
  assert.deepEqual(aufrufe, ['pointerdown']);
  // Ein langer Druck mit der Maus erzeugt gar kein Kontextmenü - es gibt also
  // nichts zu unterdrücken, und der Rechtsklick muss sofort greifen.
  node.fire('contextmenu', { button: 2 });
  assert.deepEqual(aufrufe, ['pointerdown', 'contextmenu']);
});

test('Ein Rechtsklick ohne vorheriges Drücken öffnet das Menü', async () => {
  const { node, aufrufe } = aufbau();
  node.fire('pointerdown', { pointerType: 'mouse', button: 2 });
  const event = node.fire('contextmenu', { button: 2 });
  assert.deepEqual(aufrufe, ['contextmenu']);
  assert.equal(event.defaultPrevented, true, 'das Browsermenü blieb offen');
});

// --- Abbrechen -------------------------------------------------------------

test('Wer den Finger bewegt, löst nicht aus', async () => {
  const { node, aufrufe } = aufbau();
  node.fire('pointerdown', { pointerType: 'touch', clientX: 0, clientY: 0 });
  node.fire('pointermove', { pointerType: 'touch', clientX: 40, clientY: 0 });
  await warte(20);
  assert.deepEqual(aufrufe, [], 'trotz Wischen ausgelöst');
});

test('Abmelden nimmt alle Listener wieder mit', async () => {
  const node = eventTarget();
  const ab = onLongPress(node, () => {});
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave', 'contextmenu', 'selectstart']) {
    assert.equal(node.listenerCount(type), 1, `${type} fehlt`);
  }
  ab();
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave', 'contextmenu', 'selectstart']) {
    assert.equal(node.listenerCount(type), 0, `${type} blieb hängen`);
  }
});
