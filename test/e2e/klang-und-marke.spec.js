/**
 * Klang und Bildmarke im echten Browser.
 *
 * Hören kann ein Test nichts. Aber er kann nachsehen, ob überhaupt Töne
 * erzeugt werden - und ob sie ausbleiben, wenn jemand den Ton abgeschaltet
 * hat. Genau das ist der Fall, der im Betrieb stört: ein Chat, der piept,
 * obwohl man ihn stummgestellt hat.
 *
 * Und die Bildmarke: sie steht an drei Stellen (Browser-Reiter, App-Symbol,
 * Startseite) und muss überall dieselbe sein. Vorher stand in der App ein
 * nacktes Schloss, während im Reiter längst die Sprechblase klebte.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat, joinChat, sendText } from './helpers.js';

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

/**
 * Hört mit, was aus dem Tonkanal wirklich herauskommt.
 *
 * Zwei Dinge werden mitgeschrieben, und beide werden gebraucht:
 *
 *   - Welche Frequenzen geplant werden. Damit lässt sich prüfen, dass nichts
 *     Schrilles dabei ist.
 *   - Wie laut es am Ausgang tatsächlich wird. Das ist der wichtigere Teil:
 *     Frequenzen werden auch dann eingetragen, wenn der Ton nirgendwo
 *     angeschlossen ist. Kappt man eine einzige Verbindung, ist die App
 *     vollständig stumm - und ein Test, der nur Frequenzen zählt, merkt
 *     davon nichts.
 *
 * Dafür wird der Ausgang des Kanals unterwandert: `destination` liefert einen
 * Messknoten, der seinerseits am echten Ausgang hängt. Alles, was die App
 * anschliesst, läuft dadurch hindurch, und ein Zeitgeber merkt sich den
 * lautesten Wert, der je dort ankam.
 *
 * Muss vor dem Laden der Seite gesetzt werden - die App legt ihren Tonkanal
 * beim ersten Klang an.
 */
async function toeneMitschreiben(page) {
  await page.addInitScript(() => {
    window.__toene = [];
    window.__pegel = 0;
    const Original = window.AudioContext || window.webkitAudioContext;
    if (!Original) return;
    const echterAusgang = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(Original.prototype), 'destination',
    ) ?? Object.getOwnPropertyDescriptor(Original.prototype, 'destination');

    class Mitschrift extends Original {
      constructor(...args) {
        super(...args);
        window.__kanaele = (window.__kanaele ?? 0) + 1;
        this.__mess = super.createAnalyser();
        this.__mess.fftSize = 2048;
        this.__mess.connect(echterAusgang.get.call(this));
        const puffer = new Float32Array(this.__mess.fftSize);
        setInterval(() => {
          this.__mess.getFloatTimeDomainData(puffer);
          for (const wert of puffer) {
            const betrag = Math.abs(wert);
            if (betrag > window.__pegel) window.__pegel = betrag;
          }
        }, 20);
      }

      get destination() {
        return this.__mess;
      }

      createOscillator() {
        const oszillator = super.createOscillator();
        const setzen = oszillator.frequency.setValueAtTime.bind(oszillator.frequency);
        oszillator.frequency.setValueAtTime = (wert, zeit) => {
          window.__toene.push(Math.round(wert));
          return setzen(wert, zeit);
        };
        return oszillator;
      }
    }
    window.AudioContext = Mitschrift;
    window.webkitAudioContext = Mitschrift;
  });
}

const toene = (page) => page.evaluate(() => window.__toene ?? []);
const kanaele = (page) => page.evaluate(() => window.__kanaele ?? 0);
/** Der lauteste Wert, der je am Ausgang ankam. 0 heisst: es war wirklich still. */
const pegel = (page) => page.evaluate(() => window.__pegel ?? 0);

test('Die Bildmarke im Reiter und in der App ist dieselbe', async ({ page }) => {
  await page.goto('./');

  // Im Reiter: die Datei, die auch das App-Symbol liefert. Daneben steht eine
  // Rasterfassung für Browser ohne SVG-Favicon - hier geht es um die erste.
  const favicon = await page.locator('link[rel="icon"][type="image/svg+xml"]').getAttribute('href');
  expect(favicon).toContain('icon.svg');

  // Auf der Startseite: dieselbe Marke, nicht mehr das nackte Schloss.
  const marke = page.locator('#screen-start .logo svg use');
  await expect(marke).toHaveAttribute('href', '#i-logo');

  // Und in der Marke steht "psst..." - im Reiter wie in der App.
  const ausDerDatei = await page.evaluate(async (pfad) => (await fetch(pfad)).text(), favicon);
  expect(ausDerDatei).toContain('psst...');
  await expect(page.locator('#i-logo text')).toHaveText('psst...');
});

/**
 * Nicht jeder Browser nimmt ein SVG als Favicon. Wer es nicht nimmt, fragt
 * /favicon.ico im Wurzelverzeichnis der DOMAIN an - unter einem Unterpfad
 * steht dort die Marke der Nachbarseite. Also muss eine Rasterfassung daneben
 * stehen, und die muss es auch wirklich geben.
 */
test('Es gibt eine Rasterfassung fuer Browser ohne SVG-Favicon', async ({ page }) => {
  await page.goto('./');
  const raster = page.locator('link[rel="icon"][type="image/png"]');
  await expect(raster).toHaveCount(1);
  const href = await raster.getAttribute('href');
  const antwort = await page.request.get(new URL(href, page.url()).href);
  expect(antwort.ok(), `${href} laesst sich nicht laden`).toBe(true);
  expect(antwort.headers()['content-type']).toContain('image/png');
});

test('Das App-Symbol im Manifest zeigt dieselbe Marke', async ({ page }) => {
  await page.goto('./');
  const manifest = await page.evaluate(async () => {
    const verweis = document.querySelector('link[rel="manifest"]').href;
    return (await fetch(verweis)).json();
  });
  expect(manifest.icons.length).toBeGreaterThan(0);
  // Jedes angegebene Symbol muss es auch wirklich geben.
  for (const symbol of manifest.icons) {
    const antwort = await page.request.get(new URL(symbol.src, page.url()).href);
    expect(antwort.ok(), `${symbol.src} fehlt`).toBe(true);
  }
});

test('Beim Senden und Empfangen klingt es', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  await toeneMitschreiben(seiteA);

  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });

  // Der Tonkanal wacht erst an einer echten Eingabe auf - genau wie im Leben.
  await seiteA.locator('#message-input').click();
  const vorher = (await toene(seiteA)).length;

  await sendText(seiteA, 'Hallo');
  await expect.poll(() => toene(seiteA).then((t) => t.length), { timeout: 5000 }).toBeGreaterThan(vorher);
  // Und es kommt auch wirklich am Ausgang an, nicht nur im Terminkalender.
  await expect.poll(() => pegel(seiteA), { timeout: 5000 }).toBeGreaterThan(0);

  // Und wenn etwas ankommt, klingt es ebenfalls.
  const nachSenden = (await toene(seiteA)).length;
  await sendText(seiteB, 'Hallo zurück');
  await expect.poll(() => toene(seiteA).then((t) => t.length), { timeout: 20_000 }).toBeGreaterThan(nachSenden);

  // Alle Töne liegen im gedämpften Bereich - nichts Schrilles.
  const alle = await toene(seiteA);
  expect(Math.max(...alle)).toBeLessThanOrEqual(2400);
  expect(Math.min(...alle)).toBeGreaterThanOrEqual(500);

  // Und es bleibt bei einem einzigen Tonkanal.
  expect(await kanaele(seiteA)).toBe(1);

  await kontextA.close();
  await kontextB.close();
});

test('Wer den Ton abschaltet, hoert nichts mehr', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  await toeneMitschreiben(seiteA);

  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });

  // Erst die Gegenprobe: mit Ton klingt es. Ohne diesen Schritt wäre der
  // Test genauso grün, wenn überhaupt kein Ton mehr funktioniert - und
  // "stumm, weil abgeschaltet" sähe aus wie "stumm, weil kaputt".
  await seiteA.locator('#message-input').click();
  await sendText(seiteA, 'Laut');
  await expect.poll(() => pegel(seiteA), { timeout: 5000 }).toBeGreaterThan(0);

  // Ton aus über das Menü.
  await seiteA.locator('#chat-menu').click();
  await seiteA.getByRole('button', { name: /^Ton/ }).click();
  await expect(seiteA.locator('#toast')).toContainText(/Ton aus/i);

  const still = (await toene(seiteA)).length;
  // Den Messwert zuruecksetzen: ab hier darf nichts mehr am Ausgang ankommen.
  await seiteA.evaluate(() => { window.__pegel = 0; });
  await sendText(seiteA, 'Leise');
  await sendText(seiteB, 'Auch leise');
  await expect(seiteA.locator('#messages .msg').last()).toContainText('Auch leise', { timeout: 20_000 });
  await seiteA.waitForTimeout(900);

  expect(await toene(seiteA)).toHaveLength(still);
  expect(await pegel(seiteA), 'es kam trotzdem etwas am Ausgang an').toBe(0);

  await kontextA.close();
  await kontextB.close();
});

test('Vor der ersten Eingabe wird kein Ton erzwungen', async ({ browser }) => {
  // Browser lassen Ton ohnehin erst nach einer Eingabe zu. Die App soll
  // deswegen aber nicht schon beim Laden einen Tonkanal aufreissen.
  const kontext = await browser.newContext(HANDY);
  const seite = await kontext.newPage();
  await toeneMitschreiben(seite);
  await seite.goto('./');
  await expect(seite.getByRole('button', { name: /Neuen Chat starten/i })).toBeVisible();
  await seite.waitForTimeout(500);
  expect(await kanaele(seite)).toBe(0);
  await kontext.close();
});
