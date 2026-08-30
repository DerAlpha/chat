/**
 * Suchen und Verstecken.
 *
 * Verstecken heißt hier nicht "ausblenden". Der ganze Eintrag wandert
 * verschlüsselt in einen eigenen Block und verschwindet aus der Liste - ab da
 * weiß die App selbst nicht mehr, was dahintersteckt. Sie kann den Raum
 * deshalb nicht abfragen, nicht zählen und nicht melden. Genau das wird hier
 * geprüft, und zwar am Speicher des Geräts, nicht nur an der Oberfläche: was
 * dort noch im Klartext stünde, wäre eine Spur.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat, joinChat, sendText, longPress } from './helpers.js';

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

const eintraege = (seite) => seite.locator('#chat-list .chat-list__item');
const suchfeld = (seite) => seite.locator('#chat-search');

/** Legt einen Chat an und geht zurück auf die Startseite. */
async function chatMit(browser, nick) {
  const kontext = await browser.newContext(HANDY);
  const seite = await kontext.newPage();
  const { link } = await createChat(seite, { nick: 'Anton' });
  const gegen = await browser.newContext(HANDY);
  const gegenSeite = await gegen.newPage();
  await joinChat(gegenSeite, link, { nick });
  await expect(seite.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  return { kontext, seite, gegen, gegenSeite };
}

/** Was von diesem Chat noch im Speicher des Geräts steht. */
const spuren = (seite, ...woerter) => seite.evaluate((suche) => {
  const alles = Object.keys(localStorage)
    .filter((schluessel) => schluessel.startsWith('fc:'))
    .map((schluessel) => `${schluessel}=${localStorage.getItem(schluessel)}`)
    .join('\n');
  return suche.filter((wort) => alles.includes(wort));
}, woerter);

/** Versteckt den obersten Chat hinter einer Zeichenfolge. */
async function verstecken(seite, wort) {
  await longPress(seite, eintraege(seite).first());
  await seite.locator('#sheet').getByRole('button', { name: /^Chat verstecken/ }).click();
  await seite.locator('#sheet input[type="text"]').fill(wort);
  await seite.locator('#sheet').getByRole('button', { name: /^Speichern$/ }).click();
  await seite.locator('#sheet').getByRole('button', { name: /^Verstecken$/ }).click();
  await expect(seite.locator('#toast')).toContainText('Versteckt', { timeout: 15_000 });
}

test('Die Suche findet Leute in der Liste', async ({ browser }) => {
  const { kontext, seite, gegen } = await chatMit(browser, 'Mira');
  await seite.locator('#chat-back').click();
  await expect(seite.locator('#screen-start')).toBeVisible();
  await expect(eintraege(seite)).toHaveCount(1);

  await suchfeld(seite).fill('Mira');
  await expect(eintraege(seite)).toHaveCount(1);
  await suchfeld(seite).fill('Zacharias');
  await expect(eintraege(seite)).toHaveCount(0);
  await expect(seite.locator('#chat-list')).toContainText('Nichts gefunden');

  // Das Kreuz räumt die Leiste wieder ab.
  await seite.locator('#chat-search-clear').click();
  await expect(eintraege(seite)).toHaveCount(1);
  await kontext.close(); await gegen.close();
});

/**
 * Der Kern: nach dem Verstecken darf nichts mehr da sein - weder in der
 * Liste noch im Speicher. Der Name des Gegenübers und der Code sind die
 * beiden Dinge, an denen man den Chat wiedererkennen würde.
 */
test('Ein versteckter Chat hinterlässt keine Spur', async ({ browser }) => {
  const { kontext, seite, gegen } = await chatMit(browser, 'Mira');
  const code = await seite.evaluate(() =>
    JSON.parse(localStorage.getItem('fc:sessions:v1'))[0].code);
  await seite.locator('#chat-back').click();
  await expect(seite.locator('#screen-start')).toBeVisible();

  await verstecken(seite, 'nachtfalter');

  await expect(eintraege(seite)).toHaveCount(0);
  await expect(seite.locator('#chats-section')).toBeHidden();
  expect(await spuren(seite, 'Mira', code), 'Name oder Code stehen noch im Speicher').toEqual([]);
  // Und nach einem Neuladen bleibt es dabei.
  await seite.reload();
  await expect(seite.locator('#screen-start')).toBeVisible();
  await expect(eintraege(seite)).toHaveCount(0);
  expect(await spuren(seite, 'Mira', code)).toEqual([]);
  await kontext.close(); await gegen.close();
});

/**
 * Nur die genaue Zeichenfolge. Eine falsche darf sich nicht davon
 * unterscheiden lassen, dass überhaupt etwas da ist.
 */
test('Nur die richtige Zeichenfolge holt den Chat zurück', async ({ browser }) => {
  const { kontext, seite, gegen } = await chatMit(browser, 'Mira');
  await seite.locator('#chat-back').click();
  await expect(seite.locator('#screen-start')).toBeVisible();
  await verstecken(seite, 'nachtfalter');

  // Beinahe richtig ist falsch.
  await suchfeld(seite).fill('nachtfalte');
  await seite.waitForTimeout(2500);
  await expect(eintraege(seite)).toHaveCount(0);
  await expect(seite.locator('#chat-list')).toContainText('Nichts gefunden');

  await suchfeld(seite).fill('nachtfalter');
  await expect(eintraege(seite)).toHaveCount(1, { timeout: 15_000 });
  await expect(eintraege(seite).first()).toContainText('Mira');
  // Und er lässt sich wirklich öffnen.
  await eintraege(seite).first().click();
  await expect(seite.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  await kontext.close(); await gegen.close();
});

/**
 * Solange er versteckt ist, meldet sich von dort nichts - auch nicht als
 * ungelesene Zahl. Das ist keine eigene Vorkehrung, sondern die Folge davon,
 * dass die App den Raum gar nicht mehr kennt.
 */
test('Aus einem versteckten Chat kommt keine Meldung', async ({ browser }) => {
  const { kontext, seite, gegen, gegenSeite } = await chatMit(browser, 'Mira');
  await seite.locator('#chat-back').click();
  await expect(seite.locator('#screen-start')).toBeVisible();
  await verstecken(seite, 'nachtfalter');

  await sendText(gegenSeite, 'Bist du da?');
  await seite.waitForTimeout(4000);

  await expect(eintraege(seite)).toHaveCount(0);
  await expect(seite.locator('#chats-section')).toBeHidden();
  expect(await spuren(seite, 'Bist du da?', 'Mira'), 'die Nachricht ist auf dem Gerät gelandet').toEqual([]);

  // Aufgeschlossen ist sie dann aber da - verloren geht nichts.
  await suchfeld(seite).fill('nachtfalter');
  await expect(eintraege(seite)).toHaveCount(1, { timeout: 15_000 });
  await eintraege(seite).first().click();
  await expect(seite.locator('#messages')).toContainText('Bist du da?', { timeout: 30_000 });
  await kontext.close(); await gegen.close();
});

/**
 * Der teuerste Fehler dieser Funktion, gefunden von einer Spurensuche über
 * den fertigen Stand: openFromList() schickte jeden Zweierchat durch
 * enterChat(), und dort steht ein unbedingtes saveSession(). Ein einziger
 * Fingertipp schrieb den Chat damit im Klartext zurück in die Liste - das
 * Verstecken war aufgehoben, ohne Nachfrage und ohne Hinweis.
 *
 * GEGENPROBE: in public/js/app.js in openFromList() den Zweig für
 * session.versteckId entfernen. Dann steht der Chat nach dem Neuladen wieder
 * da, und dieser Test wird rot.
 */
test('Den Chat zu öffnen hebt das Versteck nicht auf', async ({ browser }) => {
  const { kontext, seite, gegen } = await chatMit(browser, 'Mira');
  const code = await seite.evaluate(() =>
    JSON.parse(localStorage.getItem('fc:sessions:v1'))[0].code);
  await seite.locator('#chat-back').click();
  await expect(seite.locator('#screen-start')).toBeVisible();
  await verstecken(seite, 'nachtfalter');

  await suchfeld(seite).fill('nachtfalter');
  await expect(eintraege(seite)).toHaveCount(1, { timeout: 15_000 });
  await eintraege(seite).first().click();
  await expect(seite.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });

  // Schon im Chat darf nichts im Klartext liegen.
  expect(await spuren(seite, 'Mira', code), 'das Öffnen hat den Chat im Klartext gespeichert').toEqual([]);

  // Und nach dem Neuladen ist er wieder weg - nicht etwa zurück in der Liste.
  await seite.reload();
  await expect(seite.locator('#screen-start')).toBeVisible({ timeout: 20_000 });
  await expect(eintraege(seite)).toHaveCount(0);
  expect(await spuren(seite, 'Mira', code)).toEqual([]);
  await kontext.close(); await gegen.close();
});

/**
 * Aus den Augen heißt zu. Sonst bliebe nach einem Ausflug in den Chat die
 * Zeichenfolge im Klartext in der Leiste stehen und der Chat ganz oben in
 * der Liste - eine PWA wird beim Zurückholen aus dem App-Umschalter nicht neu
 * geladen, das überlebt also die Bildschirmsperre.
 *
 * GEGENPROBE: in public/js/app.js den visibilitychange-Zweig entfernen, der
 * versteckeSchliessen() ruft.
 */
test('Wer die App aus den Augen lässt, schließt das Versteck wieder', async ({ browser }) => {
  const { kontext, seite, gegen } = await chatMit(browser, 'Mira');
  await seite.locator('#chat-back').click();
  await expect(seite.locator('#screen-start')).toBeVisible();
  await verstecken(seite, 'nachtfalter');

  await suchfeld(seite).fill('nachtfalter');
  await expect(eintraege(seite)).toHaveCount(1, { timeout: 15_000 });

  // Die App wandert in den Hintergrund.
  await seite.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await expect(eintraege(seite)).toHaveCount(0);
  await expect(suchfeld(seite), 'die Zeichenfolge steht noch in der Leiste').toHaveValue('');
  await kontext.close(); await gegen.close();
});

/** Zwei Verstecke stören sich nicht - jede Zeichenfolge öffnet nur ihres. */
test('Zwei Verstecke bleiben auseinander', async ({ browser }) => {
  const kontext = await browser.newContext(HANDY);
  const seite = await kontext.newPage();
  const nebenan = [];
  for (const name of ['Mira', 'Cem']) {
    const { link } = await createChat(seite, { nick: 'Anton' });
    const gegen = await browser.newContext(HANDY);
    const gegenSeite = await gegen.newPage();
    await joinChat(gegenSeite, link, { nick: name });
    await expect(seite.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
    await seite.locator('#chat-back').click();
    await expect(seite.locator('#screen-start')).toBeVisible();
    nebenan.push(gegen);
  }
  await expect(eintraege(seite)).toHaveCount(2);

  // Der oberste ist der zuletzt angelegte - Cem.
  await verstecken(seite, 'erstes-versteck');
  await expect(eintraege(seite)).toHaveCount(1);
  await verstecken(seite, 'zweites-versteck');
  await expect(eintraege(seite)).toHaveCount(0);

  await suchfeld(seite).fill('erstes-versteck');
  await expect(eintraege(seite)).toHaveCount(1, { timeout: 15_000 });
  await expect(eintraege(seite).first()).toContainText('Cem');
  await suchfeld(seite).fill('zweites-versteck');
  await expect(eintraege(seite)).toHaveCount(1, { timeout: 15_000 });
  await expect(eintraege(seite).first()).toContainText('Mira');

  await kontext.close();
  for (const gegen of nebenan) await gegen.close();
});

test('Das Verstecken lässt sich wieder aufheben', async ({ browser }) => {
  const { kontext, seite, gegen } = await chatMit(browser, 'Mira');
  await seite.locator('#chat-back').click();
  await expect(seite.locator('#screen-start')).toBeVisible();
  await verstecken(seite, 'nachtfalter');

  await suchfeld(seite).fill('nachtfalter');
  await expect(eintraege(seite)).toHaveCount(1, { timeout: 15_000 });
  await expect(eintraege(seite).first().locator('.chat-list__versteckt')).toBeVisible();

  await longPress(seite, eintraege(seite).first());
  await seite.locator('#sheet').getByRole('button', { name: /^Versteck aufheben/ }).click();
  await seite.locator('#sheet').getByRole('button', { name: /^Aufheben$/ }).click();
  await expect(seite.locator('#toast')).toContainText('Wieder in der Liste', { timeout: 15_000 });

  // Danach steht er ganz normal da - auch ohne Suche und nach dem Neuladen.
  await expect(suchfeld(seite)).toHaveValue('');
  await expect(eintraege(seite)).toHaveCount(1);
  await expect(eintraege(seite).first().locator('.chat-list__versteckt')).toHaveCount(0);
  await seite.reload();
  await expect(eintraege(seite)).toHaveCount(1, { timeout: 20_000 });
  await expect(eintraege(seite).first()).toContainText('Mira');
  // Und der Block ist wirklich fort, nicht nur unsichtbar.
  const bloecke = await seite.evaluate(() =>
    JSON.parse(localStorage.getItem('fc:hidden:v1') ?? '[]').length);
  expect(bloecke, 'der verschlüsselte Block liegt noch da').toBe(0);
  await kontext.close(); await gegen.close();
});
