/**
 * Der Fokus und die Flächen, die ihn halten sollen.
 *
 * `aria-modal="true"` ist eine Behauptung, keine Wirkung: der Browser lässt
 * die Tabulatortaste trotzdem in die Seite dahinter wandern. Gemessen an
 * einem offenen Blatt lagen 16 von 20 Tab-Halten HINTER dem Blatt - auf
 * Knöpfen, die der Schleier zudeckt, mit sichtbarem Fokusring, und die
 * Eingabetaste löste sie wirklich aus. Hinter dem Fenster "neue Fassung",
 * das sich ausdrücklich nicht wegklicken lassen soll, ließ sich so
 * weiterarbeiten.
 *
 * Geprüft wird nicht das Attribut, sondern wo der Fokus nach zwanzig Tabs
 * wirklich steht.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat, joinChat, sendText } from './helpers.js';

const SCHMAL = { ...devices['Pixel 5'], viewport: { width: 360, height: 640 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' };

/** Wohin wandert der Fokus bei N Tabs? Liegt er in `flaeche` oder dahinter? */
async function tabHalte(seite, flaeche, n = 20) {
  const halte = [];
  for (let i = 0; i < n; i += 1) {
    await seite.keyboard.press('Tab');
    halte.push(await seite.evaluate((sel) => {
      const a = document.activeElement;
      if (!a || a === document.body) return 'BODY';
      return a.closest(sel) ? 'DRIN' : `DAHINTER:${a.id || a.className || a.tagName}`;
    }, flaeche));
  }
  return halte;
}

test('Ein offenes Blatt lässt den Fokus nicht hinaus', async ({ page }) => {
  await page.goto('./');
  await page.locator('#btn-about').click();
  await expect(page.locator('#sheet')).toBeVisible();

  const halte = await tabHalte(page, '#sheet');
  const draussen = halte.filter((h) => h !== 'DRIN');
  expect(draussen, `Tab-Halte außerhalb des Blattes: ${draussen.join(', ')}`).toEqual([]);

  // Und beim Schließen kehrt er zu dem Knopf zurück, der das Blatt aufmachte.
  await page.keyboard.press('Escape');
  await expect(page.locator('#sheet')).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.id || 'BODY')).toBe('btn-about');
});

test('Die Lupe hält den Fokus und gibt ihn zurück', async ({ browser }) => {
  const kA = await browser.newContext(SCHMAL);
  const kB = await browser.newContext(SCHMAL);
  const a = await kA.newPage(); const b = await kB.newPage();
  const { link } = await createChat(a, { nick: 'Anton' });
  await joinChat(b, link, { nick: 'Mira' });
  await expect(a.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  await sendText(a, 'Text davor');

  await a.evaluate(async () => {
    const ui = await import('./js/ui.js');
    ui.openLightbox('data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'Bild', 'b.gif');
  });
  await expect(a.locator('#lightbox')).toBeVisible();
  const halte = await tabHalte(a, '#lightbox', 12);
  expect(halte.filter((h) => h !== 'DRIN'), 'Fokus verlässt die Lupe').toEqual([]);
  await kA.close(); await kB.close();
});

test('Der Schleier ist auch für die Tastatur dicht', async ({ page }) => {
  await page.goto('./');
  await page.locator('#btn-start').click();
  await expect(page.locator('#screen-invite')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(async () => {
    const ui = await import('./js/ui.js');
    ui.busy(true, 'Einen Moment …');
  });
  await expect(page.locator('#busy')).toBeVisible();

  // Zehn Tabs dürfen nirgendwo hinter dem Schleier landen.
  const halte = await tabHalte(page, '#busy', 10);
  expect(halte.filter((h) => h.startsWith('DAHINTER')), 'Fokus liegt hinter dem Schleier').toEqual([]);
  await page.evaluate(async () => { (await import('./js/ui.js')).busy(false); });
});

test('Die kurze Meldung schluckt keinen Tipp', async ({ page }) => {
  await page.goto('./');
  await page.locator('#btn-about').click();
  await expect(page.locator('#sheet')).toBeVisible();

  const lage = await page.evaluate(async () => {
    const ui = await import('./js/ui.js');
    ui.toast('Eine kurze Meldung, die hier eine Weile steht');
    await new Promise((w) => setTimeout(w, 400));
    const t = document.getElementById('toast');
    const r = t.getBoundingClientRect();
    const treffer = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return {
      zeiger: getComputedStyle(t).pointerEvents,
      obenauf: treffer ? `${treffer.tagName}.${String(treffer.className).slice(0, 24)}` : 'nichts',
    };
  });
  expect(lage.zeiger, 'die Meldung fängt Zeigereignisse ab').toBe('none');
  expect(lage.obenauf, 'an der Stelle der Meldung liegt sie selbst obenauf').not.toContain('toast');
});
