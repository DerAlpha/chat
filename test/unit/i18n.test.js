import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const source = fs.readFileSync(path.join(root, 'public/js/i18n.js'), 'utf8');

function keysOf(language) {
  const block = source.split(`  ${language}: {`)[1]?.split('\n  },')[0];
  assert.ok(block, `Sprachblock "${language}" nicht gefunden`);
  return new Set([...block.matchAll(/^ {4}([A-Za-z0-9_]+):/gm)].map((match) => match[1]));
}

const german = keysOf('de');
const english = keysOf('en');

test('Beide Sprachen kennen dieselben Schluessel', () => {
  const missingEnglish = [...german].filter((key) => !english.has(key));
  const missingGerman = [...english].filter((key) => !german.has(key));
  assert.deepEqual(missingEnglish, [], 'fehlt auf Englisch');
  assert.deepEqual(missingGerman, [], 'fehlt auf Deutsch');
  assert.ok(german.size > 100, `unerwartet wenige Schluessel: ${german.size}`);
});

test('Jeder benutzte Schluessel ist auch uebersetzt', () => {
  const used = new Set();
  for (const file of ['public/js/app.js', 'public/js/ui.js']) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of code.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)) used.add(match[1]);
  }
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  for (const match of html.matchAll(/data-i18n="([A-Za-z0-9_]+)"/g)) used.add(match[1]);
  for (const match of html.matchAll(/data-i18n-attr="[^"]*?:([A-Za-z0-9_]+)/g)) used.add(match[1]);

  const missing = [...used].filter((key) => !german.has(key));
  assert.deepEqual(missing, [], 'Diese Schluessel werden benutzt, sind aber nicht uebersetzt');
});

test('Es gibt keine uebersetzten Schluessel, die niemand benutzt', () => {
  const used = new Set();
  for (const file of ['public/js/app.js', 'public/js/ui.js']) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of code.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)) used.add(match[1]);
  }
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  for (const match of html.matchAll(/data-i18n="([A-Za-z0-9_]+)"/g)) used.add(match[1]);
  for (const match of html.matchAll(/data-i18n-attr="[^"]*?:([A-Za-z0-9_]+)/g)) used.add(match[1]);

  const unused = [...german].filter((key) => !used.has(key));
  assert.deepEqual(unused, [], 'Diese Uebersetzungen sind verwaist');
});

test('Platzhalter stimmen zwischen den Sprachen ueberein', async () => {
  // Der Modulimport braucht Browser-Globals - deshalb hier nur die Textbausteine pruefen.
  const placeholders = (block, key) => {
    const line = block.match(new RegExp(`^ {4}${key}: '(.*)',$`, 'm'));
    return new Set([...(line?.[1] ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  };
  const deBlock = source.split('  de: {')[1].split('\n  },')[0];
  const enBlock = source.split('  en: {')[1].split('\n  },')[0];
  for (const key of german) {
    assert.deepEqual(
      [...placeholders(deBlock, key)].sort(),
      [...placeholders(enBlock, key)].sort(),
      `Platzhalter weichen ab bei "${key}"`,
    );
  }
});

test('Die Oberflaeche benutzt keine harten Zeichenketten in der HTML-Datei', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  // Sichtbarer Text in Buttons ohne data-i18n waere ein Uebersetzungsloch.
  const suspicious = [...html.matchAll(/<button[^>]*>\s*([A-Za-zÄÖÜäöü][^<]{3,})/g)]
    .map((match) => match[1].trim())
    .filter((text) => !text.startsWith('data-'));
  assert.deepEqual(suspicious, [], 'Diese Beschriftungen sind nicht uebersetzbar');
});
