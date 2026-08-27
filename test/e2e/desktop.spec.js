/**
 * Am Rechner ist die App keine grosse Handy-Ansicht: links steht die Liste,
 * rechts die Unterhaltung. Diese Datei laeuft deshalb im Projekt "Rechner"
 * mit Maus statt Finger.
 */
import { test, expect, devices } from '@playwright/test';
import { createChat, joinChat, sendText, bubbles } from './helpers.js';

/** Rechner und Handy an einem Code - der Rechner ist Seite A. */
async function pairUp(browser) {
  const contextA = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  });
  const contextB = await browser.newContext({ ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const { link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible({ timeout: 15_000 });
  return { contextA, contextB, pageA, pageB };
}

test('Ohne offenen Chat stehen Seitenleiste und Platzhalter nebeneinander', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#screen-start')).toBeVisible();
  await expect(page.locator('#screen-empty')).toBeVisible();
  // Die Stichpunkte sind einmal im Quelltext und ziehen in den Platzhalter um.
  await expect(page.locator('#slot-empty #features')).toBeVisible();
  await expect(page.locator('#slot-start #features')).toHaveCount(0);

  // Zwei Spalten heisst: die Leiste endet weit links, der Platzhalter rechts daneben.
  const side = await page.locator('#screen-start').boundingBox();
  const empty = await page.locator('#screen-empty').boundingBox();
  expect(side.width).toBeLessThan(420);
  expect(empty.x).toBeGreaterThanOrEqual(side.x + side.width - 1);
});

test('Bei offenem Chat bleibt die Liste stehen und hebt ihn hervor', async ({ browser }) => {
  const { pageA, contextA, contextB } = await pairUp(browser);

  await expect(pageA.locator('#screen-start')).toBeVisible();
  await expect(pageA.locator('#screen-empty')).toBeHidden();
  await expect(pageA.locator('#chat-list .chat-list__item.is-active')).toHaveCount(1);
  // Der Weg zurueck ist die Liste nebenan - der Pfeil waere nur im Weg.
  await expect(pageA.locator('#chat-back')).toBeHidden();

  const side = await pageA.locator('#screen-start').boundingBox();
  const chat = await pageA.locator('#screen-chat').boundingBox();
  expect(chat.x).toBeGreaterThanOrEqual(side.x + side.width - 1);

  await contextA.close();
  await contextB.close();
});

test('Der Menü-Knopf an der Nachricht erscheint beim Überfahren', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);
  await sendText(pageB, 'Ohne Finger kein langes Drücken');
  await expect(bubbles(pageA).last()).toContainText('Ohne Finger');

  const message = bubbles(pageA).last();
  const more = message.locator('.msg__more');
  await expect(more).toHaveCSS('opacity', '0');
  await message.hover();
  await expect(more).toHaveCSS('opacity', '1');

  await more.click();
  await expect(pageA.locator('#sheet')).toBeVisible();
  await expect(pageA.getByRole('button', { name: 'Antworten' })).toBeVisible();

  await contextA.close();
  await contextB.close();
});

test('Mit der Maus lässt sich der Text einer Nachricht weiterhin markieren', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);
  await sendText(pageB, 'Diesen Satz will man kopieren können');
  const bubble = bubbles(pageA).last().locator('.bubble');
  await expect(bubble).toContainText('kopieren');

  // Am Schreibtisch bleibt das Markieren: dort oeffnet die rechte Maustaste das Menue.
  await expect(bubble).not.toHaveCSS('user-select', 'none');
  const box = await bubble.boundingBox();
  await pageA.mouse.move(box.x + 12, box.y + box.height / 2);
  await pageA.mouse.down();
  await pageA.mouse.move(box.x + box.width - 12, box.y + box.height / 2, { steps: 8 });
  await pageA.mouse.up();
  expect(await pageA.evaluate(() => window.getSelection().toString())).not.toBe('');

  await contextA.close();
  await contextB.close();
});

test('Enter schickt ab, Umschalt+Enter macht eine neue Zeile', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);
  const input = pageA.locator('#message-input');

  await input.fill('Erste Zeile');
  await input.press('Shift+Enter');
  await input.type('Zweite Zeile');
  expect(await input.inputValue()).toBe('Erste Zeile\nZweite Zeile');

  await input.press('Enter');
  await expect(bubbles(pageB).last()).toContainText('Zweite Zeile', { timeout: 15_000 });
  expect(await input.inputValue()).toBe('');

  await contextA.close();
  await contextB.close();
});

test('Ein schmales Fenster fällt zurück auf einen Bildschirm nach dem anderen', async ({ browser }) => {
  const { pageA, contextA, contextB } = await pairUp(browser);
  await expect(pageA.locator('#screen-start')).toBeVisible();

  await pageA.setViewportSize({ width: 480, height: 860 });
  await expect(pageA.locator('#screen-start')).toBeHidden();
  await expect(pageA.locator('#screen-chat')).toBeVisible();
  await expect(pageA.locator('#chat-back')).toBeVisible();

  await pageA.locator('#chat-back').click();
  await expect(pageA.locator('#screen-start')).toBeVisible();
  await expect(pageA.locator('#screen-empty')).toBeHidden();
  // Und die Stichpunkte sind wieder auf der Startseite gelandet.
  await expect(pageA.locator('#slot-start #features')).toBeVisible();

  // Zurueck in die Breite: beide Spalten wieder da.
  await pageA.setViewportSize({ width: 1280, height: 860 });
  await expect(pageA.locator('#screen-start')).toBeVisible();
  await expect(pageA.locator('#screen-empty')).toBeVisible();

  await contextA.close();
  await contextB.close();
});
