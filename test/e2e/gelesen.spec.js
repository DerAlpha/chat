/**
 * Wer hat es gelesen?
 *
 * In einer Gruppe sagt ein Haken zu wenig: bei acht Leuten ist „alle haben
 * gelesen" selten und „jemand hat gelesen" nichtssagend. Unter der eigenen
 * Nachricht steht deshalb ein Auge mit einer Zahl, und dahinter die Namen –
 * getrennt nach denen, die wirklich hingesehen haben, und denen, für die es
 * nur bereitliegt.
 */
import { test, expect, devices } from './fixtures.js';
import { withName, createChat, joinChat } from './helpers.js';

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

async function gruppeAnlegen(page, { name = 'Verein', count = 2, nick = 'Anton' } = {}) {
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

const auge = (seite) => seite.locator('#messages .msg--out:not(.msg--typing) .seen').last();

test('Unter der eigenen Nachricht steht, wie viele sie gelesen haben', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const kontextC = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const seiteC = await kontextC.newPage();

  const [linkB, linkC] = await gruppeAnlegen(seiteA, { count: 2, nick: 'Anton' });
  await withName(seiteB, 'Mira');
  await seiteB.goto(linkB);
  await expect(seiteB.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  // C tritt bei, geht aber sofort aus dem Chat heraus - liest also nicht mit.
  await withName(seiteC, 'Cem');
  await seiteC.goto(linkC);
  await expect(seiteC.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  await seiteC.locator('#chat-back').click();
  await expect(seiteC.locator('#screen-start')).toBeVisible();

  await seiteA.locator('#btn-group-to-chat').click();
  await seiteA.locator('#message-input').fill('Wer liest das?');
  await seiteA.locator('#btn-send').click();

  // Mira hat den Chat offen und liest - Cem nicht.
  await expect(seiteB.locator('#messages .msg--in:not(.msg--typing)')).toContainText('Wer liest das?', { timeout: 30_000 });

  // Das Auge steht da und zählt mit.
  await expect(auge(seiteA)).toBeVisible({ timeout: 20_000 });
  await expect(auge(seiteA).locator('.seen__count')).toHaveText('1', { timeout: 30_000 });

  // Und die Liste trennt beide sauber.
  await auge(seiteA).click();
  await expect(seiteA.locator('#sheet-title')).toHaveText(/Wer hat es gelesen/i);
  const gelesen = seiteA.locator('#sheet .seen-list.is-read');
  const offen = seiteA.locator('#sheet .seen-list.is-pending');
  await expect(gelesen).toContainText('Mira');
  await expect(gelesen).not.toContainText('Cem');
  await expect(offen).toContainText('Cem');
  await expect(offen).not.toContainText('Mira');
  await expect(seiteA.locator('#sheet')).toContainText(/noch nicht geöffnet/i);

  // Die Zugestellten stehen blasser da als die, die hingesehen haben.
  const blass = await seiteA.evaluate(() => {
    const wert = (wahl) => {
      const knoten = document.querySelector(wahl);
      const stil = getComputedStyle(knoten);
      return Number.parseFloat(stil.opacity);
    };
    return { gelesen: wert('#sheet .seen-list.is-read'), offen: wert('#sheet .seen-list.is-pending') };
  });
  expect(blass.offen, 'die Zugestellten sind nicht ausgegraut').toBeLessThan(blass.gelesen);

  // Liest Cem doch noch, zählt das Auge weiter.
  await seiteA.keyboard.press('Escape');
  await seiteC.locator('#chat-list .chat-list__item').first().click();
  await expect(seiteC.locator('#messages .msg--in:not(.msg--typing)')).toContainText('Wer liest das?', { timeout: 30_000 });
  await expect(auge(seiteA).locator('.seen__count')).toHaveText('2', { timeout: 40_000 });

  await kontextA.close();
  await kontextB.close();
  await kontextC.close();
});

test('Im Zweiergespräch bleibt es beim Haken', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });

  await seiteA.locator('#message-input').fill('Nur wir zwei');
  await seiteA.locator('#btn-send').click();
  await expect(seiteB.locator('#messages .msg--in:not(.msg--typing)')).toContainText('Nur wir zwei', { timeout: 30_000 });

  // Kein Auge - bei einer Person sagt der Haken alles.
  await expect(seiteA.locator('#messages .msg--out:not(.msg--typing) .seen')).toHaveCount(0);
  await expect(seiteA.locator('#messages .msg--out:not(.msg--typing) .bubble__meta .icon')).toBeVisible();

  await kontextA.close();
  await kontextB.close();
});
