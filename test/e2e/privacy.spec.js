import { test, expect, devices } from '@playwright/test';
import { createChat, joinChat, sendText, bubbles } from './helpers.js';

const MOBILE = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

test('Der Server bekommt nur unlesbare Daten zu sehen', async ({ browser }) => {
  const contextA = await browser.newContext(MOBILE);
  const contextB = await browser.newContext(MOBILE);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  // Alles mitschreiben, was der Browser Richtung Server schickt.
  const sentFrames = [];
  const requestUrls = [];
  pageA.on('websocket', (socket) => {
    socket.on('framesent', (frame) => sentFrames.push(frame.payload));
  });
  pageA.on('request', (request) => requestUrls.push(request.url()));

  const { code, link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible();

  const secret = 'Streng-geheime-Nachricht-42-Kaktus';
  await sendText(pageA, secret);
  await expect(bubbles(pageB).last()).toContainText(secret);

  const outgoing = sentFrames.join('\n');
  expect(outgoing.length).toBeGreaterThan(0);
  expect(outgoing).not.toContain(secret);
  expect(outgoing).not.toContain(code);
  expect(outgoing).not.toContain(code.replace(/-/g, ''));

  // Der Code darf auch nie in einer URL landen - Fragmente bleiben im Browser.
  for (const url of requestUrls) {
    expect(url).not.toContain(code.replace(/-/g, ''));
    expect(url).not.toContain(encodeURIComponent(code));
  }

  // Und die Raum-ID ist tatsaechlich nur ein Hash des Codes.
  const roomId = await pageA.evaluate(async (value) => {
    const module = await import('/js/crypto.js');
    return module.deriveRoomId(value);
  }, code);
  expect(roomId).toHaveLength(22);
  expect(roomId).not.toContain(code.slice(0, 4));

  await contextA.close();
  await contextB.close();
});

test('Ein falscher Code öffnet den Chat nicht', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Code eingeben/i }).click();
  await page.locator('#code-input').fill('ZZZZ-ZZZZ-ZZZZ');
  await page.getByRole('button', { name: 'Beitreten', exact: true }).click();
  await expect(page.locator('#screen-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#error-text')).toContainText(/gibt es nicht/i);
});

test('Nachrichtentext wird niemals als HTML ausgeführt', async ({ browser }) => {
  const contextA = await browser.newContext(MOBILE);
  const contextB = await browser.newContext(MOBILE);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const { link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible();

  const payload = '<img src=x onerror="window.__pwned=true"><script>window.__pwned=true<\/script>';
  await sendText(pageA, payload);

  const received = bubbles(pageB).last();
  await expect(received).toContainText('onerror');
  expect(await pageB.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await pageB.locator('#messages img[src="x"]').count()).toBe(0);
  expect(await pageB.locator('#messages script').count()).toBe(0);

  // Echte Links bleiben trotzdem klickbar.
  await sendText(pageA, 'Schau hier: https://example.org/seite?a=1');
  const link2 = bubbles(pageB).last().locator('a');
  await expect(link2).toHaveAttribute('href', 'https://example.org/seite?a=1');
  await expect(link2).toHaveAttribute('rel', /noopener/);

  await contextA.close();
  await contextB.close();
});

test('Namen werden verschlüsselt ausgetauscht und angezeigt', async ({ browser }) => {
  const contextA = await browser.newContext(MOBILE);
  const contextB = await browser.newContext(MOBILE);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const { link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible();

  await pageA.locator('#chat-menu').click();
  await pageA.getByRole('button', { name: /Dein Name/i }).click();
  await pageA.locator('#sheet input').fill('Mia');
  await pageA.getByRole('button', { name: 'Speichern', exact: true }).click();

  await expect(pageB.locator('#peer-name')).toHaveText('Mia', { timeout: 10_000 });
  await expect(pageB.locator('#peer-avatar')).toHaveText('M');

  await contextA.close();
  await contextB.close();
});

test('Eine Sprachnachricht lässt sich aufnehmen und abspielen', async ({ browser }) => {
  const contextA = await browser.newContext({ ...MOBILE, permissions: ['microphone'] });
  const contextB = await browser.newContext(MOBILE);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const { link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible();

  await pageA.locator('#btn-record').click();
  await expect(pageA.locator('#recorder')).toBeVisible({ timeout: 10_000 });
  await pageA.waitForTimeout(1200);
  await pageA.locator('#rec-send').click();
  await expect(pageA.locator('#recorder')).toBeHidden();

  const voice = pageB.locator('#messages .voice').last();
  await expect(voice).toBeVisible({ timeout: 20_000 });
  await expect(voice.locator('.voice__time')).toHaveText(/0:0\d/);
  await voice.locator('.voice__play').click();
  // Nach dem Antippen laeuft die Wiedergabe: mindestens ein Balken ist eingefaerbt.
  await expect(voice.locator('.voice__wave i.is-played').first()).toBeVisible({ timeout: 10_000 });

  await contextA.close();
  await contextB.close();
});

test('Sprache und Design lassen sich umschalten', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Neuen Chat starten/i })).toBeVisible();

  await page.locator('#btn-lang').click();
  await expect(page.getByRole('button', { name: /Start a new chat/i })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.locator('#btn-lang').click();
  await expect(page.getByRole('button', { name: /Neuen Chat starten/i })).toBeVisible();

  await page.locator('#btn-theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#btn-theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Die Wahl überlebt einen Neustart.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('Die Oberfläche passt auf ein schmales Display', async ({ browser }) => {
  const context = await browser.newContext({ ...MOBILE, viewport: { width: 320, height: 568 } });
  const page = await context.newPage();
  const { link } = await createChat(page);

  const noSideScroll = async () => page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  expect(await noSideScroll()).toBe(true);

  const context2 = await browser.newContext(MOBILE);
  const page2 = await context2.newPage();
  await joinChat(page2, link);
  await expect(page.locator('#screen-chat')).toBeVisible();

  await sendText(page, 'Ein ziemlich langes Wort: Donaudampfschifffahrtsgesellschaftskapitaen');
  expect(await noSideScroll()).toBe(true);

  // Eingabefelder mit weniger als 16 px lassen iOS beim Antippen hineinzoomen.
  const fontSize = await page.locator('#message-input')
    .evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);

  // Antippbares muss den Daumen vertragen.
  for (const selector of ['#btn-send', '#btn-attach', '#chat-menu', '#chat-back', '#jump-down']) {
    const box = await page.locator(selector).boundingBox();
    if (!box) continue;
    expect(box.width, `${selector} zu schmal`).toBeGreaterThanOrEqual(44);
    expect(box.height, `${selector} zu flach`).toBeGreaterThanOrEqual(44);
  }

  // Auch die kleinen Chips auf der Startseite.
  await page.goto('/');
  for (const selector of ['#btn-lang', '#btn-theme', '#btn-about']) {
    const box = await page.locator(selector).boundingBox();
    expect(box.height, `${selector} zu flach`).toBeGreaterThanOrEqual(44);
  }

  await context.close();
  await context2.close();
});

test('Der Zurück-Knopf verdeckt die Überschrift nicht', async ({ browser }) => {
  const context = await browser.newContext({ ...MOBILE, viewport: { width: 320, height: 568 } });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: /Code eingeben/i }).click();
  await expect(page.locator('#screen-join')).toBeVisible();

  const back = await page.locator('#join-back').boundingBox();
  const title = await page.locator('#join-title').boundingBox();
  expect(back).not.toBeNull();
  expect(title).not.toBeNull();
  const overlaps = back.y < title.y + title.height && back.y + back.height > title.y
    && back.x < title.x + title.width && back.x + back.width > title.x;
  expect(overlaps, 'Zurück-Knopf und Überschrift überlappen').toBe(false);

  await context.close();
});

test('Das Chat-Layout hält, wenn das Verbindungsbanner verschwindet', async ({ browser }) => {
  const contextA = await browser.newContext(MOBILE);
  const contextB = await browser.newContext(MOBILE);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const { link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible();
  await expect(pageA.locator('#banner')).toBeHidden();

  // Ohne Banner darf die Nachrichtenliste nicht auf Zeilenhöhe zusammenfallen.
  const layout = await pageA.evaluate(() => {
    const messages = document.getElementById('messages').getBoundingClientRect();
    const composer = document.querySelector('.composer-wrap').getBoundingClientRect();
    const header = document.querySelector('.chat-header').getBoundingClientRect();
    return { messages: messages.height, composer: composer.height, header: header.height,
             viewport: window.innerHeight, composerTop: composer.top, messagesBottom: messages.bottom };
  });
  expect(layout.messages, 'Nachrichtenliste muss den freien Platz füllen').toBeGreaterThan(layout.viewport * 0.5);
  expect(layout.composer, 'Eingabezeile darf nicht gedehnt werden').toBeLessThan(160);
  expect(Math.abs(layout.composerTop - layout.messagesBottom)).toBeLessThan(2);

  await contextA.close();
  await contextB.close();
});

test('Aufnahme abbrechen und den Chat verlassen lässt kein verstecktes Eingabefeld zurück', async ({ browser }) => {
  const contextA = await browser.newContext({ ...MOBILE, permissions: ['microphone'] });
  const contextB = await browser.newContext(MOBILE);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const { link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible();

  await pageA.locator('#btn-record').click();
  await expect(pageA.locator('#recorder')).toBeVisible({ timeout: 10_000 });
  await expect(pageA.locator('#composer')).toBeHidden();

  // Mitten in der Aufnahme zurück und wieder hinein.
  await pageA.locator('#chat-back').click();
  await expect(pageA.locator('#screen-start')).toBeVisible();
  await pageA.locator('#chat-list .chat-list__item').first().click();
  await expect(pageA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });

  await expect(pageA.locator('#recorder')).toBeHidden();
  await expect(pageA.locator('#composer')).toBeVisible();
  await sendText(pageA, 'Wieder schreibbar');
  await expect(bubbles(pageB).last()).toContainText('Wieder schreibbar');

  await contextA.close();
  await contextB.close();
});

test('Mehrere schnell abgeschickte Nachrichten behalten ihre Reihenfolge', async ({ browser }) => {
  const contextA = await browser.newContext(MOBILE);
  const contextB = await browser.newContext(MOBILE);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const { link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible();

  const expected = ['eins', 'zwei', 'drei', 'vier', 'fünf'];

  // Alle fünf im selben synchronen Block abschicken und die Liste sofort ablesen -
  // dann ist noch keine Quittung da und wir sehen wirklich die offenen Nachrichten.
  const whileStillPending = await pageA.evaluate((texts) => {
    const input = document.getElementById('message-input');
    const send = document.getElementById('btn-send');
    for (const text of texts) {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      send.click();
    }
    return [...document.querySelectorAll('#messages .msg')].map((node) => node.textContent);
  }, expected);

  expect(whileStillPending).toHaveLength(expected.length);
  for (const [index, text] of expected.entries()) {
    expect(whileStillPending[index], 'offene Nachrichten stehen in falscher Reihenfolge').toContain(text);
  }

  await expect(bubbles(pageA)).toHaveCount(5, { timeout: 15_000 });
  for (const [index, text] of expected.entries()) {
    await expect(bubbles(pageA).nth(index)).toContainText(text);
  }
  await expect(bubbles(pageB)).toHaveCount(5, { timeout: 15_000 });
  for (const [index, text] of expected.entries()) {
    await expect(bubbles(pageB).nth(index)).toContainText(text);
  }

  await contextA.close();
  await contextB.close();
});

test('Ältere Nachrichten werden wirklich nachgeladen', async ({ browser }) => {
  // Der Testserver liefert beim Verbinden nur WELCOME_HISTORY=5 Nachrichten mit,
  // der Rest muss über das Nachladen kommen.
  const contextA = await browser.newContext(MOBILE);
  const contextB = await browser.newContext(MOBILE);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const { link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible();

  for (let i = 1; i <= 12; i += 1) await sendText(pageA, `Nachricht ${i}`);
  await expect(bubbles(pageB)).toHaveCount(12, { timeout: 20_000 });

  // Nach dem Neuladen kommt erst einmal nur der jüngste Teil an.
  await pageB.reload();
  await pageB.locator('#chat-list .chat-list__item').first().click();
  await expect(pageB.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  await expect(bubbles(pageB)).toHaveCount(5, { timeout: 15_000 });
  await expect(bubbles(pageB).first()).toContainText('Nachricht 8');
  await expect(bubbles(pageB).last()).toContainText('Nachricht 12');

  // Und jetzt der Rest.
  const loadOlder = pageB.locator('#load-older');
  await expect(loadOlder).toBeVisible();
  await loadOlder.click();
  await expect(bubbles(pageB)).toHaveCount(12, { timeout: 15_000 });
  await expect(bubbles(pageB).first()).toContainText('Nachricht 1');
  await expect(loadOlder).toHaveCount(0, 'kein Nachladen mehr nötig');

  await contextA.close();
  await contextB.close();
});

test('Das Zugangstoken steht in keiner URL', async ({ browser }) => {
  const context = await browser.newContext(MOBILE);
  const page = await context.newPage();
  const socketUrls = [];
  const requestUrls = [];
  page.on('websocket', (socket) => socketUrls.push(socket.url()));
  page.on('request', (request) => requestUrls.push(request.url()));

  const { link } = await createChat(page);
  const context2 = await browser.newContext(MOBILE);
  const page2 = await context2.newPage();
  await joinChat(page2, link);
  await expect(page.locator('#screen-chat')).toBeVisible();

  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('fc:sessions:v1'))[0].token);
  expect(token).toBeTruthy();
  expect(socketUrls.length).toBeGreaterThan(0);
  for (const url of [...socketUrls, ...requestUrls]) {
    expect(url, `Token steckt in ${url}`).not.toContain(token);
  }

  await context.close();
  await context2.close();
});

test('Ein Zweitgerät des gleichen Nutzers bekommt denselben Verlauf', async ({ browser }) => {
  const contextA = await browser.newContext(MOBILE);
  const contextB = await browser.newContext(MOBILE);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const { link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible();
  await sendText(pageA, 'Von meinem ersten Gerät');
  await expect(bubbles(pageB).last()).toContainText('Von meinem ersten Gerät');

  // Geräte-Link enthält Code und persönliches Token.
  const deviceUrl = await pageA.evaluate(() => {
    const session = JSON.parse(localStorage.getItem('fc:sessions:v1'))[0];
    return `/#${encodeURIComponent(session.code)}.${encodeURIComponent(session.token)}`;
  });

  const contextA2 = await browser.newContext(MOBILE);
  const pageA2 = await contextA2.newPage();
  await pageA2.goto(deviceUrl);
  await expect(pageA2.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  // Gleicher Verlauf, und die eigene Nachricht steht auch hier rechts.
  await expect(bubbles(pageA2).last()).toContainText('Von meinem ersten Gerät');
  await expect(bubbles(pageA2).last()).toHaveClass(/msg--out/);

  await sendText(pageA2, 'Und jetzt vom zweiten');
  await expect(bubbles(pageB).last()).toContainText('Und jetzt vom zweiten');
  await expect(bubbles(pageA).last()).toContainText('Und jetzt vom zweiten');

  await contextA.close();
  await contextA2.close();
  await contextB.close();
});
