import { test, expect, devices } from './fixtures.js';
import { ohneNamen } from './fixtures.js';
import { makePng, createChat, joinChat, sendText, bubbles, longPress } from './helpers.js';

/** Zwei Geraete, ein Code. */
async function pairUp(browser) {
  const contextA = await browser.newContext({ ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const contextB = await browser.newContext({ ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const { code, link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible({ timeout: 15_000 });
  return { contextA, contextB, pageA, pageB, code, link };
}

test('Startseite zeigt die wichtigsten Wege', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Flüsterchat' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Neuen Chat starten/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Code eingeben/i })).toBeVisible();
});

test('Ein neuer Chat liefert Code, QR-Code und Einladungslink', async ({ page }) => {
  const { code } = await createChat(page);
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  // Keine verwechselbaren Zeichen im Code.
  expect(code).not.toMatch(/[ILOU]/);
  const qr = page.locator('#qr-frame svg');
  await expect(qr).toBeVisible();
  expect(await page.locator('#qr-frame svg path').count()).toBeGreaterThan(0);
  await expect(page.locator('#invite-status')).toContainText(/Warte auf dein Gegenüber/i);
});

test('Zwei Geräte finden über den Link zusammen und tauschen Text aus', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);

  await sendText(pageA, 'Hallo, hörst du mich?');
  await expect(bubbles(pageB).last()).toContainText('Hallo, hörst du mich?');

  await sendText(pageB, 'Laut und deutlich! 👋');
  await expect(bubbles(pageA).last()).toContainText('Laut und deutlich! 👋');

  // Ausgehende Nachrichten stehen rechts, eingehende links.
  await expect(bubbles(pageA).first()).toHaveClass(/msg--out/);
  await expect(bubbles(pageB).first()).toHaveClass(/msg--in/);

  await contextA.close();
  await contextB.close();
});

test('Der Code lässt sich auch abtippen', async ({ browser }) => {
  const contextA = await browser.newContext({ ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const contextB = await browser.newContext({ ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const { code } = await createChat(pageA);

  await pageB.goto('./');
  await pageB.getByRole('button', { name: /Code eingeben/i }).click();
  // Kleinschreibung und fehlende Bindestriche muss die App verkraften.
  await pageB.locator('#code-input').fill(code.toLowerCase().replace(/-/g, ''));
  await expect(pageB.locator('#code-input')).toHaveValue(code);
  await pageB.getByRole('button', { name: 'Beitreten', exact: true }).click();

  await expect(pageB.locator('#screen-chat')).toBeVisible({ timeout: 15_000 });
  await sendText(pageB, 'Abgetippt und drin.');
  await expect(bubbles(pageA).last()).toContainText('Abgetippt und drin.');

  await contextA.close();
  await contextB.close();
});

test('Ein Bild aus der Galerie kommt beim Gegenüber an', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);

  await pageA.locator('#file-gallery').setInputFiles({
    name: 'urlaub.png',
    mimeType: 'image/png',
    buffer: makePng(320, 200),
  });
  // Vorschau im Anhangsbereich, sobald der Upload durch ist.
  await expect(pageA.locator('#attachments .attachment')).toHaveCount(1);
  await expect(pageA.locator('#btn-send')).toBeVisible();
  await pageA.locator('#message-input').fill('Schau mal!');
  await pageA.locator('#btn-send').click();

  const incoming = pageB.locator('#messages img.bubble__image').last();
  await expect(incoming).toBeVisible({ timeout: 20_000 });
  await expect(bubbles(pageB).last()).toContainText('Schau mal!');

  // Das Bild muss beim Empfänger tatsächlich entschlüsselt und dekodiert sein.
  await expect(async () => {
    const ready = await incoming.evaluate((img) => img.dataset.ready === '1' && img.naturalWidth > 0);
    expect(ready).toBe(true);
  }).toPass({ timeout: 20_000 });
  expect(await incoming.evaluate((img) => img.naturalWidth)).toBe(320);

  // Antippen öffnet die Großansicht.
  await incoming.click();
  await expect(pageB.locator('#lightbox')).toBeVisible();
  await pageB.locator('#lightbox-close').click();
  await expect(pageB.locator('#lightbox')).toBeHidden();

  await contextA.close();
  await contextB.close();
});

test('Mehrere Bilder auf einmal', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);

  await pageA.locator('#file-gallery').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: makePng(120, 90) },
    { name: 'b.png', mimeType: 'image/png', buffer: makePng(90, 120) },
  ]);
  await expect(pageA.locator('#attachments .attachment')).toHaveCount(2);
  await expect(pageA.locator('#btn-send')).toBeVisible();
  await pageA.locator('#btn-send').click();

  await expect(pageB.locator('#messages img.bubble__image')).toHaveCount(2, { timeout: 20_000 });
  await expect(pageA.locator('#attachments')).toBeHidden();

  await contextA.close();
  await contextB.close();
});

test('Tippanzeige und Lesebestätigung', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);

  await pageB.locator('#message-input').pressSequentially('Ich schreibe gerade', { delay: 20 });
  await expect(pageA.locator('#peer-status')).toContainText(/tippt/i, { timeout: 10_000 });
  await expect(pageA.locator('#messages .typing-bubble')).toBeVisible();

  await pageB.locator('#btn-send').click();
  await expect(pageA.locator('#messages .typing-bubble')).toBeHidden();
  await expect(bubbles(pageA).last()).toContainText('Ich schreibe gerade');

  // Nachricht von A wird von B gelesen -> doppelter Haken bei A.
  await sendText(pageA, 'Gelesen?');
  await expect(bubbles(pageB).last()).toContainText('Gelesen?');
  await expect(pageA.locator('#messages .msg--out:not(.msg--typing)').last().locator('.is-read')).toBeVisible({ timeout: 10_000 });

  await contextA.close();
  await contextB.close();
});

/**
 * Die Tippblase ist keine Nachricht.
 *
 * Sie sieht aus wie eine eingehende Blase und stand auch so im Verlauf: als
 * `.msg--in`, ohne Absender und ohne Text. Wer eingehende Nachrichten zählt,
 * zählte sie mit – und wartete dann auf einen Namen, den es dort nie gab.
 * Das war der Grund für zwei Tests, die gegen das PHP-Backend immer wieder
 * grundlos umfielen: bei langem Abfragen kommt die Tippmeldung genau im
 * falschen Moment.
 */
test('Wer tippt, hat noch nichts geschickt', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);

  await sendText(pageB, 'Eine echte Nachricht');
  await expect(pageA.locator('#messages .msg--in:not(.msg--typing)')).toHaveCount(1, { timeout: 20_000 });

  // Jetzt tippt B, ohne abzuschicken.
  await pageB.locator('#message-input').pressSequentially('und noch eine', { delay: 20 });
  await expect(pageA.locator('#messages .typing-bubble')).toBeVisible({ timeout: 15_000 });

  // Solange die Blase steht, ist trotzdem nur eine Nachricht angekommen.
  // In einem Zug gezaehlt: die Tippanzeige laeuft nach ein paar Sekunden ab,
  // und ein Test, der so lange wartet, wuerde am Ende immer gruen.
  const stand = await pageA.evaluate(() => ({
    tippt: document.querySelectorAll('#messages .msg--typing').length,
    eingehend: document.querySelectorAll('#messages .msg--in:not(.msg--typing)').length,
    text: document.querySelector('#messages .msg--in:not(.msg--typing) .bubble__text')?.textContent?.trim(),
  }));
  expect(stand, `waehrend des Tippens gezaehlt: ${JSON.stringify(stand)}`)
    .toEqual({ tippt: 1, eingehend: 1, text: 'Eine echte Nachricht' });

  await contextA.close();
  await contextB.close();
});

test('Der Einmal-Code lässt keinen Dritten hinein', async ({ browser }) => {
  const { link, contextA, contextB } = await pairUp(browser);
  const contextC = await browser.newContext({ ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const pageC = await contextC.newPage();

  await pageC.goto(link);
  await expect(pageC.locator('#screen-error')).toBeVisible({ timeout: 15_000 });
  await expect(pageC.locator('#error-text')).toContainText(/voll/i);

  await contextA.close();
  await contextB.close();
  await contextC.close();
});

test('Neu laden führt zurück in denselben Chat', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);
  await sendText(pageA, 'Vor dem Neuladen');
  await expect(bubbles(pageB).last()).toContainText('Vor dem Neuladen');

  await pageB.reload();
  await expect(pageB.locator('#screen-start')).toBeVisible({ timeout: 15_000 });
  await pageB.locator('#chat-list .chat-list__item').first().click();
  await expect(pageB.locator('#screen-chat')).toBeVisible({ timeout: 15_000 });
  await expect(bubbles(pageB).last()).toContainText('Vor dem Neuladen');

  await sendText(pageB, 'Nach dem Neuladen');
  await expect(bubbles(pageA).last()).toContainText('Nach dem Neuladen');

  await contextA.close();
  await contextB.close();
});

test('Antworten, Reaktionen und Löschen', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);
  await sendText(pageA, 'Worauf ich antworte');
  await expect(bubbles(pageB).last()).toContainText('Worauf ich antworte');

  // Langes Drücken öffnet das Nachrichtenmenü.
  const target = bubbles(pageB).last().locator('.bubble');
  await target.dispatchEvent('contextmenu');
  await expect(pageB.locator('#sheet')).toBeVisible();
  await pageB.getByRole('button', { name: 'Antworten' }).click();
  await expect(pageB.locator('#reply-preview')).toBeVisible();
  await sendText(pageB, 'Meine Antwort');
  await expect(bubbles(pageA).last().locator('.quote')).toContainText('Worauf ich antworte');

  // Reaktion setzen.
  await bubbles(pageA).last().locator('.bubble').dispatchEvent('contextmenu');
  await pageA.locator('.emoji-row button').first().click();
  await expect(bubbles(pageB).last().locator('.reaction')).toHaveText('👍', { timeout: 10_000 });

  // Eigene Nachricht löschen.
  await bubbles(pageB).last().locator('.bubble').dispatchEvent('contextmenu');
  await pageB.getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect(bubbles(pageA).last()).toContainText(/gelöscht/i, { timeout: 10_000 });

  await contextA.close();
  await contextB.close();
});

test('Chat löschen räumt bei beiden auf', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);
  await sendText(pageA, 'Gleich ist alles weg');
  await expect(bubbles(pageB).last()).toContainText('Gleich ist alles weg');

  await pageA.locator('#chat-menu').click();
  await pageA.getByRole('button', { name: /unwiderruflich löschen/i }).click();
  await pageA.getByRole('button', { name: /Ja, löschen/i }).click();

  await expect(pageA.locator('#screen-start')).toBeVisible({ timeout: 15_000 });
  await expect(pageB.locator('#screen-start')).toBeVisible({ timeout: 15_000 });
  await expect(pageB.locator('#chats-section')).toBeHidden();

  await contextA.close();
  await contextB.close();
});

test('Langes Drücken öffnet das Menü, statt Text zu markieren', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);
  await sendText(pageA, 'Diesen Text soll der Finger nicht markieren');
  await expect(bubbles(pageB).last()).toContainText('Diesen Text');
  const bubble = bubbles(pageB).last().locator('.bubble');

  // Am Touchgerät soll der Browser gar nicht erst anfangen zu markieren.
  await expect(bubble).toHaveCSS('user-select', 'none');

  // Und eine Markierung, die noch von woanders herrührt - hier aus der
  // Kopfzeile -, muss verschwinden, sobald das Menü kommt. Sonst leuchtet sie
  // blau hinter dem Menü weiter.
  await pageB.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('peer-name'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  expect(await pageB.evaluate(() => window.getSelection().toString())).not.toBe('');

  await longPress(pageB, bubble);
  await expect(pageB.locator('#sheet')).toBeVisible();
  expect(await pageB.evaluate(() => window.getSelection().toString())).toBe('');
  await expect(pageB.getByRole('button', { name: 'Antworten' })).toBeVisible();

  await contextA.close();
  await contextB.close();
});

test('Rutscht der Finger weg, bleibt der nächste Tipp trotzdem wirksam', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);
  await sendText(pageA, 'Reaktion drauf');
  await expect(bubbles(pageB).last()).toContainText('Reaktion drauf');

  // Halten, dann noch am Bildschirm entlangrutschen: Chromium schickt danach
  // keinen Geisterklick mehr. Wer blind auf einen wartet, verschluckt
  // stattdessen den nächsten echten Tipp - hier das Reaktions-Emoji.
  await longPress(pageB, bubbles(pageB).last().locator('.bubble'), { ms: 900, slideY: -25 });
  await expect(pageB.locator('#sheet')).toBeVisible();
  await pageB.locator('.emoji-row button').first().click();
  await expect(bubbles(pageA).last().locator('.reaction')).toHaveText('👍', { timeout: 10_000 });

  await contextA.close();
  await contextB.close();
});

test('Eigene Emoji als Reaktion: suchen, wählen, gemerkt bekommen', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);
  await sendText(pageA, 'Worauf reagiert wird');
  await expect(bubbles(pageB).last()).toContainText('Worauf reagiert wird');

  await bubbles(pageB).last().locator('.bubble').dispatchEvent('contextmenu');
  await pageB.locator('.emoji-more').click();

  // Suche auf Deutsch findet, was die Vorgabereihe nicht hergibt.
  await pageB.locator('.emoji-search').fill('einhorn');
  const treffer = pageB.locator('.emoji-picker .emoji-grid:not([hidden]) button').first();
  await expect(treffer).toHaveText('🦄');
  await treffer.click();

  await expect(bubbles(pageA).last().locator('.reaction')).toHaveText('🦄', { timeout: 10_000 });

  // Beim nächsten Mal steht es vorn in der Schnellreihe.
  await bubbles(pageB).last().locator('.bubble').dispatchEvent('contextmenu');
  await expect(pageB.locator('.emoji-row button').first()).toHaveText('🦄');
  await pageB.keyboard.press('Escape');

  await contextA.close();
  await contextB.close();
});

test('Ein eingefügtes Emoji lässt sich ohne Katalog verschicken', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);
  await sendText(pageA, 'Etwas Ausgefallenes');
  await expect(bubbles(pageB).last()).toContainText('Etwas Ausgefallenes');

  await bubbles(pageB).last().locator('.bubble').dispatchEvent('contextmenu');
  await pageB.locator('.emoji-more').click();
  // Steht so nicht im mitgelieferten Katalog.
  await pageB.locator('.emoji-search').fill('🫎');
  const treffer = pageB.locator('.emoji-picker .emoji-grid:not([hidden]) button').first();
  await expect(treffer).toHaveText('🫎');
  await treffer.click();

  await expect(bubbles(pageA).last().locator('.reaction')).toHaveText('🫎', { timeout: 10_000 });

  await contextA.close();
  await contextB.close();
});

test('Die Emoji-Suche kennt auch Englisch', async ({ browser }) => {
  const { pageB, contextA, contextB } = await pairUp(browser);
  await sendText(pageB, 'Egal was');
  await bubbles(pageB).last().locator('.bubble').dispatchEvent('contextmenu');
  await pageB.locator('.emoji-more').click();
  await pageB.locator('.emoji-search').fill('rocket');
  await expect(pageB.locator('.emoji-picker .emoji-grid:not([hidden]) button').first()).toHaveText('🚀');
  await contextA.close();
  await contextB.close();
});

test('Ohne eigenen Namen fragt die App beim ersten Chat danach', async ({ browser }) => {
  const contextA = await browser.newContext({ ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const contextB = await browser.newContext({ ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  // Bewusst ohne Namen: genau dann soll gefragt werden.
  await ohneNamen(pageA);
  await ohneNamen(pageB);
  const { link } = await createChat(pageA, { nick: null });
  await joinChat(pageB, link, { nick: null });

  const sheet = pageB.locator('#sheet');
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet).toContainText(/Dein Name/i);
  await sheet.locator('input').fill('Mara');
  await sheet.getByRole('button', { name: /Speichern/i }).click();
  await expect(sheet).toBeHidden();

  // Der Name steht beim Gegenüber und bleibt für den nächsten Chat gemerkt.
  await expect(pageA.locator('#peer-name')).toHaveText('Mara', { timeout: 15_000 });
  expect(await pageB.evaluate(() => JSON.parse(localStorage.getItem('fc:prefs:v1')).nick)).toBe('Mara');

  await contextA.close();
  await contextB.close();
});

test('Wer schon einen Namen hat, wird nicht gefragt', async ({ browser }) => {
  const { pageB, contextA, contextB } = await pairUp(browser);
  await expect(bubbles(pageB)).toHaveCount(0);
  await expect(pageB.locator('#sheet')).toBeHidden();
  await contextA.close();
  await contextB.close();
});

test('Am Handy macht Enter eine neue Zeile, statt abzuschicken', async ({ browser }) => {
  // Die andere Hälfte der Regel, die am Rechner geprüft wird. Fällt die
  // Abfrage auf grobe Zeiger weg, ist die halbe Nachricht raus, sobald jemand
  // auf der Bildschirmtastatur die Eingabetaste für einen Absatz benutzt.
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);
  const input = pageA.locator('#message-input');
  await input.fill('Erste Zeile');
  await input.press('Enter');
  await input.type('Zweite Zeile');

  expect(await input.inputValue()).toBe('Erste Zeile\nZweite Zeile');
  await expect(bubbles(pageB)).toHaveCount(0);

  await contextA.close();
  await contextB.close();
});

/**
 * Ein winziges GIF (1x1, durchsichtig) - echte Bytes, damit der ganze Weg
 * durchläuft: holen, verschlüsseln, hochladen, entschlüsseln, anzeigen.
 */
const MINI_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Stellt sich als Backend-GIF-Suche - ohne Schlüssel, ohne Netz. */
async function fakeGifService(page) {
  await page.route('**/api/config', async (route) => {
    const antwort = await route.fetch();
    const daten = await antwort.json();
    await route.fulfill({ json: { ...daten, gifs: true } });
  });
  await page.route('**/api/gifs?*', async (route) => {
    const url = new URL(route.request().url());
    const query = url.searchParams.get('q') ?? '';
    await route.fulfill({
      json: {
        items: Array.from({ length: 4 }, (_, i) => ({
          id: `gif${i}`,
          title: `${query || 'beliebt'} ${i}`,
          width: 100,
          height: 80,
          preview: `vorschau-${i}`,
          full: `voll-${i}`,
          bytes: MINI_GIF.length,
        })),
        next: null,
      },
    });
  });
  await page.route('**/api/gifs/media?*', async (route) => {
    await route.fulfill({ body: MINI_GIF, contentType: 'image/gif' });
  });
}

test('Ein GIF geht verschlüsselt raus, ohne dass jemand mit Giphy spricht', async ({ browser }) => {
  const contextA = await browser.newContext({ ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const contextB = await browser.newContext({ ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  // Mitschreiben, wohin die Browser überhaupt sprechen.
  const fremdeZiele = [];
  for (const page of [pageA, pageB]) {
    page.on('request', (request) => {
      const host = new URL(request.url()).host;
      if (host !== '127.0.0.1:3199' && !host.startsWith('127.0.0.1')) fremdeZiele.push(host);
    });
  }
  await fakeGifService(pageA);
  await fakeGifService(pageB);

  const { link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible({ timeout: 15_000 });

  await pageA.locator('#btn-attach').click();
  await pageA.getByRole('button', { name: /GIF suchen/i }).click();
  await expect(pageA.locator('.gif-grid__item').first()).toBeVisible({ timeout: 15_000 });

  await pageA.locator('.gif-picker .emoji-search').fill('applaus');
  await expect(pageA.locator('.gif-grid__item').first()).toBeVisible();
  await pageA.locator('.gif-grid__item').first().click();

  // Landet als Anhang im Eingabefeld und wird verschlüsselt hochgeladen.
  await expect(pageA.locator('#attachments .attachment')).toHaveCount(1);
  await expect(pageA.locator('#btn-send')).toBeVisible();
  await pageA.locator('#btn-send').click();

  // Kommt beim Gegenüber als ganz normales Bild an.
  await expect(bubbles(pageB).last().locator('.bubble__image')).toBeVisible({ timeout: 20_000 });

  // Und niemand hat dafür mit einer fremden Adresse gesprochen.
  expect(fremdeZiele).toEqual([]);

  await contextA.close();
  await contextB.close();
});

test('Ohne eingerichtete GIF-Suche gibt es den Eintrag gar nicht', async ({ browser }) => {
  const { pageA, contextA, contextB } = await pairUp(browser);
  await pageA.locator('#btn-attach').click();
  await expect(pageA.locator('#sheet')).toBeVisible();
  await expect(pageA.getByRole('button', { name: /Foto aus der Galerie/i })).toBeVisible();
  // Lieber gar kein Eintrag als einer, der ins Leere führt.
  await expect(pageA.getByRole('button', { name: /GIF suchen/i })).toHaveCount(0);
  await contextA.close();
  await contextB.close();
});
