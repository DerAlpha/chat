import { test, expect, devices } from '@playwright/test';
import { makePng, createChat, joinChat, sendText, bubbles } from './helpers.js';

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
  await page.goto('/');
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

  await pageB.goto('/');
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
  await expect(pageA.locator('#messages .msg--out').last().locator('.is-read')).toBeVisible({ timeout: 10_000 });

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
