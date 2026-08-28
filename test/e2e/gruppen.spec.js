/**
 * Gruppen im echten Browser.
 *
 * Der Kern ist ein Versprechen, das man nur im Zusammenspiel pruefen kann:
 * jede Person bekommt einen eigenen Code, jeder gilt genau einmal, und
 * trotzdem lesen am Ende alle dieselben Nachrichten. Wer einen Code
 * weitergibt, gibt genau einen Platz weiter - nicht die Gruppe.
 */
import { test, expect, devices, ohneNamen } from './fixtures.js';
import { createChat, joinChat, withName } from './helpers.js';

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

/** Legt eine Gruppe an und gibt die Links zurueck - einen je Person. */
async function createGroup(page, { name = 'Verein', count = 2, nick = 'Anton' } = {}) {
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

async function joinGroup(page, link, nick) {
  await withName(page, nick);
  await page.goto(link);
  await expect(page.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
}

const senden = async (page, text) => {
  await page.locator('#message-input').fill(text);
  await page.locator('#btn-send').click();
};

test('Eine Gruppe bekommt einen Code je Person', async ({ page }) => {
  const links = await createGroup(page, { count: 3 });
  expect(links).toHaveLength(3);
  // Drei verschiedene Codes - kein einziger doppelt.
  expect(new Set(links).size).toBe(3);
  await expect(page.locator('#group-progress')).toContainText('1 von 4');
});

test('Drei Leute reden in derselben Gruppe', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const [linkB, linkC] = await createGroup(seiteA, { name: 'Verein', count: 2, nick: 'Anton' });

  const kontextB = await browser.newContext(HANDY);
  const kontextC = await browser.newContext(HANDY);
  const seiteB = await kontextB.newPage();
  const seiteC = await kontextC.newPage();
  await joinGroup(seiteB, linkB, 'Mira');
  await joinGroup(seiteC, linkC, 'Ben');

  await seiteA.locator('#btn-group-to-chat').click();
  await expect(seiteA.locator('#screen-chat')).toBeVisible();

  await senden(seiteB, 'Hallo zusammen');
  // Beide anderen sehen es - und sehen, von wem es kommt.
  for (const seite of [seiteA, seiteC]) {
    await expect(seite.locator('#messages .msg--in:not(.msg--typing)').last()).toContainText('Hallo zusammen', { timeout: 25_000 });
    await expect(seite.locator('#messages .msg--in:not(.msg--typing)').last().locator('.bubble__from')).toHaveText('Mira');
  }

  await senden(seiteC, 'Moin');
  await expect(seiteB.locator('#messages .msg--in:not(.msg--typing)').last()).toContainText('Moin', { timeout: 25_000 });

  await kontextA.close();
  await kontextB.close();
  await kontextC.close();
});

/** Der eigentliche Sinn der Einmal-Codes. */
test('Ein Code laesst sich kein zweites Mal einloesen', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const [link] = await createGroup(seiteA, { count: 2 });

  const kontextB = await browser.newContext(HANDY);
  const seiteB = await kontextB.newPage();
  await joinGroup(seiteB, link, 'Mira');

  // Jemand anderes probiert denselben Link.
  const kontextX = await browser.newContext(HANDY);
  const seiteX = await kontextX.newPage();
  await seiteX.goto(link);
  await expect(seiteX.locator('#screen-error')).toBeVisible({ timeout: 25_000 });
  await expect(seiteX.locator('#error-text')).toContainText(/eingelöst/i);

  await kontextA.close();
  await kontextB.close();
  await kontextX.close();
});

test('In einer Gruppe wird nicht telefoniert', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const [link] = await createGroup(seiteA, { count: 2 });
  const kontextB = await browser.newContext(HANDY);
  const seiteB = await kontextB.newPage();
  await joinGroup(seiteB, link, 'Mira');

  await seiteA.locator('#btn-group-to-chat').click();
  await expect(seiteA.locator('#screen-chat')).toBeVisible();
  // Der Aushandlungskanal geht an alle, und der Medienschluessel haengt am
  // Raumschluessel - bis das geloest ist, gibt es hier keinen Knopf.
  await expect(seiteA.locator('#btn-call-audio')).toBeHidden();
  await expect(seiteA.locator('#btn-call-video')).toBeHidden();

  await kontextA.close();
  await kontextB.close();
});

test('Die Gruppe steht mit ihrem Namen in der Uebersicht', async ({ page }) => {
  await createGroup(page, { name: 'Kegelclub', count: 2 });
  await page.locator('#group-back').click();
  await expect(page.locator('#chat-list')).toContainText('Kegelclub');
});

test('Die Codes bleiben aus dem Chat heraus erreichbar', async ({ page }) => {
  // Wer eine Gruppe anlegt, verteilt die Codes selten in einem Rutsch.
  await createGroup(page, { count: 2 });
  await page.locator('#btn-group-to-chat').click();
  await expect(page.locator('#screen-chat')).toBeVisible();

  await page.locator('#chat-menu').click();
  await page.getByRole('button', { name: /Ein Code für jede Person/i }).click();
  await expect(page.locator('#screen-group')).toBeVisible();
  await expect(page.locator('#group-codes .invite-row')).toHaveCount(2);
});

test('Wer beigetreten ist, bekommt keine fremden Codes zu sehen', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const [link] = await createGroup(seiteA, { count: 2 });

  const kontextB = await browser.newContext(HANDY);
  const seiteB = await kontextB.newPage();
  await joinGroup(seiteB, link, 'Mira');

  // Der Beitretende hat nur seinen eigenen Code gehabt, und der ist
  // verbraucht. Es gibt fuer ihn nichts zu verteilen.
  await seiteB.locator('#chat-menu').click();
  await expect(seiteB.locator('#sheet')).toBeVisible();
  await expect(seiteB.getByRole('button', { name: /Ein Code für jede Person/i })).toHaveCount(0);
  // Und einen Geraete-Link gibt es hier auch nicht - der haengt am Code.
  await expect(seiteB.getByRole('button', { name: /Weiteres eigenes Gerät/i })).toHaveCount(0);

  await kontextA.close();
  await kontextB.close();
});

/**
 * Die Gegenprobe zum Test darueber: im Zweiergespraech stehen beide Eintraege
 * sehr wohl im Menue. Ohne sie waeren die "gibt es nicht"-Zusicherungen auch
 * dann erfuellt, wenn die Eintraege ueberall verschwunden waeren.
 */
test('Im Zweiergespraech stehen Code und Geraete-Link im Menue', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });

  await seiteA.locator('#chat-menu').click();
  await expect(seiteA.getByRole('button', { name: /Weiteres eigenes Gerät/i })).toHaveCount(1);
  await expect(seiteA.getByRole('button', { name: /Code anzeigen/i })).toHaveCount(1);
  // Und die Codeliste einer Gruppe hat hier nichts zu suchen.
  await expect(seiteA.getByRole('button', { name: /Ein Code für jede Person/i })).toHaveCount(0);

  await kontextA.close();
  await kontextB.close();
});

/**
 * Der einzige Schutz gegen einen Server, der jemanden in einen fremden Raum
 * lotst.
 *
 * Im Platzpaket steht, wozu der Schluessel gehoert - Raum und Name. Der
 * Client vergleicht das mit dem, was ihm der Server nebenher sagt. Stimmt es
 * nicht ueberein, wird abgebrochen. Ohne diesen Vergleich koennte ein
 * uebernommener Server Leute in einen von ihm vorbereiteten Raum schicken,
 * und niemand wuerde etwas merken.
 */
test('Ein Server, der einen anderen Raum nennt, kommt nicht durch', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const [link] = await createGroup(seiteA, { count: 2 });

  const kontextB = await browser.newContext(HANDY);
  const seiteB = await kontextB.newPage();
  await withName(seiteB, 'Mira');
  // Die Antwort auf das Einloesen unterwegs verbiegen: derselbe Schluessel,
  // aber ein anderer Raum.
  await seiteB.route('**/api/slots/*/claim', async (route) => {
    const antwort = await route.fetch();
    const daten = await antwort.json();
    await route.fulfill({
      response: antwort,
      json: { ...daten, roomId: 'AAAAAAAAAAAAAAAAAAAAAA' },
    });
  });
  await seiteB.goto(link);

  await expect(seiteB.locator('#screen-error')).toBeVisible({ timeout: 25_000 });
  await expect(seiteB.locator('#error-text')).toContainText(/Sicherheit/i);
  await expect(seiteB.locator('#screen-chat')).toBeHidden();

  await kontextA.close();
  await kontextB.close();
});

test('Ein untergeschobenes Platzpaket kommt nicht durch', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const [link] = await createGroup(seiteA, { count: 2 });

  const kontextB = await browser.newContext(HANDY);
  const seiteB = await kontextB.newPage();
  await withName(seiteB, 'Mira');
  await seiteB.route('**/api/slots/*/claim', async (route) => {
    const antwort = await route.fetch();
    const daten = await antwort.json();
    // Ein Paket, das mit diesem Code nicht aufgeht.
    await route.fulfill({ response: antwort, json: { ...daten, wrapped: 'AAAA'.repeat(20) } });
  });
  await seiteB.goto(link);

  await expect(seiteB.locator('#screen-error')).toBeVisible({ timeout: 25_000 });
  // Dieselbe klare Ansage wie beim falschen Raum - nicht irgendein Fehler,
  // der zufaellig auch auftaeme, wenn der Riegel fehlte.
  await expect(seiteB.locator('#error-text')).toContainText(/Sicherheit/i);
  await expect(seiteB.locator('#screen-chat')).toBeHidden();

  await kontextA.close();
  await kontextB.close();
});

test('Neu laden fuehrt zurueck in dieselbe Gruppe', async ({ browser }) => {
  // Der Raum einer Gruppe laesst sich aus keinem Code wiederherstellen - er
  // steht nur in der Sitzung auf dem Geraet. Und der Platz ist verbraucht,
  // ein zweites Einloesen gibt es nicht. Wer neu laedt, muss also ueber sein
  // Zugangstoken wieder hereinkommen.
  const kontextA = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const [link] = await createGroup(seiteA, { name: 'Verein', count: 2 });

  const kontextB = await browser.newContext(HANDY);
  const seiteB = await kontextB.newPage();
  await joinGroup(seiteB, link, 'Mira');
  await seiteB.locator('#message-input').fill('Bin da');
  await seiteB.locator('#btn-send').click();
  await expect(seiteB.locator('#messages .msg:not(.msg--typing)')).toHaveCount(1);

  await seiteB.reload();
  // Wie bei einem Zweiergespraech landet man auf der Uebersicht und tippt
  // den Chat an - nur muss er dort ueberhaupt stehen und wieder aufgehen.
  await expect(seiteB.locator('#screen-start')).toBeVisible({ timeout: 25_000 });
  await expect(seiteB.locator('#chat-list')).toContainText('Verein');
  await seiteB.locator('#chat-list .chat-list__item').first().click();
  await expect(seiteB.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  await expect(seiteB.locator('#peer-name')).toHaveText('Verein');
  await expect(seiteB.locator('#messages .msg:not(.msg--typing)')).toHaveCount(1, { timeout: 25_000 });
  await expect(seiteB.locator('#messages .msg:not(.msg--typing)').first()).toContainText('Bin da');

  await kontextA.close();
  await kontextB.close();
});

/**
 * Ohne eigenen Namen hiessen in einer Gruppe alle gleich - und man wuesste
 * bei keiner Blase, von wem sie kommt. Durchnummeriert wird nach der
 * Mitglieds-Kennung, damit dieselbe Person auf jedem Geraet gleich heisst.
 */
test('Namenlose in einer Gruppe bleiben unterscheidbar', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const kontextC = await browser.newContext(HANDY);
  // Diese beiden geben sich bewusst keinen Namen.
  await ohneNamen(kontextB);
  await ohneNamen(kontextC);

  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const seiteC = await kontextC.newPage();
  const [linkB, linkC] = await createGroup(seiteA, { count: 2, nick: 'Anton' });

  for (const [seite, link] of [[seiteB, linkB], [seiteC, linkC]]) {
    await seite.goto(link);
    await expect(seite.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
    // Die Namensfrage wegtippen - genau darum geht es hier.
    await expect(seite.locator('#sheet')).toBeVisible({ timeout: 10_000 });
    await seite.keyboard.press('Escape');
    await expect(seite.locator('#sheet')).toBeHidden();
  }

  await seiteA.locator('#btn-group-to-chat').click();
  await seiteB.locator('#message-input').fill('Eins');
  await seiteB.locator('#btn-send').click();
  await seiteC.locator('#message-input').fill('Zwei');
  await seiteC.locator('#btn-send').click();

  await expect(seiteA.locator('#messages .msg--in:not(.msg--typing)')).toHaveCount(2, { timeout: 25_000 });
  const namen = await seiteA.locator('#messages .msg--in:not(.msg--typing) .bubble__from').allInnerTexts();
  expect(namen).toHaveLength(2);
  expect(namen[0]).not.toBe(namen[1]);
  for (const name of namen) expect(name).toMatch(/Ohne Namen \d/);

  await kontextA.close();
  await kontextB.close();
  await kontextC.close();
});

/**
 * Die Nummern der Namenlosen bleiben, auch wenn jemand geht.
 *
 * Sonst ruecken alle dahinter eine Nummer vor - und der ganze schon gelesene
 * Verlauf traegt ploetzlich andere Namen. Wer gestern mit "Ohne Namen 2"
 * geschrieben hat, redet heute scheinbar mit einer anderen Person.
 */
test('Geht ein Namenloser, behalten die anderen ihre Nummer', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const kontextC = await browser.newContext(HANDY);
  await ohneNamen(kontextB);
  await ohneNamen(kontextC);

  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const seiteC = await kontextC.newPage();
  const [linkB, linkC] = await createGroup(seiteA, { count: 2, nick: 'Anton' });

  for (const [seite, link] of [[seiteB, linkB], [seiteC, linkC]]) {
    await seite.goto(link);
    await expect(seite.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
    await expect(seite.locator('#sheet')).toBeVisible({ timeout: 10_000 });
    await seite.keyboard.press('Escape');
    await expect(seite.locator('#sheet')).toBeHidden();
  }
  await seiteA.locator('#btn-group-to-chat').click();
  await senden(seiteB, 'Eins');
  await senden(seiteC, 'Zwei');
  await expect(seiteA.locator('#messages .msg--in:not(.msg--typing)')).toHaveCount(2, { timeout: 25_000 });

  // Wer ist wer? Aus A's Sicht: welcher Name steht ueber welcher Nachricht.
  const zuordnung = await seiteA.evaluate(() => {
    const paare = {};
    for (const blase of document.querySelectorAll('#messages .msg--in:not(.msg--typing) .bubble')) {
      const name = blase.querySelector('.bubble__from')?.textContent?.trim();
      const text = blase.querySelector('.bubble__text')?.textContent?.trim();
      if (name && text) paare[text] = name;
    }
    return paare;
  });
  expect(Object.keys(zuordnung).sort()).toEqual(['Eins', 'Zwei']);

  // Es geht der, der "Ohne Namen 1" heisst - nur so ist ueberhaupt eine
  // Nummer da, die vorruecken koennte.
  const ersterText = Object.keys(zuordnung).find((text) => /1$/.test(zuordnung[text]));
  expect(ersterText, `Namen: ${JSON.stringify(zuordnung)}`).toBeTruthy();
  const bleibt = ersterText === 'Eins' ? 'Zwei' : 'Eins';
  const gehtSeite = ersterText === 'Eins' ? seiteB : seiteC;

  await gehtSeite.evaluate(async () => {
    const [sitzung] = JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]');
    await fetch(new URL(`api/rooms/${sitzung.roomId}/leave`, location.href), {
      method: 'POST',
      headers: { 'x-room-token': sitzung.token },
    });
  });
  await expect(seiteA.locator('#messages')).toContainText(/hat die Gruppe verlassen/i, { timeout: 30_000 });

  // Die verbliebene Blase traegt genau denselben Namen wie vorher.
  const nachher = await seiteA.locator('#messages .msg--in:not(.msg--typing) .bubble__from').allInnerTexts();
  expect(nachher).toHaveLength(1);
  expect(nachher[0], `vorher hiess "${bleibt}" noch ${zuordnung[bleibt]}`).toBe(zuordnung[bleibt]);

  await kontextA.close();
  await kontextB.close();
  await kontextC.close();
});
