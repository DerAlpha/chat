/**
 * Die GIF-Suche - ohne Netz und ohne Schlüssel.
 *
 * Geprüft wird das, worauf es ankommt: dass keine einzige Giphy-Adresse zum
 * Browser durchsickert, dass niemand diesen Server als offenen Proxy für
 * beliebige Adressen benutzen kann, und dass aus dem Dutzend angebotener
 * Grössen die richtige gewählt wird.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { allowedMedia, fetchMedia, searchGifs, signRef, verifyRef } from '../../server/gifs.js';

const SECRET = Buffer.from('geheimnis-fuer-die-signatur-von-verweisen');

/** Eine Antwort, wie Giphy sie schickt - gekürzt auf das Wesentliche. */
function giphyAntwort(anzahl = 12) {
  return {
    data: Array.from({ length: anzahl }, (_, i) => ({
      id: `gif${i}`,
      title: `Ein Titel ${i}`,
      images: {
        preview_webp: { url: `https://media3.giphy.com/media/${i}/preview.webp`, width: '100', height: '80', size: '26318' },
        preview_gif: { url: `https://media3.giphy.com/media/${i}/preview.gif`, width: '100', height: '80', size: '47028' },
        fixed_width: { url: `https://media3.giphy.com/media/${i}/200w.gif`, width: '200', height: '160', size: '559283' },
        downsized_medium: { url: `https://media3.giphy.com/media/${i}/medium.gif`, width: '330', height: '264', size: '1517585' },
        original: { url: `https://media3.giphy.com/media/${i}/original.gif`, width: '480', height: '384', size: '9000000' },
      },
    })),
    pagination: { offset: 0, count: anzahl, total_count: 500 },
  };
}

function stubFetch(handler) {
  return async (url, options) => handler(String(url), options);
}

// --- Verweise --------------------------------------------------------------

test('Ein signierter Verweis lässt sich wieder auflösen', () => {
  const url = 'https://media3.giphy.com/media/abc/preview.webp';
  const token = signRef(SECRET, url);
  assert.equal(verifyRef(SECRET, token), url);
});

test('Ohne die richtige Signatur wird nichts aufgelöst', () => {
  const token = signRef(SECRET, 'https://media3.giphy.com/media/abc/preview.webp');
  assert.equal(verifyRef(Buffer.from('anderes-geheimnis'), token), null);
  assert.equal(verifyRef(SECRET, `${token}x`), null);
  assert.equal(verifyRef(SECRET, token.replace(/^./, 'A')), null);
});

test('Ein abgelaufener Verweis gilt nicht mehr', () => {
  const token = signRef(SECRET, 'https://media3.giphy.com/media/abc/x.webp', Date.now() - 3600_000);
  assert.equal(verifyRef(SECRET, token), null);
});

test('Der Server holt nur bei Giphy, nicht bei beliebigen Adressen', () => {
  // Der gefährliche Fall: jemand lässt sich einen Verweis auf eine fremde
  // Adresse signieren und benutzt den Server dann als offenen Proxy - etwa
  // auf ein internes Netz, an das er selbst nicht herankommt.
  for (const böse of [
    'https://boese.de/x.gif',
    'http://media3.giphy.com/x.gif',        // unverschlüsselt
    'https://giphy.com.boese.de/x.gif',     // sieht nur so aus
    'https://127.0.0.1/x.gif',
    'https://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
  ]) {
    assert.equal(allowedMedia(böse), false, `durchgelassen: ${böse}`);
    assert.equal(verifyRef(SECRET, signRef(SECRET, böse)), null, `aufgelöst: ${böse}`);
  }
  assert.equal(allowedMedia('https://media3.giphy.com/media/x.gif'), true);
  assert.equal(allowedMedia('https://giphy.com/x.gif'), true);
});

test('Ein unsinniger Verweis bringt nichts zum Absturz', () => {
  for (const müll of ['', '.', 'a.b', 'x'.repeat(5000), '!!!.!!!', null, 42]) {
    assert.equal(verifyRef(SECRET, müll), null);
  }
});

// --- Suche -----------------------------------------------------------------

test('Die Antwort an den Browser enthält keine einzige Giphy-Adresse', async () => {
  const ergebnis = await searchGifs({
    key: 'geheim', query: 'katze', secret: SECRET,
    fetchImpl: stubFetch(async () => ({ ok: true, json: async () => giphyAntwort() })),
  });
  assert.equal(ergebnis.items.length, 12);
  const alsText = JSON.stringify(ergebnis);
  assert.equal(alsText.includes('giphy'), false, 'eine Giphy-Adresse ist durchgesickert');
  assert.equal(alsText.includes('media3'), false);
  // Der Schlüssel schon gar nicht.
  assert.equal(alsText.includes('geheim'), false);
});

test('Der Schlüssel geht an Giphy, nicht an den Browser', async () => {
  let gerufen = '';
  await searchGifs({
    key: 'mein-schluessel', query: 'hund', secret: SECRET,
    fetchImpl: stubFetch(async (url) => { gerufen = url; return { ok: true, json: async () => giphyAntwort(1) }; }),
  });
  assert.match(gerufen, /^https:\/\/api\.giphy\.com\/v1\/gifs\/search\?/);
  assert.match(gerufen, /api_key=mein-schluessel/);
  assert.match(gerufen, /q=hund/);
  assert.match(gerufen, /rating=pg-13/);
});

test('Ohne Suchbegriff kommen die gerade beliebten', async () => {
  let gerufen = '';
  await searchGifs({
    key: 'k', query: '', secret: SECRET,
    fetchImpl: stubFetch(async (url) => { gerufen = url; return { ok: true, json: async () => giphyAntwort(1) }; }),
  });
  assert.match(gerufen, /\/v1\/gifs\/trending\?/);
  assert.equal(/[?&]q=/.test(gerufen), false);
});

test('Für die Übersicht wird die kleinste bewegte Größe genommen', async () => {
  const ergebnis = await searchGifs({
    key: 'k', query: 'x', secret: SECRET,
    fetchImpl: stubFetch(async () => ({ ok: true, json: async () => giphyAntwort(1) })),
  });
  // 26 KB statt 200 KB - bei zwölf Treffern macht das den Unterschied.
  assert.equal(verifyRef(SECRET, ergebnis.items[0].preview), 'https://media3.giphy.com/media/0/preview.webp');
});

test('Zum Verschicken wird eine ordentliche Größe genommen, aber keine riesige', async () => {
  const ergebnis = await searchGifs({
    key: 'k', query: 'x', secret: SECRET,
    fetchImpl: stubFetch(async () => ({ ok: true, json: async () => giphyAntwort(1) })),
  });
  assert.equal(verifyRef(SECRET, ergebnis.items[0].full), 'https://media3.giphy.com/media/0/medium.gif');
  assert.equal(ergebnis.items[0].bytes, 1517585);
});

test('Ein Treffer ohne brauchbare Größen wird übersprungen', async () => {
  const antwort = giphyAntwort(2);
  antwort.data[0].images = { original: { url: 'https://boese.de/x.gif', size: '10' } };
  const ergebnis = await searchGifs({
    key: 'k', query: 'x', secret: SECRET,
    fetchImpl: stubFetch(async () => ({ ok: true, json: async () => antwort })),
  });
  assert.equal(ergebnis.items.length, 1);
  assert.equal(ergebnis.items[0].id, 'gif1');
});

test('Weitersuchen geht, solange Giphy noch etwas hat', async () => {
  const voll = await searchGifs({
    key: 'k', query: 'x', secret: SECRET,
    fetchImpl: stubFetch(async () => ({ ok: true, json: async () => giphyAntwort(12) })),
  });
  assert.equal(voll.next, 12);

  const letzte = giphyAntwort(12);
  letzte.pagination.total_count = 12;
  const ende = await searchGifs({
    key: 'k', query: 'x', secret: SECRET,
    fetchImpl: stubFetch(async () => ({ ok: true, json: async () => letzte })),
  });
  assert.equal(ende.next, null);
});

test('Ein Fehler bei Giphy wird nach oben gereicht', async () => {
  await assert.rejects(
    () => searchGifs({
      key: 'k', query: 'x', secret: SECRET,
      fetchImpl: stubFetch(async () => ({ ok: false, status: 429 })),
    }),
    /429/,
  );
});

// --- Bilder holen ----------------------------------------------------------

test('Ein Bild kommt unverändert durch', async () => {
  const inhalt = Buffer.from('GIF89a...');
  const { bytes, mime } = await fetchMedia('https://media3.giphy.com/x.gif', {
    fetchImpl: stubFetch(async () => ({
      ok: true,
      headers: new Map([['content-type', 'image/gif'], ['content-length', String(inhalt.length)]]),
      arrayBuffer: async () => inhalt.buffer.slice(inhalt.byteOffset, inhalt.byteOffset + inhalt.length),
    })),
  });
  assert.deepEqual(bytes, inhalt);
  assert.equal(mime, 'image/gif');
});

test('Was kein Bild ist, wird nicht als Bild ausgeliefert', async () => {
  const { mime } = await fetchMedia('https://media3.giphy.com/x', {
    fetchImpl: stubFetch(async () => ({
      ok: true,
      headers: new Map([['content-type', 'text/html']]),
      arrayBuffer: async () => new ArrayBuffer(4),
    })),
  });
  assert.equal(mime, 'application/octet-stream');
});

test('Zu grosse Bilder werden abgelehnt - vor und nach dem Laden', async () => {
  // Angekündigt zu gross: gar nicht erst herunterladen.
  await assert.rejects(() => fetchMedia('https://media3.giphy.com/x.gif', {
    maxBytes: 100,
    fetchImpl: stubFetch(async () => ({
      ok: true,
      headers: new Map([['content-length', '999999']]),
      arrayBuffer: async () => new ArrayBuffer(10),
    })),
  }), /zu gross/);

  // Gelogen bei der Ankündigung: nach dem Laden trotzdem ablehnen.
  await assert.rejects(() => fetchMedia('https://media3.giphy.com/x.gif', {
    maxBytes: 100,
    fetchImpl: stubFetch(async () => ({
      ok: true,
      headers: new Map([['content-length', '10']]),
      arrayBuffer: async () => new ArrayBuffer(999),
    })),
  }), /zu gross/);
});

// --- Beide Backends müssen dasselbe rechnen -------------------------------

const phpVorhanden = (() => {
  try {
    execFileSync('php', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Node und PHP unterschreiben Verweise nach demselben Verfahren. Liefe das
 * auseinander - etwa weil eine Seite in Millisekunden und die andere in
 * Sekunden rechnet -, fiele es erst im Betrieb auf, und nur bei der einen
 * Auslieferung. Deshalb hier gegeneinander gerechnet, mit festem Zeitpunkt.
 */
test('PHP und Node erzeugen denselben Verweis', { skip: phpVorhanden ? false : 'PHP nicht vorhanden' }, () => {
  const wurzel = path.resolve(import.meta.dirname, '../..');
  const url = 'https://media3.giphy.com/media/x/preview.webp';
  const geheim = 'gemeinsames-geheimnis';
  const zeitpunkt = 1_700_000_000;

  const vonPhp = execFileSync('php', ['-r', `
    require ${JSON.stringify(path.join(wurzel, 'php/api/lib/Http.php'))};
    require ${JSON.stringify(path.join(wurzel, 'php/api/lib/Config.php'))};
    require ${JSON.stringify(path.join(wurzel, 'php/api/lib/Gifs.php'))};
    echo Gifs::signRef(${JSON.stringify(geheim)}, ${JSON.stringify(url)}, ${zeitpunkt});
  `], { encoding: 'utf8' }).trim();

  const vonNode = signRef(geheim, url, zeitpunkt * 1000);
  assert.equal(vonPhp, vonNode, 'die beiden Backends unterschreiben verschieden');
  assert.equal(verifyRef(geheim, vonPhp, zeitpunkt * 1000), url);
});

test('PHP lehnt dieselben Adressen ab wie Node', { skip: phpVorhanden ? false : 'PHP nicht vorhanden' }, () => {
  const wurzel = path.resolve(import.meta.dirname, '../..');
  const proben = [
    'https://media3.giphy.com/media/x.gif',
    'https://giphy.com/x.gif',
    'https://boese.de/x.gif',
    'http://media3.giphy.com/x.gif',
    'https://giphy.com.boese.de/x.gif',
    'https://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
  ];
  const vonPhp = JSON.parse(execFileSync('php', ['-r', `
    require ${JSON.stringify(path.join(wurzel, 'php/api/lib/Http.php'))};
    require ${JSON.stringify(path.join(wurzel, 'php/api/lib/Config.php'))};
    require ${JSON.stringify(path.join(wurzel, 'php/api/lib/Gifs.php'))};
    $out = [];
    foreach (${JSON.stringify(JSON.stringify(proben))} ? json_decode(${JSON.stringify(JSON.stringify(proben))}, true) : [] as $u) {
      $out[] = Gifs::allowedMedia($u);
    }
    echo json_encode($out);
  `], { encoding: 'utf8' }));

  const vonNode = proben.map((url) => allowedMedia(url));
  assert.deepEqual(vonPhp, vonNode, 'die beiden Backends urteilen verschieden über Adressen');
  assert.deepEqual(vonNode, [true, true, false, false, false, false, false]);
});
