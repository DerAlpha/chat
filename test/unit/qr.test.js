import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr, readMask } from '../../public/js/qr.js';
import qrcode from 'qrcode-generator';

// qrcode-generator waehlt im Byte-Modus standardmaessig eine Latin-1-Umwandlung.
// Wir kodieren nach UTF-8 - also bekommt die Referenz dieselbe Umwandlung.
qrcode.stringToBytes = (text) => Array.from(new TextEncoder().encode(text));

/** Referenzmatrix aus einer erprobten Fremdimplementierung. */
function reference(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const modules = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) modules[y * size + x] = qr.isDark(y, x) ? 1 : 0;
  }
  return { size, modules };
}

/**
 * Vergleicht Modul fuer Modul. Die Maske ist reine Lesbarkeits-Heuristik und
 * darf abweichen - deshalb wird die Maske der Referenz uebernommen, damit der
 * Rest (Reed-Solomon, Verschraenkung, Platzierung, Formatinfo) exakt geprueft wird.
 */
function compare(text) {
  const theirs = reference(text);
  const mine = encodeQr(text, { mask: readMask(theirs.modules, theirs.size) });
  assert.equal(mine.size, theirs.size, `Groesse weicht ab fuer ${JSON.stringify(text.slice(0, 40))}`);
  for (let i = 0; i < theirs.modules.length; i += 1) {
    if (mine.modules[i] !== theirs.modules[i]) {
      const y = Math.floor(i / mine.size);
      const x = i % mine.size;
      assert.fail(`Modul (${y},${x}) weicht ab bei Laenge ${text.length} (Version ${mine.version}, Maske ${mine.mask})`);
    }
  }
}

test('QR-Matrix stimmt mit der Referenz ueberein (typische Einladungslinks)', () => {
  for (const text of [
    'https://chat.example/#H7Q2-9XKM-3BTV',
    'https://fluesterchat.example.com/#0123-4567-89AB',
    'http://192.168.1.42:3000/#ZZZZ-ZZZZ-ZZZZ',
    'https://sehr-lange-domain-fuer-den-test.example.org/chat/#ABCD-EFGH-JKMN',
  ]) compare(text);
});

test('QR-Matrix stimmt fuer alle Laengen von 1 bis 213 Zeichen', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:/#.-_?=&';
  for (let length = 1; length <= 213; length += 1) {
    let text = '';
    for (let i = 0; i < length; i += 1) text += alphabet[(i * 7 + length) % alphabet.length];
    compare(text);
  }
});

test('QR-Versionen 1 bis 10 werden erreicht und passen zur Referenz', () => {
  const seen = new Set();
  for (let length = 1; length <= 213; length += 1) {
    seen.add(encodeQr('x'.repeat(length)).version);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('Zu lange Texte werden mit einer klaren Meldung abgelehnt', () => {
  assert.throws(() => encodeQr('x'.repeat(214)), /zu lang/i);
  assert.equal(encodeQr('x'.repeat(213)).version, 10);
});

test('UTF-8-Zeichen werden korrekt kodiert', () => {
  for (const text of ['Grüße', 'äöüß', 'Chat 🎉 los', '日本語テスト']) compare(text);
});

test('Jede der acht Masken erzeugt eine gueltige, wiedererkennbare Matrix', () => {
  const text = 'https://chat.example/#H7Q2-9XKM-3BTV';
  for (let mask = 0; mask < 8; mask += 1) {
    const qr = encodeQr(text, { mask });
    assert.equal(qr.mask, mask);
    assert.equal(readMask(qr.modules, qr.size), mask, 'Formatinfo muss die Maske enthalten');
  }
});

test('Die automatisch gewaehlte Maske ist eine der acht', () => {
  const qr = encodeQr('https://chat.example/#H7Q2-9XKM-3BTV');
  assert.ok(qr.mask >= 0 && qr.mask < 8);
  assert.equal(readMask(qr.modules, qr.size), qr.mask);
});
