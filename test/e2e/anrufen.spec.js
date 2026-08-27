/**
 * Anrufe in der fertigen App - zwei echte Browser, echtes WebRTC.
 *
 * Der Unterschied zu anruf.spec.js: dort wird der Relaisdienst geprüft, hier
 * die Anwendung darum herum. Zwei Geräte finden über einen Code zusammen,
 * eines ruft an, das andere nimmt ab - und was dabei über den Server geht,
 * darf nichts verraten. Chromium bekommt über --use-fake-device-for-media-stream
 * ein Testbild und einen Testton, fragt also nicht nach Kamera und Mikrofon.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat, joinChat } from './helpers.js';

/**
 * Wie viele Bilder der Browser aus dem Strom tatsächlich angezeigt hat.
 *
 * Wichtig: `videoWidth` taugt dafür nicht. Die Bildgrösse steht im Kopf eines
 * VP8-Schlüsselbilds, und der bleibt im Klartext, damit der Browser das Bild
 * in RTP-Pakete zerlegen kann. Ein Empfänger ohne Schlüssel liest die Grösse
 * deshalb trotzdem - er sieht nur nichts. Gezählte Bilder lügen nicht.
 *
 * Und der Tab muss vorn sein: ein Fenster im Hintergrund zeichnet nur noch
 * gelegentlich, dann zählt der Zähler kaum - ganz gleich, ob entschlüsselt
 * wird oder nicht.
 */
async function bilderZaehlen(page, id, mindestens, frist = 25_000) {
  await page.bringToFront();
  await expect.poll(
    () => page.locator(id).evaluate((node) => node.getVideoPlaybackQuality?.().totalVideoFrames ?? 0),
    { timeout: frist },
  ).toBeGreaterThan(mindestens);
}

/** Zwei Geräte, ein Code - wie in chat.spec.js, nur hier noch einmal gebraucht. */
async function pairUp(browser) {
  const optionen = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };
  const contextA = await browser.newContext(optionen);
  const contextB = await browser.newContext(optionen);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const { link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible({ timeout: 15_000 });
  await expect(pageB.locator('#screen-chat')).toBeVisible({ timeout: 15_000 });
  return { contextA, contextB, pageA, pageB };
}

test('Die Anrufknöpfe stehen sichtbar in der Kopfzeile', async ({ browser }) => {
  const { pageA, contextA, contextB } = await pairUp(browser);
  await expect(pageA.locator('#btn-call-audio')).toBeVisible();
  await expect(pageA.locator('#btn-call-video')).toBeVisible();
  await contextA.close();
  await contextB.close();
});

test('Ein Sprachanruf kommt zustande, und beide sehen dieselben Prüfzeichen', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);

  await pageA.locator('#btn-call-audio').click();
  // Beim Anrufer klingelt es, beim Angerufenen erscheint die Annahme.
  await expect(pageA.locator('#call')).toBeVisible();
  await expect(pageA.locator('#call-state')).toContainText(/Klingelt/i);
  await expect(pageB.locator('#call')).toBeVisible({ timeout: 20_000 });
  await expect(pageB.locator('#call-state')).toContainText(/Eingehender Anruf/i);
  await expect(pageB.locator('#call-accept')).toBeVisible();

  await pageB.locator('#call-accept').click();

  await expect(pageA.locator('#call-state')).toContainText(/Verbunden/i, { timeout: 30_000 });
  await expect(pageB.locator('#call-state')).toContainText(/Verbunden/i, { timeout: 30_000 });

  // Die Prüfzeichen sind der Handgriff gegen einen untergeschobenen Server:
  // Sie entstehen aus den Zertifikaten beider Seiten. Stimmen sie nicht
  // überein, sitzt jemand dazwischen.
  await expect(pageA.locator('#call-safety')).toBeVisible();
  const hier = (await pageA.locator('#call-safety-code').textContent())?.trim();
  const dort = (await pageB.locator('#call-safety-code').textContent())?.trim();
  expect(hier).toBeTruthy();
  expect([...(hier ?? '')].length).toBeGreaterThan(0);
  expect(dort).toBe(hier);

  // Die Uhr läuft.
  await expect(pageA.locator('#call-timer')).toBeVisible();
  // Beim Sprachanruf bleibt der Name in der Mitte stehen - es gibt kein Bild.
  await expect(pageA.locator('#call-person')).toBeVisible();
  await expect(pageA.locator('#call-local')).toBeHidden();

  await pageA.locator('#call-hangup').click();
  await expect(pageA.locator('#call')).toBeHidden();
  await expect(pageB.locator('#call')).toBeHidden({ timeout: 20_000 });

  await contextA.close();
  await contextB.close();
});

test('Ein Videoanruf zeigt beiden ein Bild', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);

  await pageA.locator('#btn-call-video').click();
  await expect(pageB.locator('#call-state')).toContainText(/Eingehender Videoanruf/i, { timeout: 20_000 });
  await pageB.locator('#call-accept').click();

  await expect(pageA.locator('#call-state')).toContainText(/Verbunden/i, { timeout: 30_000 });
  await expect(pageA.locator('#call-local')).toBeVisible();
  // Kommt Bild an, tritt der Name in der Mitte beiseite.
  await expect(pageA.locator('#call-person')).toBeHidden({ timeout: 20_000 });

  // Und es fliesst wirklich Bild: der Zähler der angezeigten Bilder läuft.
  await bilderZaehlen(pageA, '#call-remote', 20);

  await pageA.locator('#call-hangup').click();
  await contextA.close();
  await contextB.close();
});

/**
 * Über der Verschlüsselung von WebRTC liegt noch eine zweite, mit dem
 * Schlüssel aus dem Code. Dass sie wirklich läuft, sieht man nicht am Bild -
 * sondern daran, dass trotz eingehängter Ver- und Entschlüsselung Bild
 * ankommt. Wäre etwas daran falsch, käme gar nichts an.
 */
test('Ton und Bild laufen doppelt verschlüsselt', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);

  await pageA.locator('#btn-call-video').click();
  await expect(pageB.locator('#call-accept')).toBeVisible({ timeout: 20_000 });
  await pageB.locator('#call-accept').click();
  await expect(pageA.locator('#call-state')).toContainText(/Verbunden/i, { timeout: 30_000 });

  // Beide Seiten haben sich auf die zweite Schicht geeinigt.
  await expect(pageA.locator('#call-safety')).toHaveClass(/is-double/);
  await expect(pageB.locator('#call-safety')).toHaveClass(/is-double/);

  // Und es kommt trotzdem laufend Bild an - also wird richtig ver- und
  // entschlüsselt. Ohne den Schlüssel bliebe der Zähler bei einer Handvoll
  // stehen: mehr als die Klartext-Köpfe der Schlüsselbilder käme nicht durch.
  await bilderZaehlen(pageB, '#call-remote', 20);
  await bilderZaehlen(pageA, '#call-remote', 20);

  // Der Text im Prüfzeichen-Fenster sagt dasselbe in Worten.
  await pageA.locator('#call-safety').click();
  await expect(pageA.locator('#sheet-body')).toContainText(/doppelt verschlüsselt/i);

  await pageA.locator('#call-hangup').click();
  await contextA.close();
  await contextB.close();
});

test('Ein abgelehnter Anruf sagt dem Anrufer Bescheid', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);

  await pageA.locator('#btn-call-audio').click();
  await expect(pageB.locator('#call-decline')).toBeVisible({ timeout: 20_000 });
  await pageB.locator('#call-decline').click();

  await expect(pageA.locator('#toast')).toContainText(/abgelehnt/i, { timeout: 20_000 });
  await expect(pageA.locator('#call')).toBeHidden();
  await expect(pageB.locator('#call')).toBeHidden();

  await contextA.close();
  await contextB.close();
});

test('Stummschalten und Kamera lassen sich im Gespräch bedienen', async ({ browser }) => {
  const { pageA, pageB, contextA, contextB } = await pairUp(browser);

  await pageA.locator('#btn-call-video').click();
  await expect(pageB.locator('#call-accept')).toBeVisible({ timeout: 20_000 });
  await pageB.locator('#call-accept').click();
  await expect(pageA.locator('#call-state')).toContainText(/Verbunden/i, { timeout: 30_000 });

  await pageA.locator('#call-mute').click();
  await expect(pageA.locator('#call-mute')).toHaveClass(/is-off/);
  await expect(pageA.locator('#call-mute')).toContainText(/Ton an/i);
  await pageA.locator('#call-mute').click();
  await expect(pageA.locator('#call-mute')).not.toHaveClass(/is-off/);

  // Kamera aus: das eigene Vorschaubild verschwindet.
  await expect(pageA.locator('#call-local')).toBeVisible();
  await pageA.locator('#call-camera').click();
  await expect(pageA.locator('#call-local')).toBeHidden();
  await pageA.locator('#call-camera').click();
  await expect(pageA.locator('#call-local')).toBeVisible();

  await pageA.locator('#call-hangup').click();
  await contextA.close();
  await contextB.close();
});

test('Die Aushandlung geht verschlüsselt über den Server', async ({ browser, request, baseURL }) => {
  const optionen = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };
  const contextA = await browser.newContext(optionen);
  const contextB = await browser.newContext(optionen);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  // Alles mitschreiben, was der Browser über den Aushandlungskanal schickt.
  const gesehen = [];
  for (const page of [pageA, pageB]) {
    page.on('websocket', (ws) => {
      ws.on('framesent', (frame) => gesehen.push(String(frame.payload)));
    });
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/frames')) gesehen.push(req.postData() ?? '');
    });
  }

  const { link } = await createChat(pageA);
  await joinChat(pageB, link);
  await expect(pageA.locator('#screen-chat')).toBeVisible({ timeout: 15_000 });

  await pageA.locator('#btn-call-video').click();
  await expect(pageB.locator('#call-accept')).toBeVisible({ timeout: 20_000 });
  await pageB.locator('#call-accept').click();
  await expect(pageA.locator('#call-state')).toContainText(/Verbunden/i, { timeout: 30_000 });

  const alles = gesehen.join('\n');
  // Aushandlungspakete sind wirklich geflossen ...
  expect(alles).toContain('"t":"sig"');
  // ... aber nichts davon ist lesbar: kein SDP, kein Kandidat, kein
  // Fingerabdruck des Zertifikats. Der Server sieht nur Bytes.
  expect(alles).not.toContain('a=fingerprint');
  expect(alles).not.toContain('v=0');
  expect(alles).not.toContain('candidate:');
  expect(alles).not.toMatch(/"sdp"/);

  await pageA.locator('#call-hangup').click();
  await contextA.close();
  await contextB.close();
});
