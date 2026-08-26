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
  for (const selector of ['#btn-send', '#btn-attach', '#chat-menu', '#chat-back']) {
    const box = await page.locator(selector).boundingBox();
    if (!box) continue;
    expect(box.width, `${selector} zu schmal`).toBeGreaterThanOrEqual(40);
    expect(box.height, `${selector} zu flach`).toBeGreaterThanOrEqual(40);
  }

  await context.close();
  await context2.close();
});

test('Ältere Nachrichten werden nachgeladen', async ({ browser }) => {
  const contextA = await browser.newContext(MOBILE);
  const contextB = await browser.newContext(MOBILE);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const { link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible();

  for (let i = 1; i <= 12; i += 1) await sendText(pageA, `Nachricht ${i}`);
  await expect(bubbles(pageB)).toHaveCount(12, { timeout: 20_000 });
  await expect(bubbles(pageB).first()).toContainText('Nachricht 1');
  await expect(bubbles(pageB).last()).toContainText('Nachricht 12');

  await contextA.close();
  await contextB.close();
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
