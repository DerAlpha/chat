import { test, expect, devices } from '@playwright/test';
import { createChat, joinChat, sendText, bubbles } from './helpers.js';

async function pairUp(browser) {
  const contextA = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  });
  const contextB = await browser.newContext({ ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const { code, link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible({ timeout: 15_000 });
  return { contextA, contextB, pageA, pageB, code };
}

const sessions = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('fc:sessions:v1') ?? 'null'));

test('REPRO: Rechtsklick auf den offenen Chat in der Liste loescht ihn samt Token', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB, code } = await pairUp(browser);
  await sendText(pageB, 'Hallo vom Handy');
  await expect(bubbles(pageA).last()).toContainText('Hallo vom Handy');

  const before = await sessions(pageA);
  console.log('VORHER sessions:', JSON.stringify(before?.map((s) => ({ code: s.code, token: Boolean(s.token) }))));
  expect(before.length).toBe(1);

  const entry = pageA.locator('#chat-list .chat-list__item.is-active');
  await expect(entry).toHaveCount(1);
  await expect(entry).toBeVisible();

  // Rechte Maustaste auf den aktiven Listeneintrag
  await entry.click({ button: 'right' });
  await expect(pageA.locator('#sheet')).toBeVisible();
  console.log('SHEET:', await pageA.locator('#sheet-body').innerText());

  const leave = pageA.locator('#sheet-body button', { hasText: 'Chat verlassen' });
  await expect(leave).toHaveCount(1);
  await leave.click();
  await pageA.waitForTimeout(500);

  const after = await sessions(pageA);
  console.log('NACHHER sessions:', JSON.stringify(after));
  const state = await pageA.evaluate(() => ({
    screen: document.body.dataset.screen,
    layout: document.body.dataset.layout,
    chatHidden: document.getElementById('screen-chat').hidden,
    emptyHidden: document.getElementById('screen-empty').hidden,
    listCount: document.querySelectorAll('#chat-list .chat-list__item').length,
  }));
  console.log('STATE:', JSON.stringify(state));

  // Chat laeuft weiter? Nachricht von B kommt noch an, und A kann senden.
  await sendText(pageB, 'Noch da?');
  await expect(bubbles(pageA).last()).toContainText('Noch da?', { timeout: 10_000 });
  await sendText(pageA, 'Ja, noch verbunden');
  await expect(bubbles(pageB).last()).toContainText('Ja, noch verbunden', { timeout: 10_000 });
  console.log('NACH WEITERER NACHRICHT sessions:', JSON.stringify(await sessions(pageA)));

  // Neu laden: ist der Chat weg?
  await pageA.reload();
  await pageA.waitForTimeout(800);
  console.log('NACH RELOAD sessions:', JSON.stringify(await sessions(pageA)));
  console.log('NACH RELOAD screen:', await pageA.evaluate(() => document.body.dataset.screen));
  console.log('NACH RELOAD Listeneintraege:', await pageA.locator('#chat-list .chat-list__item').count());

  // Code erneut eingeben
  await pageA.getByRole('button', { name: /Code eingeben|Chat beitreten/i }).click();
  await pageA.waitForTimeout(300);
  await pageA.evaluate((value) => {
    const input = document.getElementById('code-input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, code);
  await pageA.locator('#join-submit, #btn-join-submit, form#join-form button[type=submit]').first().click().catch(() => {});
  await pageA.waitForTimeout(3000);
  console.log('NACH ERNEUTER EINGABE screen:', await pageA.evaluate(() => document.body.dataset.screen));
  console.log('FEHLERTEXT:', await pageA.locator('#error-text').innerText().catch(() => '(keiner)'));

  await contextA.close();
  await contextB.close();
});
