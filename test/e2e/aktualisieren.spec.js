/**
 * Die Aufforderung, die App zu aktualisieren.
 *
 * Der Fall, um den es geht: auf dem Server liegt eine neue Fassung, im
 * Browser klebt noch die alte. Bisher merkte das niemand - man sah einfach
 * keine neuen Funktionen und hielt sie für nicht gebaut. Jetzt legt sich ein
 * Fenster über alles, das sich nicht wegklicken lässt, und ein Knopf holt
 * alles frisch vom Server.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat } from './helpers.js';

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

/** Lässt den Server eine andere Fassung melden, als der Browser geladen hat. */
async function fremdeFassung(page, version = 'ganz-andere-fassung') {
  await page.route('**/api/config*', async (route) => {
    const antwort = await route.fetch();
    const daten = await antwort.json().catch(() => ({}));
    await route.fulfill({ json: { ...daten, version } });
  });
}

test('Bei gleicher Fassung erscheint nichts', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Flüsterchat' })).toBeVisible();
  await expect(page.locator('#update')).toBeHidden();
});

test('Eine neue Fassung auf dem Server legt die App still', async ({ browser }) => {
  const kontext = await browser.newContext(HANDY);
  const seite = await kontext.newPage();
  await fremdeFassung(seite);
  await seite.goto('./');

  const fenster = seite.locator('#update');
  await expect(fenster).toBeVisible({ timeout: 20_000 });
  await expect(fenster).toContainText(/Neue Fassung/i);
  await expect(seite.getByRole('button', { name: /Jetzt aktualisieren/i })).toBeVisible();

  // Es lässt sich nicht wegklicken: weder mit Escape ...
  await seite.keyboard.press('Escape');
  await expect(fenster).toBeVisible();
  // ... noch durch Tippen daneben.
  await seite.mouse.click(10, 10);
  await expect(fenster).toBeVisible();

  // Und darunter ist nichts mehr zu erreichen. Das Fenster deckt das ganze
  // Sichtfeld ab ...
  const kasten = await fenster.boundingBox();
  const sichtfeld = seite.viewportSize();
  expect(kasten.width).toBeGreaterThanOrEqual(sichtfeld.width - 1);
  expect(kasten.height).toBeGreaterThanOrEqual(sichtfeld.height - 1);
  // ... und der Knopf darunter nimmt keinen Tipp mehr an. Genau darum geht
  // es: mit einer veralteten Kopie soll man gar nicht erst weiterarbeiten
  // koennen. (Sichtbar im Sinne des Browsers ist er noch - er ist ja nur
  // verdeckt; das allein waere also keine Zusicherung.)
  await expect(
    seite.getByRole('button', { name: /Neuen Chat starten/i }).click({ timeout: 2000 }),
  ).rejects.toThrow();

  await kontext.close();
});

test('Der Knopf holt alles frisch und räumt die Adresszeile wieder auf', async ({ browser }) => {
  // Der Service Worker bleibt hier aus. Er raeumt veraltete Speicher von
  // sich aus weg - und wuerde damit genau das erledigen, was hier geprueft
  // werden soll. Ohne ihn ist der Knopf der einzige, der aufraeumen kann.
  // (Eine Route auf sw.js genuegt dafuer nicht: Anfragen des Workers laufen
  // an den Routen der Seite vorbei.)
  const kontext = await browser.newContext({ ...HANDY, serviceWorkers: 'block' });
  const seite = await kontext.newPage();
  await fremdeFassung(seite);
  await seite.goto('./');
  await expect(seite.locator('#update')).toBeVisible({ timeout: 20_000 });

  // Einen Speicher aus einer alten Fassung unterschieben. Genau so einer
  // haelt sonst die alte Huelle fest und liefert sie nach dem Neuladen
  // gleich wieder aus.
  await seite.evaluate(() => caches.open('fluesterchat-shell-uralt-/').then((c) => c.put(
    new Request('./js/app.js', { method: 'GET' }),
    new Response('// steinalt', { headers: { 'content-type': 'text/javascript' } }),
  )));
  expect(await seite.evaluate(() => caches.keys())).toContain('fluesterchat-shell-uralt-/');

  // Jede Navigation mitschreiben: der Knopf muss die Seite wirklich neu
  // holen, und zwar an einer Adresse, die kein Zwischenspeicher schon kennt.
  const angesteuert = [];
  seite.on('framenavigated', (rahmen) => {
    if (rahmen === seite.mainFrame()) angesteuert.push(rahmen.url());
  });

  // Auf dem Server steht jetzt wieder dieselbe Fassung wie im Browser -
  // so wie nach einer echten Aktualisierung.
  await seite.unroute('**/api/config*');
  await seite.getByRole('button', { name: /Jetzt aktualisieren/i }).click();

  // Die Seite wurde neu geladen und meldet sich ohne Aufforderung zurück.
  await expect(seite.getByRole('button', { name: /Neuen Chat starten/i })).toBeVisible({ timeout: 20_000 });
  await expect(seite.locator('#update')).toBeHidden();

  // Der Abruf lief über eine einmalige Adresse - ohne die bediente der
  // Browser sich womöglich aus seinem eigenen Zwischenspeicher.
  expect(angesteuert.some((adresse) => adresse.includes('frisch=')))
    .toBe(true);
  // Und danach ist das Anhängsel wieder weg: in einem geteilten Link hätte
  // es nichts verloren.
  //
  // Abgewartet statt einmal nachgesehen: die beiden Zusicherungen darüber
  // sind schon im rohen HTML erfüllt - der Knopf steht da, und #update trägt
  // von Haus aus `hidden`. Sie sagen also nichts darüber, ob das Skript
  // überhaupt schon gelaufen ist, und dropCacheBuster() räumt erst dort auf.
  // Unter Last las der Test die Adresszeile, bevor es so weit war.
  await expect.poll(() => seite.url(), { timeout: 10_000 }).not.toContain('frisch=');

  // Der untergeschobene Speicher ist weg - und weil hier kein Service Worker
  // läuft, kann ihn nur der Knopf geräumt haben.
  expect(await seite.evaluate(() => caches.keys())).not.toContain('fluesterchat-shell-uralt-/');
});

test('Bestehende Chats überleben das Aktualisieren', async ({ browser }) => {
  const kontext = await browser.newContext(HANDY);
  const seite = await kontext.newPage();
  const { code } = await createChat(seite, { nick: 'Anton' });
  await seite.locator('#invite-back').click();
  await expect(seite.locator('#chat-list .chat-list__item')).toHaveCount(1);

  await fremdeFassung(seite);
  await seite.reload();
  await expect(seite.locator('#update')).toBeVisible({ timeout: 20_000 });

  await seite.unroute('**/api/config*');
  await seite.getByRole('button', { name: /Jetzt aktualisieren/i }).click();
  await expect(seite.locator('#update')).toBeHidden({ timeout: 20_000 });

  // Der Chat ist noch da - Aktualisieren darf nichts wegwerfen.
  await expect(seite.locator('#chat-list .chat-list__item')).toHaveCount(1);
  await expect(seite.locator('#chat-list .chat-list__meta').first()).toContainText(code);

  await kontext.close();
});

test('Ohne Auskunft über die Fassung passiert nichts', async ({ browser }) => {
  const kontext = await browser.newContext(HANDY);
  const seite = await kontext.newPage();
  // Eine ältere Auslieferung kennt das Feld gar nicht. Niemand soll deswegen
  // aus seinem Chat ausgesperrt werden.
  await seite.route('**/api/config*', async (route) => {
    const antwort = await route.fetch();
    const daten = await antwort.json().catch(() => ({}));
    delete daten.version;
    await route.fulfill({ json: daten });
  });
  await seite.goto('./');
  await expect(seite.getByRole('button', { name: /Neuen Chat starten/i })).toBeVisible();
  await seite.waitForTimeout(1500);
  await expect(seite.locator('#update')).toBeHidden();

  await kontext.close();
});

test('Auch ein unerreichbarer Server sperrt niemanden aus', async ({ browser }) => {
  const kontext = await browser.newContext(HANDY);
  const seite = await kontext.newPage();
  await seite.goto('./');
  await expect(seite.getByRole('button', { name: /Neuen Chat starten/i })).toBeVisible();
  await seite.route('**/api/config*', (route) => route.abort());
  await seite.reload();
  await expect(seite.getByRole('button', { name: /Neuen Chat starten/i })).toBeVisible();
  await seite.waitForTimeout(1500);
  await expect(seite.locator('#update')).toBeHidden();

  await kontext.close();
});
