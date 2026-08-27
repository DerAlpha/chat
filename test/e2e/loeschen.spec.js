/**
 * Alle Daten löschen.
 *
 * Der gefährlichste Knopf der ganzen App: er vernichtet nicht nur die eigenen
 * Chats, sondern dieselben Unterhaltungen auch bei allen anderen. Deshalb
 * wird hier beides geprüft - dass es wirklich passiert, UND dass man nicht
 * versehentlich hineinstolpert.
 */
import { test, expect, devices, rawContext } from './fixtures.js';
import { createChat, joinChat, sendText, withName } from './helpers.js';

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

/** Öffnet den ersten der drei Hinweise. */
async function loeschenOeffnen(seite) {
  await seite.locator('#btn-about').click();
  await expect(seite.locator('#sheet')).toBeVisible();
  await seite.getByRole('button', { name: /Alle Daten löschen/i }).click();
}

/**
 * Weiter zum naechsten Hinweis.
 *
 * Ein frisch aufgeschlagenes Blatt nimmt fuer einen kurzen Moment kein
 * "Weiter" an - sonst liesse sich ein Hinweis mit einem Doppeltipp
 * ueberspringen. Hier wird also gewartet wie ein Mensch, der liest.
 */
const weiter = async (seite) => {
  await seite.waitForTimeout(700);
  await seite.getByRole('button', { name: /^Weiter$/ }).click();
};
const endknopf = (seite) => seite.locator('#sheet .btn--danger');

/** Zwei Chats mit zwei verschiedenen Leuten. Gibt deren Seiten zurück. */
async function zweiChats(browser) {
  const kontextA = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const gegen = [];
  for (const nick of ['Mira', 'Papa']) {
    const { link } = await createChat(seiteA, { nick: 'Anton' });
    const kontext = await browser.newContext(HANDY);
    const seite = await kontext.newPage();
    await joinChat(seite, link, { nick });
    await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
    await sendText(seiteA, `Hallo ${nick}`);
    await expect(seite.locator('#messages .msg')).toHaveCount(1, { timeout: 25_000 });
    await seiteA.locator('#chat-back').click();
    await expect(seiteA.locator('#screen-start')).toBeVisible();
    gegen.push(seite);
  }
  return { kontextA, seiteA, gegen };
}

// --------------------------------------------------------- Nicht aus Versehen

test('Der Löschknopf steckt hinter drei Hinweisen', async ({ browser }) => {
  const { kontextA, seiteA, gegen } = await zweiChats(browser);
  const page = seiteA;
  await loeschenOeffnen(page);

  // Jeder Schritt sagt etwas anderes - und zählt mit, damit man weiss, wo man ist.
  await expect(page.locator('#sheet-title')).toHaveText(/1 von 3/);
  await expect(page.locator('#sheet')).toContainText(/von diesem Gerät/i);
  await weiter(page);

  await expect(page.locator('#sheet-title')).toHaveText(/2 von 3/);
  await expect(page.locator('#sheet')).toContainText(/auch auf dem Server vernichtet/i);
  await weiter(page);

  await expect(page.locator('#sheet-title')).toHaveText(/3 von 3/);
  await expect(page.locator('#sheet')).toContainText(/kein Zurück|Papierkorb/i);

  await kontextA.close();
  for (const seite of gegen) await seite.context().close();
});

test('Abbrechen im zweiten Schritt löscht nichts', async ({ browser }) => {
  const { kontextA, seiteA, gegen } = await zweiChats(browser);
  await loeschenOeffnen(seiteA);
  await weiter(seiteA);
  await seiteA.getByRole('button', { name: /^Abbrechen$/ }).click();
  await expect(seiteA.locator('#sheet')).toBeHidden();

  await seiteA.reload();
  await expect(seiteA.locator('#chat-list .chat-list__item')).toHaveCount(2, { timeout: 25_000 });
  await kontextA.close();
  for (const seite of gegen) await seite.context().close();
});

/**
 * Der Riegel, um den es dem Nutzer ging: der letzte Knopf soll erst
 * ansprechen, wenn genug Zeit vergangen ist, um den Text darüber gelesen zu
 * haben.
 */
test('Der letzte Knopf zählt herunter, bevor er sich drücken lässt', async ({ page }) => {
  await withName(page, 'Anton');
  await page.goto('./');
  await loeschenOeffnen(page);
  await weiter(page);
  await weiter(page);

  const knopf = endknopf(page);
  await expect(knopf).toBeVisible();
  await expect(knopf).toBeDisabled();
  await expect(knopf).toHaveText(/1[0-5] s/);
  // Ein Klick darauf tut nichts - das Blatt bleibt offen.
  await knopf.click({ force: true });
  await expect(page.locator('#sheet')).toBeVisible();

  // Er zählt sichtbar herunter.
  await expect(knopf).toHaveText(/1[0-2] s/, { timeout: 6000 });
  // Und irgendwann darf er.
  await expect(knopf).toBeEnabled({ timeout: 20_000 });
  await expect(knopf).toHaveText(/Jetzt alles löschen/i);
});

/**
 * Alle drei Blaetter sind gleich aufgebaut, der Weiter-Knopf sitzt jedes Mal
 * an derselben Stelle. Ohne Sperre waeren drei Hinweise mit zwei Daumentippern
 * erledigt - und damit keine drei Hinweise mehr.
 */
test('Ein Doppeltipp überspringt keinen Hinweis', async ({ page }) => {
  await withName(page, 'Anton');
  await page.goto('./');
  await loeschenOeffnen(page);
  const titel = page.locator('#sheet-title');
  await expect(titel).toHaveText(/1 von 3/);

  // Merken, wann das zweite Blatt aufgeht - nur so laesst sich hinterher
  // belegen, dass der zweite Tipp wirklich in die Sperrzeit fiel.
  await page.evaluate(() => {
    window.__blatt2 = null;
    const kopf = document.getElementById('sheet-title');
    new MutationObserver(() => {
      if (window.__blatt2 === null && /2 von 3/.test(kopf.textContent ?? '')) {
        window.__blatt2 = performance.now();
      }
    }).observe(kopf, { childList: true, characterData: true, subtree: true });
  });

  const kasten = await page.getByRole('button', { name: /^Weiter$/ }).boundingBox();
  const punkt = { x: kasten.x + kasten.width / 2, y: kasten.y + kasten.height / 2 };
  // Das erste Blatt ist lange genug offen - der erste Tipp darf also.
  await page.waitForTimeout(800);
  await page.mouse.click(punkt.x, punkt.y);
  await expect(titel).toHaveText(/2 von 3/);

  // Der Daumen liegt noch auf derselben Stelle, und dort liegt jetzt der
  // Weiter-Knopf des zweiten Blattes.
  const ziel = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent?.trim() ?? '(nichts)',
    punkt);
  expect(ziel, 'an dieser Stelle liegt gar kein Weiter-Knopf').toMatch(/^Weiter$/);

  await page.mouse.click(punkt.x, punkt.y);
  const abstand = await page.evaluate(() => performance.now() - window.__blatt2);
  expect(abstand, 'der zweite Tipp kam zu spät - so prüft der Test nichts').toBeLessThan(600);

  // Und er ist nicht durchgeschlagen: das zweite Blatt steht noch.
  await page.waitForTimeout(300);
  await expect(titel).toHaveText(/2 von 3/);
});

/**
 * Dasselbe mit der Tastatur: wer das vorige Blatt mit der Eingabetaste
 * bestaetigt hat, darf damit nicht gleich das naechste mitbestaetigen. Der
 * Fokus liegt deshalb auf dem Blatt, nicht auf dem gefaehrlichen Knopf.
 */
test('Die Eingabetaste bestätigt keinen Hinweis von allein', async ({ page }) => {
  await withName(page, 'Anton');
  await page.goto('./');
  await loeschenOeffnen(page);
  await expect(page.locator('#sheet-title')).toHaveText(/1 von 3/);

  // Der Fokus ist im Blatt - fuer Tastatur und Screenreader -, aber auf
  // keinem Knopf.
  const fokus = await page.evaluate(() => ({
    imBlatt: !!document.activeElement?.closest('#sheet'),
    knopf: document.activeElement?.tagName,
  }));
  expect(fokus.imBlatt).toBe(true);
  expect(fokus.knopf).not.toBe('BUTTON');

  // Bewusst nach der Sperre, damit hier wirklich der Fokus geprueft wird.
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  await expect(page.locator('#sheet-title')).toHaveText(/1 von 3/);
});

// ------------------------------------------------------------ Und dann wirklich

test('Löschen räumt dieses Gerät und die Chats bei den anderen ab', async ({ browser }) => {
  const { kontextA, seiteA, gegen } = await zweiChats(browser);

  await loeschenOeffnen(seiteA);
  await expect(seiteA.locator('#sheet')).toContainText(/von diesem Gerät/i);
  await weiter(seiteA);
  await weiter(seiteA);
  // Die Zahlen im letzten Schritt sind echt.
  await expect(seiteA.locator('#sheet')).toContainText(/Betrifft 2 Chats/i);

  const knopf = endknopf(seiteA);
  await expect(knopf).toBeEnabled({ timeout: 25_000 });
  await knopf.click();

  // Dieses Gerät: keine Chats mehr, und auch der Name ist weg.
  await expect(seiteA.locator('#screen-start')).toBeVisible({ timeout: 30_000 });
  await expect(seiteA.locator('#chat-list .chat-list__item')).toHaveCount(0, { timeout: 25_000 });
  // Die Chats sind aus dem Speicher raus. (Dass gar nichts zurueckbleibt,
  // prueft der Test weiter unten - hier setzt die Testumgebung den Namen bei
  // jedem Seitenaufruf neu und wuerde das Bild verfaelschen.)
  const gemerkt = await seiteA.evaluate(() => localStorage.getItem('fc:sessions:v1'));
  expect(gemerkt, 'die Chats stehen noch im Speicher').toBeNull();

  // Und bei den anderen: die Unterhaltung ist vernichtet.
  for (const seite of gegen) {
    await expect(seite.locator('#screen-start')).toBeVisible({ timeout: 30_000 });
    await expect(seite.locator('#chat-list .chat-list__item')).toHaveCount(0, { timeout: 30_000 });
  }

  await kontextA.close();
  for (const seite of gegen) await seite.context().close();
});

/**
 * Die App wohnt womoeglich unter einem Unterpfad einer Domain, auf der noch
 * ganz andere Seiten liegen. Ein pauschales Aufräumen würde deren Daten
 * gleich mitnehmen.
 */
test('Nach dem Löschen bleibt nichts von der App zurück - und nichts Fremdes geht verloren', async ({ browser }) => {
  // Bewusst ohne die Voreinstellungen der Testumgebung: die schreibt bei
  // jedem Seitenaufruf einen Namen und wuerde wie ein Rueckstand aussehen.
  const kontext = await rawContext(browser, HANDY);
  const page = await kontext.newPage();
  await page.goto('./');
  // Ein paar eigene Spuren anlegen, damit es etwas zu loeschen gibt.
  await page.locator('#btn-theme').click();
  await page.evaluate(() => localStorage.setItem('nachbarseite:wichtig', 'bitte stehen lassen'));
  await expect.poll(() => page.evaluate(() => localStorage.getItem('fc:prefs:v1'))).not.toBeNull();

  // Ein Zeichen, das nur dieses Dokument kennt. Das Loeschen laedt die Seite
  // neu - erst wenn das Zeichen weg ist, laeuft wirklich das neue Dokument,
  // und erst dann sagt ein Blick in den Speicher etwas aus.
  await page.evaluate(() => { window.__vorDemLoeschen = true; });

  await loeschenOeffnen(page);
  await weiter(page);
  await weiter(page);
  const knopf = endknopf(page);
  await expect(knopf).toBeEnabled({ timeout: 25_000 });
  await knopf.click();

  await expect(page.locator('#screen-start')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => {
    try {
      return await page.evaluate(() => window.__vorDemLoeschen === true);
    } catch {
      // Genau waehrend der Navigation - also noch nicht so weit.
      return true;
    }
  }, { timeout: 30_000 }).toBe(false);

  const fremd = await page.evaluate(() => localStorage.getItem('nachbarseite:wichtig'));
  expect(fremd).toBe('bitte stehen lassen');
  const eigene = await page.evaluate(() =>
    Object.keys(localStorage).filter((schluessel) => schluessel.startsWith('fc:')));
  expect(eigene, `noch gespeichert: ${eigene.join(', ')}`).toEqual([]);
  await kontext.close();
});
