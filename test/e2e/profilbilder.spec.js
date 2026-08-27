/**
 * Profilbilder.
 *
 * Ein Bild ist eine Kleinigkeit - bis es die falsche Person sieht. Deshalb
 * wird hier beides geprüft: dass es beim Gegenüber ankommt, und dass es den
 * Server nur verschlüsselt passiert.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat, joinChat, withName, makePng } from './helpers.js';

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

/** Legt eine Gruppe an und gibt die Beitrittslinks zurueck. */
async function gruppeAnlegen(page, { name = 'Verein', count = 1, nick = 'Anton' } = {}) {
  await withName(page, nick);
  await page.goto('./');
  await page.getByRole('button', { name: /Gruppe erstellen/i }).click();
  await page.locator('#sheet input[type="text"]').fill(name);
  await page.locator('#group-size').fill(String(count));
  await page.locator('#sheet').getByRole('button', { name: /^Anlegen$/ }).click();
  await expect(page.locator('#screen-group')).toBeVisible({ timeout: 20_000 });
  const codes = await page.locator('#group-codes .invite-row__code').allInnerTexts();
  const basis = new URL(page.url());
  return codes.map((code) => `${basis.origin}${basis.pathname}#g:${encodeURIComponent(code.trim())}`);
}

/**
 * Waehlt ein Bild aus und schneidet es zu.
 *
 * @param {import('@playwright/test').Page} seite
 * @param {() => Promise<void>} oeffnen Was den Dateidialog ausloest.
 */
async function bildWaehlen(seite, oeffnen) {
  const [dialog] = await Promise.all([seite.waitForEvent('filechooser'), oeffnen()]);
  await dialog.setFiles({ name: 'foto.png', mimeType: 'image/png', buffer: makePng(400, 300) });
  const uebernehmen = seite.locator('#crop-apply');
  await expect(uebernehmen).toBeVisible({ timeout: 15_000 });
  await uebernehmen.click();
}

/** Setzt das eigene Bild ueber den Knopf in der Fusszeile. */
async function eigenesBildSetzen(seite) {
  await seite.locator('#btn-avatar').click();
  await bildWaehlen(seite, () => seite.getByRole('button', { name: /Bild auswählen/i }).click());
  await expect(seite.locator('#btn-avatar .avatar.has-image')).toBeVisible({ timeout: 15_000 });
}

test('Das eigene Bild kommt beim Gegenüber an', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  await withName(seiteA, 'Anton');
  await seiteA.goto('./');
  await eigenesBildSetzen(seiteA);

  const { link } = await createChat(seiteA, { nick: null });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });

  // Bei B steht jetzt Antons Bild in der Kopfzeile - kein Buchstabe mehr.
  const bild = seiteB.locator('#peer-avatar img.avatar__img');
  await expect(bild).toBeVisible({ timeout: 25_000 });
  const gross = await bild.evaluate((element) => ({ w: element.naturalWidth, h: element.naturalHeight }));
  expect(gross.w, 'das Bild ist nicht wirklich geladen').toBeGreaterThan(10);
  expect(gross.w).toBe(gross.h);

  // Und in der Liste auf der Startseite steht es auch.
  await seiteB.locator('#chat-back').click();
  await expect(seiteB.locator('#chat-list .avatar img.avatar__img')).toBeVisible({ timeout: 25_000 });

  await kontextA.close();
  await kontextB.close();
});

test('Ohne Bild bleibt der Anfangsbuchstabe stehen', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  await expect(seiteB.locator('#peer-avatar')).toHaveText('A', { timeout: 20_000 });
  await expect(seiteB.locator('#peer-avatar img')).toHaveCount(0);
  await kontextA.close();
  await kontextB.close();
});

/**
 * Der Server bekommt das Bild zu sehen - aber nur als Zahlensalat. Hier wird
 * mitgeschnitten, was wirklich über die Leitung geht.
 */
test('Das Bild verlässt das Gerät nur verschlüsselt', async ({ browser }) => {
  const kontext = await browser.newContext(HANDY);
  const seite = await kontext.newPage();
  const hochgeladen = [];
  await seite.route('**/api/rooms/*/avatar/*', async (route) => {
    if (route.request().method() === 'PUT') {
      hochgeladen.push(route.request().postDataBuffer());
    }
    return route.fallback();
  });

  await withName(seite, 'Anton');
  await seite.goto('./');
  // Erst das Bild, dann der Chat: hochgeladen wird es beim Betreten des
  // Raums - vorher gibt es keinen Schluessel, mit dem es verschluesselt
  // werden koennte.
  await eigenesBildSetzen(seite);
  await createChat(seite, { nick: null });

  await expect.poll(() => hochgeladen.length, { timeout: 25_000 }).toBeGreaterThan(0);
  const daten = hochgeladen[0];
  expect(daten.length).toBeGreaterThan(64);
  // Kein PNG, kein JPEG, kein WebP - also nichts, was ein Bildbetrachter öffnet.
  expect(daten.subarray(0, 8).toString('hex')).not.toBe('89504e470d0a1a0a');
  expect(daten.subarray(0, 2).toString('hex')).not.toBe('ffd8');
  expect(daten.subarray(0, 4).toString('latin1')).not.toBe('RIFF');

  await kontext.close();
});

test('Das Gruppenbild darf nur der Verwalter setzen', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  const [link] = await gruppeAnlegen(seiteA, { count: 1, nick: 'Anton' });
  await withName(seiteB, 'Mira');
  await seiteB.goto(link);
  await expect(seiteB.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  await seiteA.locator('#btn-group-to-chat').click();

  // B ist gewöhnliches Mitglied: im Gruppenprofil steht kein Gruppenbild
  // und kein Einladen.
  await seiteB.locator('#chat-menu').click();
  await expect(seiteB.locator('#sheet')).toBeVisible();
  await seiteB.getByRole('button', { name: /^Gruppe/ }).click();
  await expect(seiteB.getByRole('button', { name: /^Gruppenbild/ })).toHaveCount(0);
  await expect(seiteB.getByRole('button', { name: /Weitere einladen/ })).toHaveCount(0);
  await seiteB.keyboard.press('Escape');

  // A ist Verwalter und setzt das Bild - über dasselbe Profil.
  await seiteA.locator('#chat-menu').click();
  await seiteA.getByRole('button', { name: /^Gruppe/ }).click();
  await bildWaehlen(seiteA, () => seiteA.getByRole('button', { name: /^Gruppenbild/ }).click());

  // Und B sieht es.
  await expect(seiteB.locator('#peer-avatar img.avatar__img')).toBeVisible({ timeout: 30_000 });

  await kontextA.close();
  await kontextB.close();
});

/**
 * Ein neues Bild muss auch ankommen.
 *
 * Der PHP-Server laesst Bilder einen Tag lang zwischenspeichern. Steht die
 * Fassung nicht in der Adresse, zeigt der Browser danach hartnaeckig das
 * alte Bild weiter - man aendert sein Bild, und beim Gegenueber passiert
 * nichts.
 */
test('Ein geändertes Bild ersetzt das alte', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  await withName(seiteA, 'Anton');
  await seiteA.goto('./');
  await eigenesBildSetzen(seiteA);
  const { link } = await createChat(seiteA, { nick: null });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  const bild = seiteB.locator('#peer-avatar img.avatar__img');
  await expect(bild).toBeVisible({ timeout: 25_000 });

  /** Ein paar Bildpunkte des angezeigten Bildes - der Fingerabdruck. */
  const punkte = () => bild.evaluate((element) => {
    const leinwand = document.createElement('canvas');
    leinwand.width = 8;
    leinwand.height = 8;
    const stift = leinwand.getContext('2d');
    stift.drawImage(element, 0, 0, 8, 8);
    return [...stift.getImageData(0, 0, 8, 8).data].join(',');
  });
  const vorher = await punkte();

  // Anderes Seitenverhaeltnis: der Ausschnitt sieht danach anders aus.
  await seiteA.locator('#chat-menu').click();
  await seiteA.getByRole('button', { name: /^Mein Profil/ }).click();
  const [dialog] = await Promise.all([
    seiteA.waitForEvent('filechooser'),
    seiteA.getByRole('button', { name: /Anderes Bild auswählen/i }).click(),
  ]);
  await dialog.setFiles({ name: 'zwei.png', mimeType: 'image/png', buffer: makePng(300, 500) });
  await seiteA.locator('#crop-apply').click();

  await expect.poll(punkte, { timeout: 30_000 }).not.toBe(vorher);

  await kontextA.close();
  await kontextB.close();
});

/**
 * "Bild entfernen" muss es auch dort entfernen, wo es liegt.
 *
 * Nur die eigene Anzeige zu leeren und das Bild in zwanzig Räumen stehen zu
 * lassen wäre das Gegenteil dessen, was man beim Antippen erwartet.
 */
test('Ein entferntes Bild verschwindet auch beim Gegenüber', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  await withName(seiteA, 'Anton');
  await seiteA.goto('./');
  await eigenesBildSetzen(seiteA);
  const { link } = await createChat(seiteA, { nick: null });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  await expect(seiteB.locator('#peer-avatar img.avatar__img')).toBeVisible({ timeout: 25_000 });

  await seiteA.locator('#chat-menu').click();
  await seiteA.getByRole('button', { name: /^Mein Profil/ }).click();
  await seiteA.getByRole('button', { name: /Bild entfernen/i }).click();

  // Beim Gegenüber steht wieder der Anfangsbuchstabe.
  await expect(seiteB.locator('#peer-avatar img')).toHaveCount(0, { timeout: 30_000 });
  await expect(seiteB.locator('#peer-avatar')).toHaveText('A', { timeout: 15_000 });

  // Und es ist wirklich weg, nicht nur ausgeblendet: A fragt sein eigenes
  // Bild beim Server nach und bekommt nichts mehr.
  const status = await seiteA.evaluate(async () => {
    const [sitzung] = JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]');
    const antwort = await fetch(new URL(`api/rooms/${sitzung.roomId}/avatar/${sitzung.memberId}`, location.href), {
      headers: { 'x-room-token': sitzung.token },
    });
    return antwort.status;
  });
  expect(status, 'das Bild liegt noch auf dem Server').toBe(404);

  await kontextA.close();
  await kontextB.close();
});

/**
 * Eine Datei, die kein Bild ist, ist ein Missgriff - kein Grund, die ganze
 * App durch eine Fehlerseite zu ersetzen, die vom Server spricht, mit dem
 * gar nicht geredet wurde.
 */
test('Eine kaputte Datei wirft niemanden aus dem Chat', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });

  await seiteA.locator('#chat-menu').click();
  await seiteA.getByRole('button', { name: /^Mein Profil/ }).click();
  const [dialog] = await Promise.all([
    seiteA.waitForEvent('filechooser'),
    seiteA.getByRole('button', { name: /Bild auswählen/i }).click(),
  ]);
  await dialog.setFiles({ name: 'kaputt.png', mimeType: 'image/png', buffer: Buffer.from('das ist kein PNG') });

  // Ein Hinweis am Rand - und der Chat steht noch.
  await expect(seiteA.locator('#toast')).toContainText(/nicht als Bild/i, { timeout: 20_000 });
  await expect(seiteA.locator('#screen-error')).toBeHidden();
  await expect(seiteA.locator('#screen-chat')).toBeVisible();

  await kontextA.close();
  await kontextB.close();
});

/**
 * Wer die Gruppe verlassen hat, darf auch über die Übersicht nichts mehr
 * erfahren - sonst bliebe ihm ein Lesekanal: wie viel Neues liegt, wann
 * zuletzt etwas kam, wer gerade tippt.
 */
test('Die Übersicht schweigt gegenüber Gegangenen', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  const [link] = await gruppeAnlegen(seiteA, { count: 2, nick: 'Anton' });
  await withName(seiteB, 'Mira');
  await seiteB.goto(link);
  await expect(seiteB.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  await seiteA.locator('#btn-group-to-chat').click();

  const frage = async (seite) => seite.evaluate(async () => {
    const [sitzung] = JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]');
    const antwort = await fetch(new URL('api/overview', location.href), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rooms: [{ roomId: sitzung.roomId, token: sitzung.token, seq: 0 }] }),
    });
    const daten = await antwort.json();
    return daten.rooms ?? [];
  });

  // Solange B dabei ist, bekommt er Auskunft.
  expect((await frage(seiteB)).length, 'B bekommt als Mitglied keine Auskunft').toBe(1);

  await seiteB.evaluate(async () => {
    const [sitzung] = JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]');
    await fetch(new URL(`api/rooms/${sitzung.roomId}/leave`, location.href), {
      method: 'POST',
      headers: { 'x-room-token': sitzung.token },
    });
  });

  // Danach nicht mehr - und zwar nicht einmal, dass es den Raum gibt.
  await expect.poll(async () => (await frage(seiteB)).length, { timeout: 20_000 }).toBe(0);
  // A dagegen schon: die Gruppe steht ja noch.
  expect((await frage(seiteA)).length).toBe(1);

  await kontextA.close();
  await kontextB.close();
});
