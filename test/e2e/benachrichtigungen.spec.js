/**
 * Benachrichtigungen - und warum sie auf dem Telefon nie ankamen.
 *
 * Der Kern des Fehlers: Android verbietet `new Notification(...)`. Chrome
 * wirft dort "Illegal constructor" und verlangt den Weg über den Service
 * Worker. Genau das stand hier, in einem try/catch - der Fehler blieb still,
 * die Meldung blieb aus, und der Nutzer bekam für jeden Fehlschlag denselben
 * Satz zu lesen: "Im Browser blockiert".
 *
 * Beide Geräte lassen sich hier nachstellen, ganz ohne Gerät:
 *   Android - der Konstruktor wirft, alles andere ist erlaubt.
 *   iPhone  - es gibt gar kein Notification-Objekt, solange die App nicht
 *             auf dem Home-Bildschirm liegt.
 *
 * Wichtig: die schlanke Bauform von Chromium, mit der Playwright sonst
 * läuft, kennt überhaupt keine Meldungen - dort steht die Erlaubnis auch
 * nach `permissions: ['notifications']` auf "denied", und
 * `showNotification` wirft. Deshalb hier das vollständige Chromium.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat, joinChat, sendText } from './helpers.js';

test.use({ channel: 'chromium' });

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

/** Ein Paar im Chat. Der erste Kontext darf melden, der zweite schreibt. */
async function paar(browser, { erlaubt = true, vorbereiten } = {}) {
  const kA = await browser.newContext({ ...HANDY, ...(erlaubt ? { permissions: ['notifications'] } : {}) });
  const kB = await browser.newContext(HANDY);
  const a = await kA.newPage();
  const b = await kB.newPage();
  if (vorbereiten) await vorbereiten(a);
  const { link } = await createChat(a, { nick: 'Anton' });
  await joinChat(b, link, { nick: 'Mira' });
  await expect(a.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  return { kA, kB, a, b };
}

/** Schaltet die Meldungen im Speicher an - ohne den Weg übers Menü. */
async function meldungenAn(seite) {
  await seite.addInitScript(() => {
    try {
      const schluessel = 'fc:prefs:v1';
      const prefs = JSON.parse(localStorage.getItem(schluessel) ?? '{}');
      localStorage.setItem(schluessel, JSON.stringify({ ...prefs, notifications: true }));
    } catch { /* ohne Speicher eben nicht */ }
  });
}

/** Die Seite behauptet, sie liege im Hintergrund - sonst meldet sich nichts. */
async function imHintergrund(seite) {
  await seite.addInitScript(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
  });
}

/** Android: der Konstruktor ist gesperrt, alles andere geht. */
async function wieAndroid(seite) {
  await seite.addInitScript(() => {
    const echt = window.Notification;
    const Gesperrt = function Notification() {
      throw new TypeError("Failed to construct 'Notification': Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.");
    };
    Object.defineProperty(Gesperrt, 'permission', { get: () => echt.permission });
    Gesperrt.requestPermission = (...rest) => echt.requestPermission(...rest);
    window.Notification = Gesperrt;
  });
}

/** iPhone im Safari-Reiter: es gibt die Schnittstelle gar nicht. */
async function wieIphone(seite) {
  await seite.addInitScript(() => {
    delete window.Notification;
    Object.defineProperty(navigator, 'userAgent', {
      get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      configurable: true,
    });
    Object.defineProperty(navigator, 'standalone', { get: () => false, configurable: true });
  });
}

/** Was der Service Worker gerade anzeigt. */
const offeneMeldungen = (seite) => seite.evaluate(async () => {
  const registrierung = await navigator.serviceWorker.getRegistration();
  if (!registrierung) return null;
  return (await registrierung.getNotifications()).map((meldung) => ({
    titel: meldung.title, body: meldung.body, tag: meldung.tag,
  }));
});

test('Der Schalter lässt sich wirklich umlegen', async ({ browser }) => {
  const { kA, kB, a } = await paar(browser);
  await a.locator('#chat-menu').click();
  const zeile = a.locator('#sheet .sheet-item', { hasText: 'Benachrichtigungen' });
  await expect(zeile).toContainText('Aus');
  await zeile.click();
  await expect(a.locator('#toast')).toContainText('Benachrichtigungen an');

  // Und der Zustand hält - im Speicher wie in der Beschriftung.
  await a.locator('#chat-menu').click();
  await expect(a.locator('#sheet .sheet-item', { hasText: 'Benachrichtigungen' })).toContainText('An');
  await kA.close(); await kB.close();
});

/**
 * Der eigentliche Fehler. Auf Android wirft `new Notification(...)`, und
 * genau das stellt dieser Test nach: die Erlaubnis liegt vor, der
 * Konstruktor ist gesperrt - die Meldung muss trotzdem herausgehen.
 *
 * GEGENPROBE: in public/js/app.js in zeigeMeldung() den Konstruktor wieder
 * vor den Service Worker ziehen. Dann wirft er, der Fang schluckt es, und
 * dieser Test wird rot.
 */
test('Auch wenn der Browser den Konstruktor sperrt, kommt die Meldung an', async ({ browser }) => {
  const { kA, kB, a, b } = await paar(browser, {
    vorbereiten: async (seite) => {
      await meldungenAn(seite);
      await imHintergrund(seite);
      await wieAndroid(seite);
    },
  });

  // Erst nachweisen, dass die Nachstellung wirklich greift.
  const gesperrt = await a.evaluate(() => {
    try { new Notification('x'); return 'ging durch'; } catch (fehler) { return String(fehler).slice(0, 30); }
  });
  expect(gesperrt, 'die Android-Nachstellung greift nicht').toContain('TypeError');

  await sendText(b, 'Klopf klopf');
  await expect.poll(async () => (await offeneMeldungen(a))?.length ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(0);
  const meldungen = await offeneMeldungen(a);
  expect(meldungen[0].titel, 'die Meldung nennt nicht den Absender').toBe('Mira');
  expect(meldungen[0].body).toContain('Klopf klopf');
  await kA.close(); await kB.close();
});

/**
 * Der iPhone-Fall: es gibt kein Notification-Objekt. Das ist nicht
 * "blockiert" - es fehlt nur die Voraussetzung, und die App muss sagen,
 * welche.
 *
 * GEGENPROBE: in public/js/app.js in meldungsLage() den Zweig
 * 'homebildschirm' entfernen. Dann steht wieder "Im Browser blockiert" da,
 * und dieser Test wird rot.
 */
test('Ohne die Schnittstelle nennt die App den Weg, nicht "blockiert"', async ({ browser }) => {
  const { kA, kB, a } = await paar(browser, { erlaubt: false, vorbereiten: wieIphone });

  await a.locator('#chat-menu').click();
  const zeile = a.locator('#sheet .sheet-item', { hasText: 'Benachrichtigungen' });
  await expect(zeile).toContainText('Nur als App');
  await expect(zeile, 'nichts ist blockiert - es fehlt die Einrichtung').not.toContainText('blockiert');

  await zeile.click();
  await expect(a.locator('#sheet')).toBeVisible();
  const blatt = await a.evaluate(() => document.getElementById('sheet-body').textContent);
  expect(blatt, 'der Weg auf den Home-Bildschirm fehlt').toContain('Home-Bildschirm');
  expect(blatt, 'der Hinweis auf den eigenen Speicher fehlt').toContain('eigenen Speicher');
  expect(blatt, 'die alte Sammelmeldung steht immer noch da').not.toContain('Im Browser blockiert');
  await kA.close(); await kB.close();
});

/**
 * Ein Tipp auf die Meldung darf keine Sackgasse sein.
 *
 * Geprüft wird der Handler im Service Worker selbst: ein nachgestelltes
 * Ereignis, und dann die Frage, ob er das Fenster der App geholt hat. Die
 * Nachbarschaft gehört ausdrücklich dazu - auf derselben Domain können
 * andere Seiten liegen, und deren Fenster gehen den Worker nichts an.
 */
test('Der Service Worker beantwortet den Tipp auf eine Meldung', async ({ browser }) => {
  const kontext = await browser.newContext({ ...HANDY, permissions: ['notifications'] });
  const seite = await kontext.newPage();
  await seite.goto('./');
  await expect(seite.locator('#screen-start')).toBeVisible();
  await seite.evaluate(() => navigator.serviceWorker.ready);

  const worker = kontext.serviceWorkers()[0]
    ?? await kontext.waitForEvent('serviceworker', { timeout: 10_000 });
  const ergebnis = await worker.evaluate(async (basis) => {
    const geholt = [];
    // `clients` ist ein Nur-Lese-Zugang auf dem Prototyp - eine Zuweisung
    // liefe wirkungslos ins Leere. Eine eigene Eigenschaft auf `self` legt
    // sich davor und laesst sich hinterher wieder wegnehmen.
    const echteClients = Object.getOwnPropertyDescriptor(self, 'clients');
    Object.defineProperty(self, 'clients', {
      configurable: true,
      value: {
        // Die Fremden stehen ZUERST: der Handler nimmt das erste Fenster,
        // das passt - werden sie uebersprungen, ist der Filter wirksam.
        matchAll: async () => [
          { url: 'https://fremde.example/', focus: async () => geholt.push('fremde') },
          ...(basis === '/'
            // Unter "/" ist der ganze Ursprung der Geltungsbereich - dort
            // gibt es kein Nachbarfenster, das draussen laege.
            ? []
            : [{ url: `${self.location.origin}/nachbar/`, focus: async () => geholt.push('nachbar') }]),
          { url: new URL(basis, self.location.origin).href, focus: async () => geholt.push('app') },
        ],
        openWindow: async (ziel) => geholt.push(`neu:${ziel}`),
      },
    });
    let fertig;
    const zu = new Promise((los) => { fertig = los; });
    const ereignis = new Event('notificationclick');
    ereignis.notification = { close: () => geholt.push('geschlossen'), data: {} };
    ereignis.waitUntil = (versprechen) => Promise.resolve(versprechen).then(fertig, fertig);
    self.dispatchEvent(ereignis);
    await zu;
    delete self.clients;
    if (echteClients) Object.defineProperty(self, 'clients', echteClients);
    return geholt;
  }, new URL(seite.url()).pathname.replace(/[^/]*$/, ''));

  expect(ergebnis, 'die Meldung bleibt nach dem Tipp stehen').toContain('geschlossen');
  expect(ergebnis, 'das Fenster der App wird nicht geholt').toContain('app');
  expect(ergebnis, 'der Worker greift nach einem fremden Ursprung').not.toContain('fremde');
  // Unter einem Unterpfad kommt die Nachbarschaft dazu: dieselbe Domain,
  // andere App. Unter "/" gibt es sie nicht, dort ist alles der eigene Hof.
  expect(ergebnis, 'der Worker greift nach dem Fenster der Nachbar-App').not.toContain('nachbar');
  await kontext.close();
});
