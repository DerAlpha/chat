/**
 * Bewegung.
 *
 * Animationen sollen erklären, nicht schmücken: was neu ist, kommt herein;
 * was schon dastand, bleibt liegen. Und wer Bewegung abgestellt hat, bekommt
 * eine App, die vollständig sichtbar und bedienbar ist – das ist die
 * eigentliche Prüfung, denn eine Einblendung, die nicht startet, wäre ein
 * unsichtbares Fenster.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat, joinChat, sendText, withName } from './helpers.js';

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

test('Nur wirklich neue Nachrichten bewegen sich', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });

  for (let i = 0; i < 3; i += 1) await sendText(seiteA, `Zeile ${i}`);
  await expect(seiteB.locator('#messages .msg')).toHaveCount(3, { timeout: 30_000 });

  // Frisch geöffnet: der Verlauf steht einfach da, nichts fährt ein.
  await seiteB.reload();
  const eintrag = seiteB.locator('#chat-list .chat-list__item').first();
  await expect(eintrag).toBeVisible({ timeout: 25_000 });
  await eintrag.click();
  await expect(seiteB.locator('#messages .msg')).toHaveCount(3, { timeout: 25_000 });
  expect(await seiteB.locator('#messages .msg.is-new').count(),
    'der ganze Verlauf faehrt beim Oeffnen ein').toBe(0);

  // Eine neue Nachricht bewegt sich - und nur sie.
  await sendText(seiteA, 'Und jetzt neu');
  await expect(seiteB.locator('#messages .msg')).toHaveCount(4, { timeout: 30_000 });
  await expect(seiteB.locator('#messages .msg.is-new')).toHaveCount(1);
  await expect(seiteB.locator('#messages .msg.is-new')).toContainText('Und jetzt neu');
  const bewegt = await seiteB.locator('#messages .msg.is-new')
    .evaluate((element) => getComputedStyle(element).animationName);
  expect(bewegt).toBe('auftauchen');

  // Und bei der nächsten Kleinigkeit - hier eine Lesebestätigung, die den
  // ganzen Verlauf neu aufbaut - hüpft nichts hinterher.
  await sendText(seiteB, 'Gelesen');
  await expect(seiteA.locator('#messages .msg')).toHaveCount(5, { timeout: 30_000 });
  await seiteB.waitForTimeout(600);
  const nochNeu = await seiteB.locator('#messages .msg.is-new').allInnerTexts();
  expect(nochNeu.length, `noch als neu markiert: ${nochNeu.join(' / ')}`).toBeLessThanOrEqual(1);

  await kontextA.close();
  await kontextB.close();
});

test('Der Bildschirmwechsel bewegt sich - aber nur kurz', async ({ page }) => {
  await withName(page, 'Anton');
  await page.goto('./');
  const werte = await page.evaluate(() => {
    const wurzel = getComputedStyle(document.documentElement);
    const start = document.getElementById('screen-start');
    const stil = getComputedStyle(start);
    return {
      dauer: wurzel.getPropertyValue('--dauer').trim(),
      kurve: wurzel.getPropertyValue('--kurve').trim(),
      name: stil.animationName,
      wieLang: stil.animationDuration,
    };
  });
  expect(werte.dauer, 'die gemeinsame Dauer fehlt').toMatch(/^\d+ms$/);
  expect(Number.parseInt(werte.dauer, 10), 'so lange schaut niemand zu').toBeLessThanOrEqual(320);
  expect(werte.kurve).toContain('cubic-bezier');
  expect(werte.name).toBe('auftauchen');
  expect(werte.wieLang).toBe('0.19s');
});

/**
 * Wer Bewegung abgestellt hat, bekommt keine – und trotzdem alles zu sehen.
 * Das ist die wichtigere Hälfte: eine Einblendung, die nicht läuft, darf
 * kein unsichtbares Fenster hinterlassen.
 */
test('Ohne Bewegung ist trotzdem alles da', async ({ browser }) => {
  const kontextA = await browser.newContext({ ...HANDY, reducedMotion: 'reduce' });
  const kontextB = await browser.newContext({ ...HANDY, reducedMotion: 'reduce' });
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  await sendText(seiteA, 'Auch ohne Bewegung');
  await expect(seiteB.locator('#messages')).toContainText('Auch ohne Bewegung', { timeout: 30_000 });

  // Alles Sichtbare ist wirklich sichtbar - keine hängengebliebene Einblendung.
  const durchsichtig = await seiteB.evaluate(() => {
    const verdaechtig = ['#screen-chat', '.chat-header', '#messages', '#messages .msg', '.composer', '#composer'];
    const blass = [];
    for (const wahl of verdaechtig) {
      for (const knoten of document.querySelectorAll(wahl)) {
        const stil = getComputedStyle(knoten);
        if (Number.parseFloat(stil.opacity) < 0.99) blass.push(`${wahl}: ${stil.opacity}`);
        if (stil.transform !== 'none' && stil.transform !== 'matrix(1, 0, 0, 1, 0, 0)') {
          blass.push(`${wahl}: ${stil.transform}`);
        }
      }
    }
    return blass;
  });
  expect(durchsichtig, `nicht ganz da: ${durchsichtig.join(', ')}`).toEqual([]);

  // Und die Bewegung ist wirklich abgestellt.
  const dauer = await seiteB.locator('#screen-chat').evaluate((element) => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(dauer)).toBeLessThan(0.01);

  // Das Menue ist gestaffelt aufgebaut. Ohne Bewegung darf davon nichts
  // uebrig bleiben: eine stehengebliebene Verzoegerung haelt den Eintrag in
  // seinem Anfangszustand fest - er waere schlicht nicht da.
  await seiteB.locator('#chat-menu').click();
  await expect(seiteB.locator('.sheet__panel')).toBeVisible({ timeout: 10_000 });
  const versteckt = await seiteB.evaluate(() => {
    const fehlend = [];
    for (const knoten of document.querySelectorAll('.sheet__body > *')) {
      const stil = getComputedStyle(knoten);
      if (Number.parseFloat(stil.opacity) < 0.99) {
        fehlend.push(`${knoten.textContent.trim().slice(0, 24)}: ${stil.opacity}`);
      }
    }
    return fehlend;
  });
  expect(versteckt, `im Menue nicht sichtbar: ${versteckt.join(', ')}`).toEqual([]);
  await seiteB.keyboard.press('Escape');
  await expect(seiteB.locator('#sheet')).toBeHidden({ timeout: 10_000 });

  // Bedienbar bleibt es auch: eine Antwort kommt an.
  await sendText(seiteB, 'Kommt an');
  await expect(seiteA.locator('#messages')).toContainText('Kommt an', { timeout: 30_000 });

  await kontextA.close();
  await kontextB.close();
});
