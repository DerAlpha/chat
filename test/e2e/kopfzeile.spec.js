/**
 * Die Kopfzeile des Chats - und vor allem die Statuszeile darin.
 *
 * "zuletzt gesehen vor 3 Std." ist auf einem Telefon laenger als der Platz.
 * Abgeschnitten fehlt genau die Angabe, um die es ging. Also laeuft der Text
 * langsam durch. Hier wird nachgemessen, dass er das wirklich tut - und dass
 * er es NICHT tut, wenn er ohnehin passt.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat, joinChat, withName } from './helpers.js';

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };
const LANGER_NAME = 'Bartholomäus-Ferdinand von Hohenzollern';
/** So lang, dass der Streifen weit ueber den Fensterrand hinausreichen wuerde. */
const SEHR_LANGER_NAME = `${LANGER_NAME} und Sonnenschein zu Lichtenstein`;

/** Zwei Geraete, ein Code. */
async function paar(browser) {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const { link } = await createChat(seiteA);
  await joinChat(seiteB, link);
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  return { kontextA, kontextB, seiteA, seiteB };
}

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

/** Wo steht der innere Streifen gerade? */
const streifenLinks = (seite) =>
  seite.locator('#peer-status-text').evaluate((element) => element.getBoundingClientRect().left);

test('Ein zu langer Status laeuft durch, statt abgeschnitten zu werden', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  const [link] = await gruppeAnlegen(seiteA, { count: 1, nick: 'Anton' });
  await withName(seiteB, LANGER_NAME);
  await seiteB.goto(link);
  await expect(seiteB.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  await seiteA.locator('#btn-group-to-chat').click();
  await expect(seiteA.locator('#screen-chat')).toBeVisible();

  // B tippt weiter, bis A es sieht - die Anzeige haelt nur ein paar Sekunden.
  const feld = seiteB.locator('#message-input');
  await feld.click();
  const status = seiteA.locator('#peer-status');
  await expect.poll(async () => {
    await feld.press('a');
    await seiteA.waitForTimeout(400);
    return status.textContent();
  }, { timeout: 40_000, intervals: [0] }).toMatch(/Hohenzollern/);

  // Der Text passt nicht - also laeuft er.
  await expect(status).toHaveClass(/is-lauf/);
  const weg = await status.evaluate((element) => element.style.getPropertyValue('--lauf-weg'));
  expect(Number.parseFloat(weg), `Laufweg: "${weg}"`).toBeLessThan(0);
  const name = await seiteA.locator('#peer-status-text')
    .evaluate((element) => getComputedStyle(element).animationName);
  expect(name).toBe('statuslauf');
  // Der Rahmen muss abschneiden - sonst schoebe sich der laufende Text unter
  // die Knoepfe der Kopfzeile, statt in seiner Zeile zu bleiben.
  const schnitt = await status.evaluate((element) => getComputedStyle(element).overflowX);
  expect(schnitt).toBe('hidden');

  // Und er bewegt sich wirklich: dieselbe Stelle, zwei Zeitpunkte.
  const start = await streifenLinks(seiteA);
  await expect.poll(async () => Math.abs(await streifenLinks(seiteA) - start),
    { timeout: 20_000, intervals: [500] }).toBeGreaterThan(3);

  // Ganz zu lesen ist er trotzdem nur, wenn er auch ganz da ist.
  await expect(status).toContainText(LANGER_NAME);

  await kontextA.close();
  await kontextB.close();
});

test('Ein kurzer Status bleibt ruhig stehen', async ({ browser }) => {
  const { kontextA, kontextB, seiteA } = await paar(browser);
  const status = seiteA.locator('#peer-status');
  await expect(status).toHaveText(/online/i, { timeout: 20_000 });
  await expect(status).not.toHaveClass(/is-lauf/);
  const name = await seiteA.locator('#peer-status-text')
    .evaluate((element) => getComputedStyle(element).animationName);
  expect(name).toBe('none');
  await kontextA.close();
  await kontextB.close();
});

/**
 * Der Laufstreifen ist breiter als sein Rahmen - das ist ja der Sinn. Genau
 * so ist frueher schon einmal das ganze Fenster nach rechts gewachsen, bis
 * die App unbedienbar war. Also nachmessen, dass nichts davon nach aussen
 * durchschlaegt: die Behaelter bleiben im Fenster, und seitlich schieben
 * laesst sich nichts.
 */
test('Der laufende Status macht das Fenster nicht breiter', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  const [link] = await gruppeAnlegen(seiteA, { count: 1, nick: 'Anton' });
  await withName(seiteB, SEHR_LANGER_NAME);
  await seiteB.goto(link);
  await expect(seiteB.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  await seiteA.locator('#btn-group-to-chat').click();

  const feld = seiteB.locator('#message-input');
  await feld.click();
  const status = seiteA.locator('#peer-status');
  await expect.poll(async () => {
    await feld.press('a');
    await seiteA.waitForTimeout(400);
    return status.textContent();
  }, { timeout: 40_000, intervals: [0] }).toMatch(/Lichtenstein/);

  const breite = seiteA.viewportSize().width;
  const messung = await seiteA.evaluate(() => {
    // Der innere Streifen DARF ueberstehen - er wird ja abgeschnitten.
    // Alles, was ihn umgibt, darf es nicht.
    const behaelter = ['#app', '#screen-chat', '.chat-header', '.chat-header__text', '#peer-status'];
    const raender = {};
    for (const wahl of behaelter) {
      const knoten = document.querySelector(wahl);
      if (knoten) raender[wahl] = Math.round(knoten.getBoundingClientRect().right);
    }
    // Und seitlich schieben laesst sich nichts.
    const schieben = [];
    for (const knoten of [document.scrollingElement, document.getElementById('app'), document.getElementById('messages')]) {
      if (!knoten) continue;
      knoten.scrollLeft = 9999;
      schieben.push(knoten.scrollLeft);
      knoten.scrollLeft = 0;
    }
    return {
      raender,
      streifen: Math.round(document.getElementById('peer-status-text').getBoundingClientRect().right),
      schieben,
    };
  });

  // Zuerst das, worum es geht: nichts von aussen waechst mit.
  for (const [wahl, rand] of Object.entries(messung.raender)) {
    expect(rand, `${wahl} reicht bis ${rand}, Fenster ist ${breite}`).toBeLessThanOrEqual(breite + 1);
  }
  // Und der Streifen ist wirklich zu breit - sonst prueft der Test nichts.
  await expect(status).toHaveClass(/is-lauf/);
  expect(messung.streifen, 'der Streifen passt ja doch ins Fenster').toBeGreaterThan(breite + 40);
  expect(messung.schieben, `seitlich verschiebbar: ${messung.schieben.join(', ')}`).toEqual(messung.schieben.map(() => 0));

  await kontextA.close();
  await kontextB.close();
});
