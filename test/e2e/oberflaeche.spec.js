/**
 * Was übereinander liegt - und was darunter verschwindet.
 *
 * Drei Stellen, an denen sich Dinge in die Quere kamen. Geprüft wird jedes
 * Mal nicht die Regel im Stilblatt, sondern das Ergebnis auf dem Bildschirm:
 * wer liegt an dieser Stelle wirklich obenauf, und passt das noch in den
 * Rahmen? Eine CSS-Regel kann stimmen und trotzdem wirkungslos sein, weil
 * ein Vorfahr einen eigenen Stapel aufmacht - genau das war hier der Fall.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat, joinChat, sendText, longPress } from './helpers.js';

/** Ein schmales Gerät: dort wird es eng, und dort fällt es zuerst auf. */
const SCHMAL = { ...devices['Pixel 5'], viewport: { width: 320, height: 640 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' };

async function paar(browser, gerät = SCHMAL) {
  const kontextA = await browser.newContext(gerät);
  const kontextB = await browser.newContext(gerät);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  return { kontextA, kontextB, seiteA, seiteB };
}

/**
 * Die Schnellreihe im Nachrichtenmenü hatte sieben Knöpfe zu je 48
 * Bildpunkten - auf einem 320er Bildschirm siebzig zu breit. Sie standen
 * dann über den Rand des Blattes hinaus, und der letzte, der Weg zu allen
 * übrigen Emoji, war gar nicht mehr zu treffen.
 */
test('Das Nachrichtenmenü bleibt im Blatt', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await paar(browser);
  await sendText(seiteA, 'Eine Nachricht');
  await expect(seiteB.locator('#messages .msg--in:not(.msg--typing)')).toHaveCount(1, { timeout: 30_000 });

  await longPress(seiteA, seiteA.locator('#messages .msg--out').first().locator('.bubble'));
  await expect(seiteA.locator('#sheet')).toBeVisible({ timeout: 10_000 });

  const mass = await seiteA.evaluate(() => {
    const blatt = document.querySelector('.sheet__panel').getBoundingClientRect();
    const knoepfe = [...document.querySelectorAll('#sheet-body .emoji-row > *')].map((n) => {
      const r = n.getBoundingClientRect();
      return { t: n.textContent.trim().slice(0, 2), l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return { blatt: { l: Math.round(blatt.left), r: Math.round(blatt.right) }, knoepfe };
  });

  expect(mass.knoepfe.length, 'die Schnellreihe ist leer').toBeGreaterThan(3);
  const raus = mass.knoepfe.filter((k) => k.r > mass.blatt.r || k.l < mass.blatt.l);
  expect(raus, `steht über dem Rand des Blattes: ${JSON.stringify(raus)}`).toEqual([]);
  // Und sie bleiben antippbar gross - schrumpfen waere der falsche Ausweg.
  const winzig = mass.knoepfe.filter((k) => k.w < 40 || k.h < 40);
  expect(winzig, `zu klein zum Treffen: ${JSON.stringify(winzig)}`).toEqual([]);

  // Und im Menue selbst ueberdeckt nichts etwas anderes.
  const ueberlapp = await seiteA.evaluate(() => {
    const teile = [...document.querySelectorAll('#sheet-body > *')];
    const treffer = [];
    for (let i = 0; i < teile.length; i += 1) {
      for (let j = i + 1; j < teile.length; j += 1) {
        const a = teile[i].getBoundingClientRect();
        const b = teile[j].getBoundingClientRect();
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (x > 1 && y > 1) treffer.push(`${teile[i].className} / ${teile[j].className}`);
      }
    }
    return treffer;
  });
  expect(ueberlapp, `im Menü überdeckt sich etwas: ${ueberlapp.join(', ')}`).toEqual([]);

  await kontextA.close();
  await kontextB.close();
});

/**
 * Die Reaktionen hängen bewusst ein Stück in die Blase hinein - dann müssen
 * sie aber auch davor liegen. Die Blase ist positioniert und deckte den
 * oberen Rand jeder Marke zu, samt der Fläche, auf die man tippt.
 */
test('Reaktionen liegen vor der Nachricht, nicht dahinter', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await paar(browser);
  await sendText(seiteA, 'Eine Nachricht mit Reaktion');
  await expect(seiteB.locator('#messages .msg--in:not(.msg--typing)')).toHaveCount(1, { timeout: 30_000 });

  await longPress(seiteB, seiteB.locator('#messages .msg--in:not(.msg--typing)').first().locator('.bubble'));
  await expect(seiteB.locator('#sheet')).toBeVisible({ timeout: 10_000 });
  await seiteB.locator('#sheet-body .emoji-row button').first().click();
  await expect(seiteB.locator('#messages .reaction')).toHaveCount(1, { timeout: 20_000 });
  await seiteB.waitForTimeout(600);

  const lage = await seiteB.evaluate(() => {
    const chip = document.querySelector('#messages .reaction');
    const r = chip.getBoundingClientRect();
    const blase = chip.closest('.msg').querySelector('.bubble').getBoundingClientRect();
    // Genau dort, wo die Marke unter der Blase liegt: am oberen Rand.
    const punkte = [
      [r.left + r.width / 2, r.top + 1],
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 2, r.top + 2],
    ];
    return {
      ueberdeckung: Math.round(blase.bottom - r.top),
      fremd: punkte
        .map(([x, y]) => document.elementFromPoint(Math.round(x), Math.round(y)))
        .filter((n) => !n || !n.closest('.reactions'))
        .map((n) => (n ? `${n.tagName}.${String(n.className).slice(0, 24)}` : 'nichts')),
    };
  });

  // Sie ueberlappen wirklich - sonst pruefte der Test nichts.
  expect(lage.ueberdeckung, 'die Marke berührt die Blase gar nicht').toBeGreaterThan(0);
  expect(lage.fremd, `über der Reaktion liegt: ${lage.fremd.join(', ')}`).toEqual([]);

  // Und sie ist auch wirklich zu treffen: ein Tippen nimmt sie wieder weg.
  await seiteB.locator('#messages .reaction').first().click({ position: { x: 8, y: 2 } });
  await expect(seiteB.locator('#messages .reaction')).toHaveCount(0, { timeout: 20_000 });

  await kontextA.close();
  await kontextB.close();
});
