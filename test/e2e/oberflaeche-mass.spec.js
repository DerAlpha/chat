/**
 * Maße, die stimmen müssen - gemessen, nicht im Stilblatt nachgelesen.
 *
 * Eine CSS-Regel kann dastehen und wirkungslos sein: ein absolut gesetztes
 * Rasterkind mit `grid-row: 3` bekommt NICHT die Zeile 3 als Bezugsrahmen,
 * sondern reicht bis zur Unterkante des ganzen Rasters, weil `grid-row-end`
 * auf `auto` steht. Genau so lag der Sprungknopf 45 Bildpunkte tief in der
 * Textzeile, auf dem Sendeknopf.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat, joinChat, sendText, makePng } from './helpers.js';

const G = (b, h = 640) => ({ ...devices['Pixel 5'], viewport: { width: b, height: h }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });

async function paar(browser, gerät = G(360)) {
  const kA = await browser.newContext(gerät);
  const kB = await browser.newContext(gerät);
  const a = await kA.newPage(); const b = await kB.newPage();
  const { link } = await createChat(a, { nick: 'Anton' });
  await joinChat(b, link, { nick: 'Mira' });
  await expect(a.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  return { kA, kB, a, b };
}

test('Der Sprungknopf hängt am Verlauf, nicht an der Textzeile', async ({ browser }) => {
  const { kA, kB, a } = await paar(browser);
  for (let i = 0; i < 25; i += 1) await sendText(a, `Nachricht ${i}`);
  // Erst wenn alle da sind, hat der Verlauf seine endgueltige Hoehe. Gegen
  // das PHP-Backend kommen sie deutlich langsamer an; ein starres Warten
  // reichte dort unter der Last der ganzen Suite nicht.
  await expect(a.locator('#messages .msg:not(.msg--typing)')).toHaveCount(25, { timeout: 30_000 });
  await a.locator('#messages').evaluate((n) => { n.scrollTop = 0; });
  // Und auf den Knopf warten, statt eine Frist zu raten: er erscheint erst,
  // wenn die App das Rollen bemerkt hat.
  await expect(a.locator('#jump-down')).toBeVisible({ timeout: 20_000 });

  const lage = await a.evaluate(() => {
    const j = document.getElementById('jump-down');
    if (j.hidden) return { versteckt: true };
    const r = j.getBoundingClientRect();
    const c = document.querySelector('.composer-wrap').getBoundingClientRect();
    const mitte = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return {
      ueberlapp: Math.round(Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top)),
      obenauf: mitte ? (mitte.closest('#jump-down') ? 'KNOPF' : mitte.tagName) : 'nichts',
    };
  });
  expect(lage.versteckt, 'der Sprungknopf war gar nicht da').toBeFalsy();
  expect(lage.ueberlapp, 'der Sprungknopf liegt auf der Textzeile').toBeLessThanOrEqual(0);
  expect(lage.obenauf, 'auf dem Sprungknopf liegt etwas anderes').toBe('KNOPF');
  await kA.close(); await kB.close();
});

test('Der Verlauf bleibt unten, wenn ihm Höhe genommen wird', async ({ browser }) => {
  const { kA, kB, a } = await paar(browser);
  for (let i = 0; i < 20; i += 1) await sendText(a, `Nachricht ${i}`);
  await expect(a.locator('#messages .msg:not(.msg--typing)')).toHaveCount(20, { timeout: 30_000 });
  await a.waitForTimeout(400);

  /** Wieviel von der letzten Blase liegt unter dem Verlauf? */
  const versteckt = () => {
    const liste = document.getElementById('messages');
    const blasen = [...liste.querySelectorAll('.msg:not(.msg--typing)')];
    const letzte = blasen[blasen.length - 1];
    const lr = letzte.getBoundingClientRect(), mr = liste.getBoundingClientRect();
    return { unterhalb: Math.round(Math.max(0, lr.bottom - mr.bottom)), hoehe: Math.round(mr.height) };
  };

  // Das Banner nimmt dem Verlauf Höhe weg ...
  await a.evaluate(() => {
    const banner = document.getElementById('banner');
    banner.textContent = 'Verbindung unterbrochen – neuer Versuch …';
    banner.hidden = false;
  });
  await a.waitForTimeout(400);
  const mitBanner = await a.evaluate(versteckt);
  expect(mitBanner.unterhalb, 'das Banner schiebt die neueste Nachricht unter den Rand').toBeLessThanOrEqual(1);

  // ... und Antwort-Vorschau, Verdeckt-Leiste und Anhänge zusammen noch mehr.
  await a.evaluate(() => {
    document.getElementById('reply-preview').hidden = false;
    document.getElementById('reply-preview-text').textContent = 'Eine zitierte Nachricht';
    document.getElementById('spoiler-bar').hidden = false;
  });
  await a.locator('#file-gallery').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: makePng(180, 120) },
    { name: 'b.png', mimeType: 'image/png', buffer: makePng(180, 120) },
  ]);
  await expect(a.locator('#attachments .attachment')).toHaveCount(2, { timeout: 20_000 });
  await a.waitForTimeout(500);
  const voll = await a.evaluate(versteckt);
  expect(voll.hoehe, 'dem Verlauf wurde gar keine Höhe genommen').toBeLessThan(mitBanner.hoehe);
  expect(voll.unterhalb, 'der volle untere Block schiebt die neueste Nachricht unter den Rand').toBeLessThanOrEqual(1);
  await kA.close(); await kB.close();
});

test('Das Zuschneide-Fenster bleibt ein Quadrat', async ({ browser }) => {
  // Auf niedrigen Fenstern fiel es zusammen - 280x78 bei 320x480, 280x0 quer.
  // Die Zuschneide-Rechnung geht aber von einem Quadrat aus, und im
  // gespeicherten Bild stand danach Material, das nie zu sehen war.
  for (const [b, h] of [[393, 900], [375, 667], [320, 480], [640, 360]]) {
    const k = await browser.newContext(G(b, h));
    const p = await k.newPage();
    await p.goto('./');
    await p.locator('#btn-avatar').click();
    await expect(p.locator('#sheet')).toBeVisible({ timeout: 10_000 });
    const [dialog] = await Promise.all([
      p.waitForEvent('filechooser'),
      p.getByRole('button', { name: /Bild auswählen/i }).click(),
    ]);
    await dialog.setFiles({ name: 'v.png', mimeType: 'image/png', buffer: makePng(400, 400) });
    await expect(p.locator('#crop-apply')).toBeVisible({ timeout: 15_000 });
    await p.waitForTimeout(400);

    const m = await p.evaluate(() => {
      const c = document.querySelector('.crop');
      const r = c.getBoundingClientRect();
      const img = c.querySelector('.crop__img');
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        bild: img ? [parseFloat(img.style.width), parseFloat(img.style.height)] : null,
      };
    });
    expect(Math.abs(m.w - m.h), `bei ${b}x${h} kein Quadrat: ${m.w}x${m.h}`).toBeLessThanOrEqual(1);
    expect(m.h, `bei ${b}x${h} zusammengefallen`).toBeGreaterThan(60);
    await k.close();
  }
});

test('Die Zeitangabe in der Chatliste fällt nicht als Erstes weg', async ({ browser }) => {
  // Hinweis und Zeit standen in EINEM Text, gekürzt wurde von hinten - also
  // fiel die Zeit weg, nach der die Liste sortiert ist.
  const jetzt = Date.now();
  for (const breite of [320, 360, 414]) {
    const k = await browser.newContext(G(breite, 720));
    const p = await k.newPage();
    await p.addInitScript((eintraege) => {
      localStorage.setItem('fc:sessions:v1', JSON.stringify(eintraege));
    }, [
      { roomId: 'raumaaaaaaaaaaaaaaaaaa', code: 'ABCD-1003-EFGH', key: 'x', peerNick: '', unread: 3, lastMessageAt: jetzt - 20 * 3600e3, lastActivity: jetzt },
      { roomId: 'raumbbbbbbbbbbbbbbbbbb', code: 'ABCD-1009-EFGH', key: 'x', peerNick: 'Donaudampfschifffahrtsgesellsch', unread: 9, lastMessageAt: jetzt - 3 * 3600e3, lastActivity: jetzt - 9000 },
      { roomId: 'raumcccccccccccccccccc', code: 'ABCD-1011-EFGH', key: 'x', peerNick: 'Emil', unread: 12, lastMessageAt: jetzt - 40 * 86400e3, lastActivity: jetzt - 11000 },
    ]);
    await p.goto('./');
    await expect(p.locator('#chat-list .chat-list__item')).toHaveCount(3, { timeout: 15_000 });

    const zeilen = await p.evaluate(() => [...document.querySelectorAll('#chat-list .chat-list__meta')].map((meta) => {
      const zeit = meta.querySelector('.chat-list__zeit');
      const zr = zeit.getBoundingClientRect(), mr = meta.getBoundingClientRect();
      return {
        text: zeit.textContent.trim(),
        breit: Math.round(zr.width),
        sichtbar: Math.round(Math.max(0, Math.min(zr.right, mr.right) - Math.max(zr.left, mr.left))),
      };
    }));
    for (const z of zeilen) {
      expect(z.sichtbar, `bei ${breite}px ist "${z.text}" abgeschnitten`).toBe(z.breit);
    }
    await k.close();
  }
});
