/**
 * Am Rechner ist die App keine grosse Handy-Ansicht: links steht die Liste,
 * rechts die Unterhaltung. Diese Datei laeuft deshalb im Projekt "Rechner"
 * mit Maus statt Finger.
 */
import { test, expect, devices } from './fixtures.js';
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

test('Den offenen Chat aus der Liste zu verlassen baut ihn auch ab', async ({ browser }) => {
  // Am Handy lag die Liste hinter dem offenen Chat, dieser Weg war unerreichbar.
  // Am Rechner steht sie daneben - und löschte Schlüssel und Geräte-Token,
  // während der Chat weiterlief. Nach dem Neuladen wäre er unwiederbringlich
  // weg gewesen, weil der Raum weiter zwei Mitglieder hat.
  const { pageA, contextA, contextB } = await pairUp(browser);
  const eintrag = pageA.locator('#chat-list .chat-list__item.is-active');
  await expect(eintrag).toHaveCount(1);

  await eintrag.dispatchEvent('contextmenu');
  await pageA.getByRole('button', { name: /Chat verlassen/i }).click();
  // Ohne Rückfrage darf nichts verschwinden.
  await expect(pageA.locator('#sheet')).toContainText(/wirklich|verlassen/i);
  await pageA.getByRole('button', { name: /^Ja|Verlassen|Bestätigen|Weiter/i }).first().click();

  await expect(pageA.locator('#screen-chat')).toBeHidden({ timeout: 15_000 });
  await expect(pageA.locator('#screen-empty')).toBeVisible();
  await expect(pageA.locator('#chat-list .chat-list__item')).toHaveCount(0);

  await contextA.close();
  await contextB.close();
});

test('Viele Chats verdecken die Fußzeile nicht', async ({ page }) => {
  await page.addInitScript(() => {
    const now = Date.now();
    const key = new Uint8Array(32).fill(7);
    const b64 = btoa(String.fromCharCode(...key));
    localStorage.setItem('fc:sessions:v1', JSON.stringify(
      Array.from({ length: 9 }, (_, i) => ({
        roomId: `raum${i}`, code: `AAAA-BBBB-CCC${i}`, key: b64, token: null,
        memberId: null, nick: 'Ich', peerNick: `Person ${i}`,
        createdAt: now, lastActivity: now - i * 1000, unread: 0,
      })),
    ));
  });
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto('./');
  await expect(page.locator('#screen-start')).toBeVisible();

  const eintraege = page.locator('#chat-list .chat-list__item');
  await expect(eintraege).toHaveCount(9);

  // Jeder Eintrag, den man sieht, muss auch derjenige sein, den ein Klick
  // trifft. Wer in der Liste weggescrollt ist, zählt nicht - nur was im
  // sichtbaren Ausschnitt der Liste steht.
  const verdeckt = await page.evaluate(() => {
    const liste = document.getElementById('chat-list');
    const rahmen = liste.getBoundingClientRect();
    const treffer = [];
    for (const item of liste.querySelectorAll('.chat-list__item')) {
      const box = item.getBoundingClientRect();
      const mitte = box.top + box.height / 2;
      if (mitte < rahmen.top + 2 || mitte > rahmen.bottom - 2) continue;
      if (mitte < 0 || mitte > window.innerHeight) continue;
      const oben = document.elementFromPoint(box.left + box.width / 2, mitte);
      if (!item.contains(oben) && oben !== item) treffer.push(item.textContent.trim().slice(0, 20));
    }
    return treffer;
  });
  expect(verdeckt).toEqual([]);
  // Und die Liste muss überhaupt scrollen können, sonst ist der Rest unerreichbar.
  const scrollbar = await page.locator('#chat-list').evaluate((n) => n.scrollHeight > n.clientHeight
    && ['auto', 'scroll'].includes(getComputedStyle(n).overflowY));
  expect(scrollbar).toBe(true);
});

test('Der Platzhalter bleibt in einem niedrigen Fenster erreichbar', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 420 });
  await page.goto('./');
  await expect(page.locator('#screen-empty')).toBeVisible();
  const erreichbar = await page.locator('#screen-empty').evaluate((node) => {
    const style = getComputedStyle(node);
    return node.scrollHeight <= node.clientHeight || style.overflowY === 'auto' || style.overflowY === 'scroll';
  });
  expect(erreichbar).toBe(true);
});

/**
 * Am Rechner sitzt die Marke in einer schmalen Kopfzeile und wird kleiner
 * gezeichnet. Sie ist aber breiter als hoch - eine Sprechblase mit Spitze.
 * Wird sie in einen quadratischen Kasten gesteckt, schrumpft sie an der
 * langen Seite mit, und "psst..." ist nur noch ein Fleck.
 */
test('Die Bildmarke wird am Rechner nicht ins Quadrat gequetscht', async ({ page }) => {
  await page.goto('./');
  const marke = page.locator('#screen-start .logo--mark svg');
  await expect(marke).toBeVisible();
  const kasten = await marke.boundingBox();
  const vorlage = await page.locator('#i-logo').getAttribute('viewBox');
  const [, , breit, hoch] = vorlage.split(/\s+/).map(Number);

  // Dasselbe Seitenverhaeltnis wie die Vorlage, auf ein paar Prozent genau.
  const soll = breit / hoch;
  const ist = kasten.width / kasten.height;
  expect(Math.abs(ist - soll) / soll, `Vorlage ${soll.toFixed(2)}, gezeichnet ${ist.toFixed(2)}`).toBeLessThan(0.08);
  // Und gross genug, dass das Wort noch zu lesen ist.
  expect(kasten.width).toBeGreaterThanOrEqual(28);
});
