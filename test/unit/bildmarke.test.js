/**
 * Die Bildmarke.
 *
 * Sie steht an vier Stellen - Browser-Reiter, App-Symbol, Startbildschirm,
 * Benachrichtigung - und wird für drei davon aus einer einzigen SVG-Datei
 * gezeichnet. Was dabei schiefgeht, sieht man nicht im Quelltext, sondern
 * erst auf dem Gerät, und dort erst nach der Installation.
 *
 * Zwei Fehler dieser Art waren schon drin: hinter der abgerundeten Platte lag
 * eine flache Farbe statt des Verlaufs (in drei von vier Ecken ein harter
 * blauer Viertelmond), und das Abzeichen für die Statusleiste belegte nicht
 * einmal die Hälfte seiner Leinwand. Beides wird hier an den ausgelieferten
 * Bytes nachgemessen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shape, TARGETS } from '../../scripts/make-icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const img = (name) => path.join(root, 'public', 'img', name);
const quelle = fs.readFileSync(img('icon.svg'), 'utf8');

/**
 * Ein PNG lesen, ohne eine Fremdbibliothek dafür ins Projekt zu holen.
 * Reicht für das, was hier gebraucht wird: Größe und einzelne Bildpunkte.
 */
function readPng(datei) {
  const daten = fs.readFileSync(datei);
  let pos = 8;
  let breite = 0;
  let hoehe = 0;
  let farbtyp = 0;
  const teile = [];
  while (pos < daten.length) {
    const laenge = daten.readUInt32BE(pos);
    const typ = daten.toString('ascii', pos + 4, pos + 8);
    const inhalt = daten.subarray(pos + 8, pos + 8 + laenge);
    if (typ === 'IHDR') {
      breite = inhalt.readUInt32BE(0);
      hoehe = inhalt.readUInt32BE(4);
      assert.equal(inhalt[8], 8, `${path.basename(datei)}: nur 8 Bit je Kanal`);
      assert.equal(inhalt[12], 0, `${path.basename(datei)}: nicht verschachtelt`);
      farbtyp = inhalt[9];
    }
    if (typ === 'IDAT') teile.push(inhalt);
    pos += 12 + laenge;
  }
  const kanaele = { 0: 1, 2: 3, 4: 2, 6: 4 }[farbtyp];
  assert.ok(kanaele, `unbekannter Farbtyp ${farbtyp}`);
  const roh = zlib.inflateSync(Buffer.concat(teile));
  const breiteBytes = breite * kanaele;
  const bild = Buffer.alloc(hoehe * breiteBytes);
  let quellPos = 0;
  for (let y = 0; y < hoehe; y += 1) {
    const filter = roh[quellPos];
    quellPos += 1;
    const zeile = bild.subarray(y * breiteBytes, (y + 1) * breiteBytes);
    roh.copy(zeile, 0, quellPos, quellPos + breiteBytes);
    quellPos += breiteBytes;
    const vorige = y > 0 ? bild.subarray((y - 1) * breiteBytes, y * breiteBytes) : null;
    for (let x = 0; x < breiteBytes; x += 1) {
      const a = x >= kanaele ? zeile[x - kanaele] : 0;
      const b = vorige ? vorige[x] : 0;
      const c = vorige && x >= kanaele ? vorige[x - kanaele] : 0;
      if (filter === 1) zeile[x] = (zeile[x] + a) & 255;
      else if (filter === 2) zeile[x] = (zeile[x] + b) & 255;
      else if (filter === 3) zeile[x] = (zeile[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const vor = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
        zeile[x] = (zeile[x] + vor) & 255;
      }
    }
  }
  const punkt = (x, y) => [...bild.subarray((y * breite + x) * kanaele, (y * breite + x) * kanaele + kanaele)];
  const deckend = (x, y) => (kanaele === 4 || kanaele === 2 ? punkt(x, y).at(-1) : 255);
  return { breite, hoehe, kanaele, punkt, deckend };
}

// ---------------------------------------------------- Was in der Marke steht

test('In der Marke steht psst', () => {
  assert.match(quelle, />psst\.\.\.</, 'die Sprechblase ist leer');
  // Festgenagelte Breite: dieselbe Datei dient als Favicon, App-Symbol und
  // Marke in der App - ueberall stehen andere Schriften zur Verfuegung.
  assert.match(quelle, /textLength="\d+"/);
  assert.match(quelle, /lengthAdjust="spacingAndGlyphs"/);
});

// ------------------------------------------------- Die Platte je nach Ziel

test('Wer selbst beschneidet, bekommt die Platte randfuellend', () => {
  // iOS legt seine Squircle-Maske darueber, Android bei "maskable" eine
  // beliebige Form. Bliebe die Platte rund, schnitte die Maske ins Leere.
  for (const ziel of TARGETS.filter((z) => z.plate === 'full')) {
    const svg = shape(quelle, ziel);
    assert.match(svg, /rx="0"/, `${ziel.file}: die Platte ist noch rund`);
  }
  assert.ok(TARGETS.some((z) => z.plate === 'full'), 'es gibt gar kein solches Ziel');
});

test('Wo niemand beschneidet, bleiben die Ecken rund', () => {
  for (const ziel of TARGETS.filter((z) => z.plate === 'rounded')) {
    assert.match(shape(quelle, ziel), /rx="112"/, `${ziel.file}: die Rundung ist weg`);
  }
});

/**
 * Bei "maskable" darf nur der INHALT in die Safe-Zone ruecken. Wuerde die
 * ganze Zeichnung verkleinert, finge auch die Platte erst bei 10 Prozent an -
 * und der Rand, den die Maske gerade wegschneiden soll, waere leer.
 */
test('Die Safe-Zone rueckt den Inhalt ein, nicht die Platte', () => {
  const ziel = TARGETS.find((z) => z.inset > 0);
  assert.ok(ziel, 'es gibt kein Ziel mit Safe-Zone');
  const svg = shape(quelle, ziel);
  const gruppe = svg.indexOf('<g transform=');
  const platte = svg.indexOf('<rect');
  assert.ok(gruppe > 0, 'der Inhalt wird gar nicht eingerueckt');
  assert.ok(platte >= 0 && platte < gruppe, 'die Platte liegt mit in der Gruppe');
  assert.match(svg, /scale\(0\.8\)/);
  assert.ok(svg.indexOf('<text') > gruppe, 'die Schrift liegt ausserhalb der Gruppe');
});

test('Ohne Safe-Zone wird nichts verschoben', () => {
  for (const ziel of TARGETS.filter((z) => !z.inset)) {
    assert.ok(!shape(quelle, ziel).includes('<g transform='), `${ziel.file}: unerwartet eingerueckt`);
  }
});

// ------------------------------------------------ Was wirklich ausgeliefert wird

/**
 * Der Fehler, der schon einmal drin war: hinter der Datei lag eine flache
 * Farbe. Die Platte in der Datei ist aber ein Verlauf - ausserhalb der
 * Rundung wurde deshalb das flache Blau eingebacken, und das passt nur in
 * der linken oberen Ecke.
 */
test('Die runden Symbole haben durchsichtige Ecken, keine eingebackene Flaeche', () => {
  for (const ziel of TARGETS.filter((z) => z.plate === 'rounded')) {
    const png = readPng(img(ziel.file));
    const m = png.breite - 1;
    for (const [x, y] of [[0, 0], [m, 0], [0, m], [m, m]]) {
      assert.equal(png.deckend(x, y), 0, `${ziel.file}: Ecke (${x},${y}) ist nicht durchsichtig`);
    }
    // Und drinnen steht trotzdem etwas.
    assert.equal(png.deckend(Math.round(m / 2), Math.round(m / 2)), 255, `${ziel.file}: innen ist nichts`);
  }
});

test('Die randfuellenden Symbole zeigen in den Ecken den Verlauf, nicht eine Farbe', () => {
  for (const ziel of TARGETS.filter((z) => z.plate === 'full')) {
    const png = readPng(img(ziel.file));
    const m = png.breite - 1;
    const ecken = [[0, 0], [m, 0], [0, m], [m, m]].map(([x, y]) => png.punkt(x, y).slice(0, 3));
    for (const [i, ecke] of ecken.entries()) {
      assert.ok(png.deckend(...[[0, 0], [m, 0], [0, m], [m, m]][i]) === 255, `${ziel.file}: durchsichtige Ecke`);
    }
    const [lo, ru] = [ecken[0], ecken[3]];
    const abstand = Math.abs(lo[0] - ru[0]) + Math.abs(lo[1] - ru[1]) + Math.abs(lo[2] - ru[2]);
    assert.ok(abstand > 60, `${ziel.file}: die Ecken sind gleich - das ist kein Verlauf, sondern eine Flaeche`);
  }
});

/**
 * Android faerbt das Abzeichen selbst ein und skaliert die Bitmap als Ganzes
 * in seine rund 24 dp. Bleibt rundherum Luft, wird das Zeichen zusaetzlich
 * verkleinert und sitzt sichtbar zu hoch.
 */
test('Das Abzeichen fuellt seine Leinwand aus', () => {
  const png = readPng(img('badge.png'));
  let x0 = png.breite;
  let y0 = png.hoehe;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < png.hoehe; y += 1) {
    for (let x = 0; x < png.breite; x += 1) {
      if (png.deckend(x, y) <= 8) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const anteil = ((x1 - x0 + 1) * (y1 - y0 + 1)) / (png.breite * png.hoehe);
  assert.ok(anteil > 0.7, `das Abzeichen belegt nur ${Math.round(anteil * 100)} % seiner Leinwand`);
  // Und es sitzt mittig - nicht oben angeklebt.
  const oben = y0;
  const unten = png.hoehe - 1 - y1;
  assert.ok(Math.abs(oben - unten) <= png.hoehe * 0.06, `oben ${oben} px, unten ${unten} px - das sitzt schief`);
});

test('Jedes Symbol aus dem Manifest liegt auch wirklich da', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public', 'manifest.webmanifest'), 'utf8'));
  assert.ok(manifest.icons.length > 0);
  for (const symbol of manifest.icons) {
    assert.ok(fs.existsSync(path.join(root, 'public', symbol.src)), `${symbol.src} fehlt`);
  }
});
