/**
 * Verdeckte Nachrichten.
 *
 * Der Absender entscheidet vor dem Abschicken, dass eine Nachricht zugedeckt
 * ankommt; das Gegenüber tippt einmal zum Anzeigen und noch einmal zum
 * Zudecken.
 *
 * Geprüft wird nicht die Klasse im DOM, sondern das, was ein Mitleser sähe:
 * der Text darf nirgends im Dokument stehen, solange nicht getippt wurde –
 * auch nicht unsichtbar hinter einer Weichzeichnung, aus der er sich
 * zurückrechnen ließe. Deshalb baut die App ihn gar nicht erst.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat, joinChat, sendText, withName, makePng, longPress } from './helpers.js';

/** Legt eine Gruppe an und gibt die Beitrittslinks zurueck. */
async function gruppeAnlegen(page, { count = 2, nick = 'Anton' } = {}) {
  if (nick) await withName(page, nick);
  await page.goto('./');
  await page.getByRole('button', { name: /Gruppe erstellen/i }).click();
  await page.locator('#sheet input[type="text"]').fill('Verein');
  await page.locator('#group-size').fill(String(count));
  await page.locator('#sheet').getByRole('button', { name: /^Anlegen$/ }).click();
  await expect(page.locator('#screen-group')).toBeVisible({ timeout: 20_000 });
  const codes = await page.locator('#group-codes .invite-row__code').allInnerTexts();
  const basis = new URL(page.url());
  return codes.map((c) => `${basis.origin}${basis.pathname}#g:${encodeURIComponent(c.trim())}`);
}

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

/** Legt den Schalter "Verdeckt senden" um. */
async function verdecktScharfmachen(seite) {
  await seite.locator('#btn-attach').click();
  await expect(seite.locator('#sheet')).toBeVisible({ timeout: 10_000 });
  await seite.getByRole('button', { name: /Verdeckt senden/ }).click();
  await expect(seite.locator('#sheet')).toBeHidden({ timeout: 10_000 });
  await expect(seite.locator('#spoiler-bar')).toBeVisible();
}

/** Steht dieser Text irgendwo im Dokument? */
const stehtIrgendwo = (seite, text) => seite.evaluate(
  (gesucht) => (document.body.innerText ?? '').includes(gesucht),
  text,
);

async function paar(browser) {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  return { kontextA, kontextB, seiteA, seiteB };
}

test('Verdeckt heißt: der Text steht nicht da', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await paar(browser);

  await verdecktScharfmachen(seiteA);
  await seiteA.locator('#message-input').fill('Das Ende vom Film');
  await seiteA.locator('#btn-send').click();

  const blase = seiteB.locator('#messages .msg--in:not(.msg--typing)').last();
  await expect(blase.locator('.spoiler')).toBeVisible({ timeout: 30_000 });
  expect(await stehtIrgendwo(seiteB, 'Das Ende vom Film'),
    'der verdeckte Text steht trotzdem im Dokument').toBe(false);

  // Einmal tippen: jetzt ist er da.
  await blase.locator('.spoiler').click();
  await expect(blase.locator('.bubble__text')).toHaveText('Das Ende vom Film');

  // Und noch einmal: wieder zu.
  await blase.locator('.spoiler-again').click();
  await expect(blase.locator('.spoiler')).toBeVisible();
  expect(await stehtIrgendwo(seiteB, 'Das Ende vom Film'),
    'nach dem Zudecken steht er wieder im Dokument').toBe(false);

  await kontextA.close();
  await kontextB.close();
});

/**
 * Der Schalter gilt für genau eine Nachricht. Bliebe er stehen, schickte man
 * unbemerkt tagelang Flächen statt Sätzen.
 */
test('Der Schalter gilt für eine Nachricht, nicht für den Abend', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await paar(browser);

  await verdecktScharfmachen(seiteA);
  await seiteA.locator('#message-input').fill('Zugeklebte Zeile');
  await seiteA.locator('#btn-send').click();
  await expect(seiteA.locator('#spoiler-bar')).toBeHidden({ timeout: 10_000 });

  await sendText(seiteA, 'Ganz offen');
  const blasen = seiteB.locator('#messages .msg--in:not(.msg--typing)');
  await expect(blasen).toHaveCount(2, { timeout: 30_000 });
  await expect(blasen.nth(0).locator('.spoiler')).toBeVisible();
  await expect(blasen.nth(1).locator('.bubble__text')).toHaveText('Ganz offen');
  expect(await stehtIrgendwo(seiteB, 'Zugeklebte Zeile')).toBe(false);

  await kontextA.close();
  await kontextB.close();
});

/** Auch Bilder gehen verdeckt hinaus - und kein Bildpunkt kommt vorher an. */
test('Auch ein Bild bleibt zugedeckt', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await paar(browser);

  await verdecktScharfmachen(seiteA);
  const [dialog] = await Promise.all([
    seiteA.waitForEvent('filechooser'),
    seiteA.locator('#btn-attach').click().then(() =>
      seiteA.getByRole('button', { name: /Foto aus der Galerie/i }).click()),
  ]);
  await dialog.setFiles({ name: 'bild.png', mimeType: 'image/png', buffer: makePng(200, 150) });
  await expect(seiteA.locator('#attachments .attachment')).toHaveCount(1, { timeout: 20_000 });
  // Der Schalter darf das Anhängen überstehen - abgeschickt wird erst jetzt.
  await expect(seiteA.locator('#spoiler-bar')).toBeVisible();
  await seiteA.locator('#btn-send').click();

  const blase = seiteB.locator('#messages .msg--in:not(.msg--typing)').last();
  await expect(blase.locator('.spoiler')).toBeVisible({ timeout: 30_000 });
  await expect(blase.locator('img')).toHaveCount(0);

  await blase.locator('.spoiler').click();
  await expect(blase.locator('.bubble__image')).toBeVisible({ timeout: 25_000 });

  await kontextA.close();
  await kontextB.close();
});

/**
 * Die Vorschauen sind der leiseste Weg, an dem ein Spoiler leckt: das Zitat
 * einer Antwort trägt den Text des Zitierten mit sich, und die Meldung des
 * Betriebssystems zeigt ihn auf dem gesperrten Bildschirm.
 */
test('Auch das Zitat verrät den verdeckten Text nicht', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await paar(browser);

  await verdecktScharfmachen(seiteA);
  await seiteA.locator('#message-input').fill('Streng geheim');
  await seiteA.locator('#btn-send').click();

  const blase = seiteB.locator('#messages .msg--in:not(.msg--typing)').last();
  await expect(blase.locator('.spoiler')).toBeVisible({ timeout: 30_000 });

  // Mira antwortet auf die verdeckte Nachricht, ohne sie anzusehen.
  await longPress(seiteB, blase.locator('.bubble'));
  await expect(seiteB.locator('#sheet')).toBeVisible({ timeout: 10_000 });
  await seiteB.getByRole('button', { name: /^Antworten/ }).click();
  await expect(seiteB.locator('#reply-preview')).toBeVisible();
  expect(await seiteB.locator('#reply-preview-text').innerText())
    .not.toContain('Streng geheim');
  await sendText(seiteB, 'Verstanden');

  // Und bei Anton steht im Zitat ebenfalls nichts Verräterisches - obwohl
  // er den Text selbst geschrieben hat, ist er dort verdeckt geblieben.
  const antwort = seiteA.locator('#messages .msg--in:not(.msg--typing)').last();
  await expect(antwort).toContainText('Verstanden', { timeout: 30_000 });
  expect(await antwort.locator('.quote').innerText()).not.toContain('Streng geheim');

  await kontextA.close();
  await kontextB.close();
});

/**
 * Auch der Absender sieht seine eigene Nachricht zugedeckt. Eine Regel für
 * alle ist leichter zu merken als zwei - und er kann so nachsehen, was beim
 * anderen ankommt.
 */
test('Auch beim Absender ist sie zugedeckt', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await paar(browser);

  await verdecktScharfmachen(seiteA);
  await seiteA.locator('#message-input').fill('Mein eigenes Geheimnis');
  await seiteA.locator('#btn-send').click();

  const eigene = seiteA.locator('#messages .msg--out').last();
  await expect(eigene.locator('.spoiler')).toBeVisible({ timeout: 20_000 });
  expect(await stehtIrgendwo(seiteA, 'Mein eigenes Geheimnis')).toBe(false);
  await eigene.locator('.spoiler').click();
  await expect(eigene.locator('.bubble__text')).toHaveText('Mein eigenes Geheimnis');

  await kontextA.close();
  await kontextB.close();
});

/**
 * Der Absender will wissen, ob schon jemand hingesehen hat.
 *
 * Geprüft wird beides: dass es vorher NICHT dasteht - sonst wäre die Marke
 * eine Behauptung, kein Befund - und dass es hinterher dasteht.
 */
test('Der Absender sieht, ob schon aufgedeckt wurde', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await paar(browser);

  await verdecktScharfmachen(seiteA);
  await seiteA.locator('#message-input').fill('Erst nach dem Tippen');
  await seiteA.locator('#btn-send').click();

  const eigene = seiteA.locator('#messages .msg--out').last();
  const marke = eigene.locator('.reveal-mark');
  await expect(marke).toHaveText('zugedeckt', { timeout: 25_000 });

  // Mira hat sie zwar bekommen und gelesen - aber nicht aufgedeckt.
  const fremde = seiteB.locator('#messages .msg--in:not(.msg--typing)').last();
  await expect(fremde.locator('.spoiler')).toBeVisible({ timeout: 30_000 });
  await seiteA.waitForTimeout(1500);
  await expect(marke).toHaveText('zugedeckt');

  // Und jetzt tippt sie.
  await fremde.locator('.spoiler').click();
  await expect(fremde.locator('.bubble__text')).toHaveText('Erst nach dem Tippen');
  await expect(marke).toHaveText('aufgedeckt', { timeout: 30_000 });

  // Wieder zudecken nimmt die Auskunft nicht zurück: hingesehen wurde.
  await fremde.locator('.spoiler-again').click();
  await expect(fremde.locator('.spoiler')).toBeVisible();
  await seiteA.waitForTimeout(1200);
  await expect(marke).toHaveText('aufgedeckt');

  await kontextA.close();
  await kontextB.close();
});

/**
 * Und die Auskunft muss ein Neuladen überstehen - sie steht beim Server,
 * nicht nur im Fenster, das sie gerade gesehen hat.
 */
test('Aufgedeckt bleibt aufgedeckt, auch nach dem Neuladen', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await paar(browser);

  await verdecktScharfmachen(seiteA);
  await seiteA.locator('#message-input').fill('Bleibt bekannt');
  await seiteA.locator('#btn-send').click();

  const fremde = seiteB.locator('#messages .msg--in:not(.msg--typing)').last();
  await expect(fremde.locator('.spoiler')).toBeVisible({ timeout: 30_000 });
  await fremde.locator('.spoiler').click();
  await expect(seiteA.locator('#messages .msg--out').last().locator('.reveal-mark'))
    .toHaveText('aufgedeckt', { timeout: 30_000 });

  await seiteA.reload();
  const eintrag = seiteA.locator('#chat-list .chat-list__item').first();
  await expect(eintrag).toBeVisible({ timeout: 25_000 });
  await eintrag.click();
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  await expect(seiteA.locator('#messages .msg--out').last().locator('.reveal-mark'))
    .toHaveText('aufgedeckt', { timeout: 30_000 });

  await kontextA.close();
  await kontextB.close();
});

/**
 * In einer Gruppe reicht ein Ja/Nein nicht: bei sechs Leuten ist "jemand hat
 * aufgedeckt" nichtssagend. Also die Zahl - und wer dahintersteckt, auf
 * Wunsch.
 */
test('In der Gruppe steht die Zahl - und wer dahintersteckt', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const kontextC = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const seiteC = await kontextC.newPage();

  const [linkB, linkC] = await gruppeAnlegen(seiteA, { count: 2, nick: 'Anton' });
  await withName(seiteB, 'Mira');
  await seiteB.goto(linkB);
  await expect(seiteB.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  await withName(seiteC, 'Nora');
  await seiteC.goto(linkC);
  await expect(seiteC.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  await seiteA.locator('#btn-group-to-chat').click();

  await verdecktScharfmachen(seiteA);
  await seiteA.locator('#message-input').fill('Nur für den Verein');
  await seiteA.locator('#btn-send').click();

  const marke = seiteA.locator('#messages .msg--out').last().locator('.reveal-mark');
  await expect(marke).toHaveText('zugedeckt', { timeout: 25_000 });

  // Nur Mira deckt auf.
  const beiMira = seiteB.locator('#messages .msg--in:not(.msg--typing)').last();
  await expect(beiMira.locator('.spoiler')).toBeVisible({ timeout: 30_000 });
  await beiMira.locator('.spoiler').click();
  await expect(marke).toHaveText('aufgedeckt · 1', { timeout: 30_000 });

  // Und im Blatt steht, wer - und wer noch nicht.
  await marke.click();
  await expect(seiteA.locator('#sheet')).toBeVisible({ timeout: 10_000 });
  const blatt = await seiteA.locator('#sheet-body').innerText();
  expect(blatt).toContain('Mira');
  expect(blatt).toContain('Nora');
  const zeilen = await seiteA.evaluate(() => ({
    auf: [...document.querySelectorAll('#sheet-body .seen-list.is-read .seen-row__name')].map((n) => n.textContent.trim()),
    zu: [...document.querySelectorAll('#sheet-body .seen-list.is-pending .seen-row__name')].map((n) => n.textContent.trim()),
  }));
  expect(zeilen.auf).toEqual(['Mira']);
  expect(zeilen.zu).toEqual(['Nora']);
  await seiteA.keyboard.press('Escape');

  // Deckt Nora auch auf, wird aus eins zwei.
  const beiNora = seiteC.locator('#messages .msg--in:not(.msg--typing)').last();
  await expect(beiNora.locator('.spoiler')).toBeVisible({ timeout: 30_000 });
  await beiNora.locator('.spoiler').click();
  await expect(marke).toHaveText('aufgedeckt · 2', { timeout: 30_000 });

  await kontextA.close();
  await kontextB.close();
  await kontextC.close();
});

/** Wer den Chat verlässt, findet alles wieder zugedeckt vor. */
test('Nach dem Wiederkommen ist alles wieder zugedeckt', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await paar(browser);

  await verdecktScharfmachen(seiteA);
  await seiteA.locator('#message-input').fill('Nur einmal zu sehen');
  await seiteA.locator('#btn-send').click();

  const blase = () => seiteB.locator('#messages .msg--in:not(.msg--typing)').last();
  await expect(blase().locator('.spoiler')).toBeVisible({ timeout: 30_000 });
  await blase().locator('.spoiler').click();
  await expect(blase().locator('.bubble__text')).toHaveText('Nur einmal zu sehen');

  await seiteB.locator('#chat-back').click();
  const eintrag = seiteB.locator('#chat-list .chat-list__item').first();
  await expect(eintrag).toBeVisible({ timeout: 20_000 });
  await eintrag.click();
  await expect(seiteB.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });

  await expect(blase().locator('.spoiler')).toBeVisible({ timeout: 25_000 });
  expect(await stehtIrgendwo(seiteB, 'Nur einmal zu sehen'),
    'nach dem Wiederkommen steht der Text wieder da').toBe(false);

  await kontextA.close();
  await kontextB.close();
});
