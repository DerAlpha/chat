/**
 * Profile: das eigene und das der anderen.
 *
 * Ein Profil ist mehr als ein Bildchen in der Ecke - Bild in groß, Name,
 * ein paar Zeilen. Und es muss bei den anderen ankommen, ohne dass der
 * Server mitliest.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat, joinChat, withName, makePng } from './helpers.js';

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

/** Wählt ein Bild aus und schneidet es zu. */
async function bildWaehlen(seite, oeffnen, { breite = 400, hoehe = 300 } = {}) {
  const [dialog] = await Promise.all([seite.waitForEvent('filechooser'), oeffnen()]);
  await dialog.setFiles({ name: 'foto.png', mimeType: 'image/png', buffer: makePng(breite, hoehe) });
  await expect(seite.locator('#crop-apply')).toBeVisible({ timeout: 15_000 });
}

/** Setzt das eigene Bild über den Knopf in der Fußzeile. */
async function eigenesBildSetzen(seite) {
  await seite.locator('#btn-avatar').click();
  await bildWaehlen(seite, () => seite.getByRole('button', { name: /Bild auswählen/i }).click());
  await seite.locator('#crop-apply').click();
  await expect(seite.locator('#btn-avatar .avatar.has-image')).toBeVisible({ timeout: 15_000 });
}

test('Das eigene Profil zeigt Bild, Namen und Text', async ({ page }) => {
  await withName(page, 'Anton');
  await page.goto('./');
  await eigenesBildSetzen(page);

  await page.locator('#btn-avatar').click();
  await expect(page.locator('#sheet-title')).toHaveText(/Mein Profil/);
  // Das Bild ist groß und wirklich geladen.
  const gross = page.locator('#sheet .profile__avatar img');
  await expect(gross).toBeVisible();
  const masse = await gross.evaluate((element) => ({
    breit: Math.round(element.getBoundingClientRect().width),
    echt: element.naturalWidth,
  }));
  expect(masse.breit, 'das Profilbild ist nicht größer als ein Symbol').toBeGreaterThan(90);
  expect(masse.echt).toBeGreaterThan(10);
  await expect(page.locator('#sheet .profile__name')).toHaveText('Anton');
  await expect(page.locator('#sheet .profile__bio')).toContainText(/Nichts hinterlegt/i);

  // Text eintragen ...
  await page.getByRole('button', { name: /^Über mich/ }).click();
  await page.locator('#sheet input[type="text"]').fill('Bäckerin aus Kiel, mag Katzen');
  await page.locator('#sheet').getByRole('button', { name: /^Speichern$/ }).click();

  // ... und er steht im Profil.
  await page.locator('#btn-avatar').click();
  await expect(page.locator('#sheet .profile__bio')).toHaveText('Bäckerin aus Kiel, mag Katzen');
});

test('Das Profil des Gegenübers zeigt dessen Bild und Text', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  await withName(seiteA, 'Anton');
  await seiteA.goto('./');
  await eigenesBildSetzen(seiteA);
  await seiteA.locator('#btn-avatar').click();
  await seiteA.getByRole('button', { name: /^Über mich/ }).click();
  await seiteA.locator('#sheet input[type="text"]').fill('Baut Fahrräder');
  await seiteA.locator('#sheet').getByRole('button', { name: /^Speichern$/ }).click();

  const { link } = await createChat(seiteA, { nick: null });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });

  // B tippt in der Kopfzeile auf Bild und Namen - und landet im Profil.
  await seiteB.locator('#peer-open').click();
  await expect(seiteB.locator('#sheet-title')).toHaveText(/^Profil$/);
  await expect(seiteB.locator('#sheet .profile__name')).toHaveText('Anton');
  await expect(seiteB.locator('#sheet .profile__bio')).toHaveText('Baut Fahrräder');
  const bild = seiteB.locator('#sheet .profile__avatar img');
  await expect(bild).toBeVisible({ timeout: 25_000 });
  expect(await bild.evaluate((element) => element.naturalWidth)).toBeGreaterThan(10);

  await kontextA.close();
  await kontextB.close();
});

/**
 * Der Text über einen selbst geht denselben Weg wie der Name: verschlüsselt,
 * im selben Päckchen. Der Server darf ihn nicht lesen können.
 */
test('Der Text über mich geht nur verschlüsselt raus', async ({ browser }) => {
  const kontext = await browser.newContext(HANDY);
  const seite = await kontext.newPage();
  const geheim = 'Wohnt in der Nelkenstrasse';
  const gesendet = [];
  await seite.route('**/api/rooms/*/frames', async (route) => {
    gesendet.push(route.request().postData() ?? '');
    return route.fallback();
  });
  seite.on('websocket', (ws) => {
    ws.on('framesent', (rahmen) => gesendet.push(String(rahmen.payload)));
  });

  await withName(seite, 'Anton');
  await seite.goto('./');
  await seite.locator('#btn-avatar').click();
  await seite.getByRole('button', { name: /^Über mich/ }).click();
  await seite.locator('#sheet input[type="text"]').fill(geheim);
  await seite.locator('#sheet').getByRole('button', { name: /^Speichern$/ }).click();
  await createChat(seite, { nick: null });
  await seite.waitForTimeout(1500);

  expect(gesendet.length, 'es ging überhaupt nichts raus').toBeGreaterThan(0);
  for (const paket of gesendet) {
    expect(paket, 'der Text stand im Klartext auf der Leitung').not.toContain(geheim);
    expect(paket).not.toContain('Nelkenstrasse');
  }
  await kontext.close();
});

/**
 * Zuschneiden: herauszoomen bis über den Bildrand hinaus.
 *
 * Wer sein Bild klein und mittig haben will, soll das können. Was dann
 * rundherum frei bleibt, ist im Profilbild schwarz - und das Fenster zeigt
 * es vorher genauso.
 */
test('Weit herausgezoomt wird der Rand schwarz', async ({ page }) => {
  await withName(page, 'Anton');
  await page.goto('./');
  await page.locator('#btn-avatar').click();
  await bildWaehlen(page, () => page.getByRole('button', { name: /Bild auswählen/i }).click(), { breite: 600, hoehe: 600 });

  // Ganz herauszoomen - der Regler geht bewusst unter "füllt das Fenster".
  const regler = page.locator('#sheet input[type="range"]');
  await regler.fill('0');
  await regler.dispatchEvent('input');

  // Im Fenster ist das Bild jetzt kleiner als das Fenster.
  const masse = await page.evaluate(() => {
    const fenster = document.querySelector('.crop');
    const bild = document.querySelector('.crop__img');
    return {
      fenster: Math.round(fenster.clientWidth),
      bild: Math.round(bild.getBoundingClientRect().width),
      hintergrund: getComputedStyle(fenster).backgroundColor,
    };
  });
  expect(masse.bild, 'der Regler zoomt nicht über den Bildrand hinaus').toBeLessThan(masse.fenster - 20);
  // Und was frei bleibt, ist schwarz - im Fenster wie im Ergebnis.
  expect(masse.hintergrund).toBe('rgb(0, 0, 0)');

  await page.locator('#crop-apply').click();
  await expect(page.locator('#btn-avatar .avatar.has-image')).toBeVisible({ timeout: 15_000 });

  // Das fertige Bild hat schwarze Ecken und in der Mitte etwas anderes.
  const punkte = await page.locator('#btn-avatar .avatar img').evaluate((element) => new Promise((fertig) => {
    const lesen = () => {
      const leinwand = document.createElement('canvas');
      leinwand.width = 64;
      leinwand.height = 64;
      const stift = leinwand.getContext('2d');
      stift.drawImage(element, 0, 0, 64, 64);
      const bei = (x, y) => [...stift.getImageData(x, y, 1, 1).data];
      fertig({ ecke: bei(2, 2), mitte: bei(32, 32) });
    };
    if (element.complete && element.naturalWidth > 0) lesen();
    else element.addEventListener('load', lesen, { once: true });
  }));
  const summe = (farbe) => farbe[0] + farbe[1] + farbe[2];
  expect(summe(punkte.ecke), `Ecke: ${punkte.ecke.join(',')}`).toBeLessThan(30);
  // Und zwar wirklich schwarz, nicht bloss durchsichtig: durchsichtig sieht
  // auf hellem Grund weiss aus und ist im Kreis ein Loch.
  expect(punkte.ecke[3], `Ecke: ${punkte.ecke.join(',')}`).toBe(255);
  expect(summe(punkte.mitte), `Mitte: ${punkte.mitte.join(',')}`).toBeGreaterThan(60);
});

/**
 * Der Kreis im Ausschnittfenster muss zeigen, was später wirklich rund zu
 * sehen ist. Ohne "closest-side" reichte der Verlauf bis zur weitesten Ecke,
 * und der freie Kreis war nur rund 70 % so groß wie das, was das Profilbild
 * am Ende zeigte.
 */
test('Der Kreis im Ausschnitt zeigt, was wirklich zu sehen sein wird', async ({ page }) => {
  await withName(page, 'Anton');
  await page.goto('./');
  await page.locator('#btn-avatar').click();
  await bildWaehlen(page, () => page.getByRole('button', { name: /Bild auswählen/i }).click(), { breite: 600, hoehe: 600 });

  const form = await page.evaluate(() => {
    const fenster = document.querySelector('.crop');
    const maske = document.querySelector('.crop__mask');
    const kasten = fenster.getBoundingClientRect();
    return {
      breit: Math.round(kasten.width),
      hoch: Math.round(kasten.height),
      maske: getComputedStyle(maske).maskImage || getComputedStyle(maske).webkitMaskImage,
    };
  });
  // Das Fenster ist quadratisch - der einbeschriebene Kreis ist damit genau
  // der Kreis, den die runde Anzeige später zeigt.
  expect(Math.abs(form.breit - form.hoch)).toBeLessThanOrEqual(1);
  expect(form.maske, `Maske: ${form.maske}`).toContain('closest-side');
});
