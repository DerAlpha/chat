/**
 * Am Rechner ist die App keine grosse Handy-Ansicht: links steht die Liste,
 * rechts die Unterhaltung. Diese Datei laeuft deshalb im Projekt "Rechner"
 * mit Maus statt Finger.
 */
import { test, expect, devices } from '@playwright/test';
import { createChat, joinChat, sendText, bubbles, longClick } from './helpers.js';

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

test('Nach einem langen Drücken bleibt die Maus voll benutzbar', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);
  await sendText(pageB, 'Erst halten, dann weiterarbeiten');
  const message = bubbles(pageA).last();
  await expect(message).toContainText('Erst halten');

  // Auslöser: die linke Taste lange auf der Blase halten - etwa um eine
  // Textmarkierung anzusetzen. Danach muss alles weiter funktionieren.
  await longClick(pageA, message.locator('.bubble'));
  await expect(pageA.locator('#sheet')).toBeVisible();
  await pageA.keyboard.press('Escape');
  await expect(pageA.locator('#sheet')).toBeHidden();

  // Der Weg von der Blase zum ⋯-Knopf führt zwangsläufig über ein
  // pointerleave. Das darf keinen Fanghaken über das Fenster legen.
  await message.locator('.bubble').hover();
  await pageA.locator('#peer-name').hover();
  await message.hover();
  await message.locator('.msg__more').click();
  await expect(pageA.locator('#sheet')).toBeVisible();
  await pageA.keyboard.press('Escape');

  // Und die rechte Maustaste öffnet das Menü weiterhin - auf derselben Blase.
  await message.locator('.bubble').click({ button: 'right' });
  await expect(pageA.locator('#sheet')).toBeVisible();
  await expect(pageA.getByRole('button', { name: 'Antworten' })).toBeVisible();

  await contextA.close();
  await contextB.close();
});

test('Ein Klick weit weg von der gehaltenen Stelle geht nicht verloren', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);
  await sendText(pageB, 'Halten und woanders hinklicken');
  const message = bubbles(pageA).last();
  await expect(message).toContainText('Halten und');

  await longClick(pageA, message.locator('.bubble'));
  await expect(pageA.locator('#sheet')).toBeVisible();
  // Sofort - innerhalb der Frist für den Geisterklick - auf den Griff oben
  // im Menü. Der liegt weit von der gehaltenen Stelle entfernt und muss
  // deshalb ankommen.
  await pageA.locator('#sheet-backdrop').click({ position: { x: 10, y: 10 } });
  await expect(pageA.locator('#sheet')).toBeHidden();

  await contextA.close();
  await contextB.close();
});

test('Der Mauszeiger allein macht keinen Klick unwirksam', async ({ page }) => {
  // Der Weg in die Falle: onLongPress hängt auch an pointerleave, und das
  // feuert bei der Maus schon ohne gedrückte Taste. Wer dort den Fanghaken
  // für den Geisterklick setzt, macht für 400 ms genau die Stelle taub, auf
  // die man als Nächstes klicken will.
  await createChat(page);
  await page.locator('#invite-back').click();
  await expect(page.locator('#screen-empty')).toBeVisible();

  const eintrag = page.locator('#chat-list .chat-list__item').first();
  const box = await eintrag.boundingBox();
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);

  // Lange auf den Listeneintrag drücken öffnet dessen Menü.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await expect(page.locator('#sheet')).toBeVisible();
  await page.keyboard.press('Escape');

  // Der Zeiger stand während des Menüs auf dessen Hintergrund. Also erst
  // wieder auf den Eintrag (pointerenter), dann herunter (pointerleave -
  // hier schnappt die Falle zu) und sofort zurück zum Klicken.
  await page.mouse.move(x, y - 200);
  await page.mouse.move(x, y);
  await page.mouse.move(x, y - 200);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await expect(page.locator('#screen-empty')).toBeHidden({ timeout: 15_000 });
});
