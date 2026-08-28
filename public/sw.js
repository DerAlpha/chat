/**
 * Service Worker: haelt die App-Huelle offline bereit.
 *
 * Wichtig: /api und /ws werden bewusst NIE zwischengespeichert. Dort liegen
 * die (verschluesselten) Inhalte, und die gehoeren nicht in einen Cache.
 */

/**
 * Die Fassung wird gestempelt, nicht gezaehlt: scripts/version.mjs rechnet
 * sie aus dem Inhalt aller ausgelieferten Dateien. Aendert sich eine einzige
 * Datei, aendert sich die Fassung - und dieser Worker raeumt seinen Speicher.
 * Ein Test wird rot, wenn der Stempel nicht mehr zum Inhalt passt.
 */
const VERSION = '86bf83a3cb6a';

/**
 * Die App kann unter "/" oder unter "/chats/" liegen. Der Geltungsbereich des
 * Service Workers ist ohnehin sein eigener Ordner - also leiten wir alle Pfade
 * daraus ab, statt sie fest zu verdrahten.
 */
const BASE = new URL('./', self.location).pathname;
const SHELL_CACHE = `fluesterchat-shell-${VERSION}-${BASE}`;
const INDEX = `${BASE}index.html`;

const SHELL = [
  '',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/base.js',
  'js/call.js',
  'js/call-worker.js',
  'js/crypto.js',
  'js/emoji.js',
  'js/framecrypto.js',
  'js/i18n.js',
  'js/media.js',
  'js/net.js',
  'js/qr.js',
  'js/session.js',
  'js/sound.js',
  'js/ui.js',
  'js/version.js',
  'manifest.webmanifest',
  'img/icon.svg',
  'img/icon-192.png',
  'img/icon-512.png',
].map((path) => BASE + path);

self.addEventListener('install', (event) => {
  // Bewusst OHNE skipWaiting: laeuft schon eine aeltere Fassung, wartet die
  // neue, bis der Nutzer im Fenster auf "Jetzt aktualisieren" tippt. Sonst
  // taeuschte der Browser eine Aktualisierung vor, waehrend die offene Seite
  // weiter mit altem Code arbeitet - genau die Verwirrung, die das hier
  // verhindern soll. Beim allerersten Mal gibt es nichts zu warten: ohne
  // vorherigen Worker wird sofort aktiviert.
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => { /* Offline installiert sich eben nichts vor. */ }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(`${BASE}api/`)
    || url.pathname === `${BASE}ws`
    || url.pathname === `${BASE}healthz`) return;
  // Alles ausserhalb der eigenen Basis geht uns nichts an (z. B. Nachbar-Apps
  // auf derselben Domain).
  if (!url.pathname.startsWith(BASE)) return;

  // Navigationen: erst das Netz fragen, sonst die gespeicherte Huelle zeigen.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(INDEX).then((hit) => hit ?? Response.error())),
    );
    return;
  }

  // Statische Dateien: aus dem Cache ausliefern und im Hintergrund erneuern.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    }),
  );
});

self.addEventListener('message', (event) => {
  // Zwei Schreibweisen, damit eine aeltere Seite im Browser denselben
  // Worker auch dann noch wecken kann, wenn sie die neue nicht kennt.
  const wunsch = typeof event.data === 'string' ? event.data : event.data?.type;
  if (wunsch === 'skip-waiting' || wunsch === 'skipWaiting') self.skipWaiting();
});
