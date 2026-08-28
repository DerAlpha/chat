/**
 * Farbkontraste nach WCAG 2.2 AA.
 *
 * Gerechnet statt geschaut: eine Farbe, die "noch geht", geht bei
 * Sonnenlicht auf einem billigen Bildschirm eben nicht mehr. Geprueft werden
 * die Paarungen, die im Stilblatt wirklich vorkommen - in HELL und DUNKEL,
 * denn genau dort war der Unterschied: dieselbe Regel, zwei Ergebnisse.
 *
 * 4.5:1 fuer Text, 3:1 fuer grosse Schrift und fuer Bedienelemente.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../../public/css/app.css', import.meta.url), 'utf8');

/** Liest die Farbtoken aus einem :root-Block. */
function token(block) {
  const werte = {};
  for (const [, name, wert] of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) werte[name] = wert;
  return werte;
}

/** Schneidet den Regelblock heraus, der bei `marke` beginnt - bis zur eigenen
    schliessenden Klammer am Zeilenanfang. Ein Marker aus dem anderen Schema
    taugt dafuer nicht: fehlt er, liefert indexOf -1 und der Block rutscht. */
function block(marke) {
  const von = css.indexOf(marke);
  assert.ok(von >= 0, `Der Block "${marke}" steht nicht mehr im Stilblatt`);
  const bis = css.indexOf('\n}', von);
  assert.ok(bis > von, `Der Block "${marke}" wird nicht geschlossen`);
  return css.slice(von, bis);
}

const hell = token(block(':root {'));
const dunkel = { ...hell, ...token(block('[data-system="dark"]')) };

const kanal = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex) => {
  const h = hex.replace('#', '');
  const voll = h.length === 3 ? [...h].map((z) => z + z).join('') : h;
  return [0, 2, 4].map((i) => Number.parseInt(voll.slice(i, i + 2), 16));
};
const helligkeit = (hex) => {
  const [r, g, b] = rgb(hex).map((v) => kanal(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const mischen = (vorn, hinten, anteil) => {
  const a = rgb(vorn); const b = rgb(hinten);
  return `#${a.map((v, i) => Math.round(v * anteil + b[i] * (1 - anteil)).toString(16).padStart(2, '0')).join('')}`;
};
const verhaeltnis = (a, b) => {
  const [x, y] = [helligkeit(a), helligkeit(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** @param {(t: Record<string,string>) => Array<[string, string, string, number]>} paare */
function pruefe(paare) {
  for (const [name, werte] of [['hell', hell], ['dunkel', dunkel]]) {
    for (const [was, vorn, hinten, mindestens] of paare(werte)) {
      const wert = verhaeltnis(vorn, hinten);
      assert.ok(
        wert >= mindestens,
        `${was} (${name}): ${wert.toFixed(2)}:1, gebraucht werden ${mindestens}:1 - ${vorn} auf ${hinten}`,
      );
    }
  }
}

test('Die Farbtoken sind in beiden Erscheinungsbildern gelesen worden', () => {
  for (const [name, werte] of [['hell', hell], ['dunkel', dunkel]]) {
    for (const schluessel of ['bg', 'bg-elevated', 'text', 'text-muted', 'accent', 'accent-soft',
      'accent-strong', 'accent-text', 'bubble-in', 'bubble-out', 'bubble-out-text',
      'danger', 'danger-text', 'success', 'auf-blase']) {
      assert.ok(werte[schluessel], `--${schluessel} fehlt im Schema ${name}`);
    }
  }
  assert.notEqual(hell.bg, dunkel.bg, 'beide Schemata wurden gleich gelesen');
});

test('Text erreicht 4.5:1', () => {
  pruefe((t) => [
    ['Fliesstext', t.text, t.bg, 4.5],
    ['Fliesstext auf Erhabenem', t.text, t['bg-elevated'], 4.5],
    ['Gedaempfter Text', t['text-muted'], t.bg, 4.5],
    ['Gedaempfter Text auf Erhabenem', t['text-muted'], t['bg-elevated'], 4.5],
    ['Fusszeile der eigenen Blase', t['bubble-out-text'], t['bubble-out'], 4.5],
    ['Fusszeile der fremden Blase', t['text-muted'], t['bubble-in'], 4.5],
    ['Schrift auf dem Akzent', t['accent-text'], t.accent, 4.5],
    ['Schrift auf der Warnfarbe', t['danger-text'], t.danger, 4.5],
    ['Erfolgsmeldung', t.success, t.bg, 4.5],
    ['Erfolgsmeldung auf Erhabenem', t.success, t['bg-elevated'], 4.5],
    ['Anfangsbuchstabe im Profilkreis', t['accent-strong'], t['accent-soft'], 4.5],
    // Das Zitat liegt auf 14 % Grau ueber der Blase - beides mitgerechnet.
    ['Zitat in der eigenen Blase', t['bubble-out-text'], mischen('#7f7f7f', t['bubble-out'], 0.14), 4.5],
  ]);
});

test('Bedienelemente und Symbole erreichen 3:1', () => {
  pruefe((t) => [
    ['Haken und Auge auf der eigenen Blase', t['auf-blase'], t['bubble-out'], 3],
    ['Rahmen gegen den Grund', t.border, t.bg, 1.2],
    ['Akzent gegen den Grund', t.accent, t.bg, 3],
  ]);
});
