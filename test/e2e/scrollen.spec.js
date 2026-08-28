/**
 * Wohin die Ansicht springt - und wohin nicht.
 *
 * Zwei Dinge, die im Alltag sofort auffallen: ein Chat muss sich bei der
 * neuesten Nachricht öffnen, und ein Wisch auf der Textzeile darf einen
 * nicht aus dem Chat schieben.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat, joinChat, makePng } from './helpers.js';

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

/** Wie weit ist die Liste vom unteren Ende entfernt? */
const abstandUnten = (seite) => seite.evaluate(() => {
  const liste = document.getElementById('messages');
  return Math.round(liste.scrollHeight - liste.scrollTop - liste.clientHeight);
});

/**
 * Ein langer Chat mit Bildern dazwischen - Bilder deshalb, weil sie ihre
 * Höhe erst beim Laden bekommen und alles darunter nach unten schieben.
 */
async function langerChat(browser) {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });

  for (let runde = 0; runde < 4; runde += 1) {
    for (let i = 0; i < 5; i += 1) {
      await seiteA.locator('#message-input')
        .fill(`Nachricht ${runde}-${i}, lang genug, dass sie über mehrere Zeilen geht und Höhe braucht`);
      await seiteA.locator('#btn-send').click();
    }
    await seiteA.locator('#file-gallery')
      .setInputFiles({ name: `bild${runde}.png`, mimeType: 'image/png', buffer: makePng(900, 600) });
    await expect(seiteA.locator('#attachments .attachment')).toHaveCount(1, { timeout: 15_000 });
    await seiteA.locator('#btn-send').click();
    await expect(seiteA.locator('#attachments')).toBeHidden({ timeout: 20_000 });
  }
  await expect(seiteB.locator('#messages .msg:not(.msg--typing)')).toHaveCount(24, { timeout: 60_000 });
  return { kontextA, kontextB, seiteA, seiteB };
}

test('Ein längerer Chat öffnet sich bei der neuesten Nachricht', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await langerChat(browser);
  // Zum Schluss lauter Bilder: sie sind hoch, und damit ist die Ansicht
  // beim Oeffnen wirklich lang - nur dann faellt auf, ob ans Ende gesprungen
  // oder dorthin gescrollt wird.
  for (let i = 0; i < 5; i += 1) {
    await seiteA.locator('#file-gallery')
      .setInputFiles({ name: `zum-schluss${i}.png`, mimeType: 'image/png', buffer: makePng(900, 700) });
    await expect(seiteA.locator('#attachments .attachment')).toHaveCount(1, { timeout: 15_000 });
    await seiteA.locator('#btn-send').click();
    await expect(seiteA.locator('#attachments')).toBeHidden({ timeout: 20_000 });
  }
  await expect(seiteB.locator('#messages .msg:not(.msg--typing)')).toHaveCount(29, { timeout: 60_000 });

  // Frisch laden und aus der Liste öffnen - so, wie man es morgens tut.
  await seiteB.reload();
  const eintrag = seiteB.locator('#chat-list .chat-list__item').first();
  await expect(eintrag).toBeVisible({ timeout: 25_000 });
  await eintrag.click();
  await expect(seiteB.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });

  // Unten - und zwar dauerhaft. Waehrend die Bilder ihre Hoehe bekommen,
  // zieht die App nach; danach muss es liegen bleiben.
  await expect.poll(() => abstandUnten(seiteB), { timeout: 10_000 }).toBeLessThanOrEqual(4);
  for (let i = 0; i < 10; i += 1) {
    await seiteB.waitForTimeout(250);
    expect(await abstandUnten(seiteB), `nach ${(i + 1) * 250} ms nicht mehr unten`).toBeLessThanOrEqual(4);
  }
  // Die neueste Nachricht steht im Bild, und der Sprungknopf hat nichts zu tun.
  await expect(seiteB.locator('#messages .msg:not(.msg--typing)').last()).toBeInViewport();
  await expect(seiteB.locator('#jump-down')).toBeHidden();
  // Und der Verlauf wurde nicht gleich mit hereingezogen: Aelteres kommt
  // erst, wenn jemand danach sucht.
  const geladen = await seiteB.locator('#messages .msg:not(.msg--typing)').count();
  expect(geladen, 'beim Oeffnen wurde der ganze Verlauf geladen').toBeLessThan(29);

  // Und es war ein Sprung, keine Reise: eine weiche Bewegung durch den
  // ganzen Verlauf sähe man an einer Reihe von Zwischenständen - und genau
  // die blieb früher unterwegs stehen, sobald sich die Höhe änderte.
  await seiteB.reload();
  const nochmal = seiteB.locator('#chat-list .chat-list__item').first();
  await expect(nochmal).toBeVisible({ timeout: 25_000 });
  const stufen = await seiteB.evaluate(() => new Promise((fertig) => {
    const liste = document.getElementById('messages');
    const gesehen = new Set();
    const messen = () => gesehen.add(Math.round(liste.scrollTop));
    const takt = setInterval(messen, 16);
    document.querySelector('#chat-list .chat-list__item').click();
    setTimeout(() => {
      clearInterval(takt);
      fertig([...gesehen]);
    }, 900);
  }));
  expect(stufen.length, `Zwischenstände: ${stufen.join(', ')}`).toBeLessThanOrEqual(3);

  await kontextA.close();
  await kontextB.close();
});

/**
 * Am Handy sitzt die Textzeile ganz unten. Wischt man dort - weil man
 * eigentlich den Verlauf bewegen wollte -, darf sich nicht die ganze Seite
 * verschieben und den Chat aus dem Bild tragen.
 */
test('Ein Wisch auf der Textzeile verschiebt die App nicht', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });

  // Etwas Text, damit es überhaupt etwas zu verschieben gäbe.
  for (let i = 0; i < 12; i += 1) {
    await seiteA.locator('#message-input').fill(`Zeile ${i} mit genug Text, damit die Liste über den Bildschirm hinausgeht`);
    await seiteA.locator('#btn-send').click();
  }
  await expect(seiteA.locator('#messages .msg:not(.msg--typing)')).toHaveCount(12, { timeout: 30_000 });

  const feld = seiteA.locator('#message-input');
  const kasten = await feld.boundingBox();
  const vorher = await seiteA.evaluate(() => ({
    app: Math.round(document.getElementById('app').getBoundingClientRect().top),
    kopf: Math.round(document.querySelector('.chat-header').getBoundingClientRect().top),
    doc: document.scrollingElement.scrollTop,
  }));

  // Ein echter Wisch auf dem Eingabefeld, von unten nach oben.
  const sitzung = await seiteA.context().newCDPSession(seiteA);
  const x = kasten.x + kasten.width / 2;
  const start = kasten.y + kasten.height / 2;
  await sitzung.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x, y: start }],
  });
  for (const schritt of [30, 70, 120, 180, 240]) {
    await sitzung.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x, y: start - schritt }],
    });
    await seiteA.waitForTimeout(16);
  }
  await sitzung.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await seiteA.waitForTimeout(500);

  const nachher = await seiteA.evaluate(() => ({
    app: Math.round(document.getElementById('app').getBoundingClientRect().top),
    kopf: Math.round(document.querySelector('.chat-header').getBoundingClientRect().top),
    doc: document.scrollingElement.scrollTop,
    scrollbar: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight,
  }));

  // Die Bewegung bleibt im Eingabefeld, statt nach aussen weitergereicht zu
  // werden - und die Seite selbst hat gar nichts zu scrollen.
  const regeln = await seiteA.evaluate(() => ({
    feld: getComputedStyle(document.getElementById('message-input')).overscrollBehaviorY,
    seite: getComputedStyle(document.body).overflowY,
  }));
  expect(regeln.feld, 'der Wisch wandert aus dem Eingabefeld hinaus').toBe('contain');
  expect(regeln.seite, 'die Seite selbst darf nicht scrollen').toBe('hidden');

  expect(nachher.app, 'die App ist verrutscht').toBe(vorher.app);
  expect(nachher.kopf, 'die Kopfzeile ist verrutscht').toBe(vorher.kopf);
  expect(nachher.doc, 'die Seite selbst wurde gescrollt').toBe(0);
  // Und sie kann es auch gar nicht: die Seite hat nichts zu scrollen.
  expect(nachher.scrollbar, 'die Seite ist überhaupt scrollbar').toBeLessThanOrEqual(0);
  // Die Kopfzeile steht noch da, der Chat ist nicht weggerutscht.
  await expect(seiteA.locator('.chat-header')).toBeInViewport();

  await kontextA.close();
  await kontextB.close();
});

/**
 * Ein Bild bekommt seine Höhe erst, wenn es geladen ist - und schiebt damit
 * alles darunter nach unten. Wer am Ende stand, muss am Ende bleiben, sonst
 * rutscht einem die gerade eingetroffene Nachricht wieder aus dem Bild.
 */
test('Ein eintreffendes Bild schiebt einen nicht vom Ende weg', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });

  for (let i = 0; i < 8; i += 1) {
    await seiteA.locator('#message-input').fill(`Zeile ${i}, lang genug für mehrere Zeilen im Fenster des Gegenübers`);
    await seiteA.locator('#btn-send').click();
  }
  await expect(seiteB.locator('#messages .msg:not(.msg--typing)')).toHaveCount(8, { timeout: 30_000 });
  expect(await abstandUnten(seiteB)).toBeLessThanOrEqual(4);

  // Jetzt ein hohes Bild - B sieht gerade hin und steht unten.
  await seiteA.locator('#file-gallery')
    .setInputFiles({ name: 'gross.png', mimeType: 'image/png', buffer: makePng(900, 1200) });
  await expect(seiteA.locator('#attachments .attachment')).toHaveCount(1, { timeout: 15_000 });
  await seiteA.locator('#btn-send').click();

  await expect(seiteB.locator('#messages img.bubble__image')).toHaveCount(1, { timeout: 40_000 });
  // Auch nachdem das Bild wirklich da ist, steht B noch unten.
  await expect.poll(async () => seiteB.evaluate(() => {
    const bild = document.querySelector('#messages img.bubble__image');
    return bild?.naturalWidth ?? 0;
  }), { timeout: 30_000 }).toBeGreaterThan(10);
  await expect.poll(() => abstandUnten(seiteB), { timeout: 8000 }).toBeLessThanOrEqual(4);
  for (let i = 0; i < 6; i += 1) {
    await seiteB.waitForTimeout(250);
    expect(await abstandUnten(seiteB), `nach ${(i + 1) * 250} ms nicht mehr unten`).toBeLessThanOrEqual(4);
  }

  await kontextA.close();
  await kontextB.close();
});

/**
 * Dasselbe für alles andere, was nachträglich wächst: ältere Nachrichten
 * ohne hinterlegte Bildmaße, Schriften, Sprachnachrichten. Hier wird der
 * Fall nachgestellt, indem der Verlauf direkt nach dem Öffnen höher wird.
 */
test('Wächst der Verlauf nach dem Öffnen, bleibt die Ansicht unten', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  for (let i = 0; i < 6; i += 1) {
    await seiteA.locator('#message-input').fill(`Zeile ${i} im Verlauf`);
    await seiteA.locator('#btn-send').click();
  }
  await expect(seiteB.locator('#messages .msg:not(.msg--typing)')).toHaveCount(6, { timeout: 30_000 });

  await seiteB.reload();
  const eintrag = seiteB.locator('#chat-list .chat-list__item').first();
  await expect(eintrag).toBeVisible({ timeout: 25_000 });
  await eintrag.click();
  await expect(seiteB.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });

  // Kurz nach dem Öffnen wird eine Blase weiter oben höher - so, wie es ein
  // spät geladenes Bild täte.
  await seiteB.waitForTimeout(150);
  await seiteB.evaluate(() => {
    const erste = document.querySelector('#messages .msg:not(.msg--typing)');
    if (erste) erste.style.minHeight = '900px';
  });

  // Die App zieht nach - und laesst es danach so.
  await expect.poll(() => abstandUnten(seiteB), { timeout: 5000 }).toBeLessThanOrEqual(4);
  for (let i = 0; i < 5; i += 1) {
    await seiteB.waitForTimeout(250);
    expect(await abstandUnten(seiteB), `nach ${(i + 1) * 250} ms nicht mehr unten`).toBeLessThanOrEqual(4);
  }

  await kontextA.close();
  await kontextB.close();
});
