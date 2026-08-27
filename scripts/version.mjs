/**
 * Die Fassung der App - aus dem Inhalt gerechnet, nicht von Hand gezählt.
 *
 * Warum überhaupt: Der Service Worker hält die App-Hülle in seinem eigenen
 * Speicher. Er räumt sie nur auf, wenn sich seine Fassung ändert. Stand die
 * als Zahl im Quelltext, musste man daran denken - und wer einmal nicht
 * daran denkt, hinterlässt Nutzer, die auf ewig eine alte Fassung sehen und
 * sich fragen, wo die neuen Funktionen bleiben.
 *
 * Deshalb ist die Fassung hier ein Fingerabdruck über alles, was ausgeliefert
 * wird. Ändert sich eine einzige Datei, ändert sich die Fassung. Vergessen
 * kann man das nicht mehr - ein Test rechnet nach und wird rot, wenn der
 * Stempel nicht mehr zum Inhalt passt.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const WURZEL = path.resolve(import.meta.dirname, '..');
export const PUBLIC_DIR = path.join(WURZEL, 'public');
export const VERSION_DATEI = path.join(PUBLIC_DIR, 'js', 'version.js');
export const SW_DATEI = path.join(PUBLIC_DIR, 'sw.js');

/** Die Zeile, in der die Fassung steht - in beiden Dateien dieselbe Form. */
const STEMPEL = /^(\s*(?:export )?const (?:APP_VERSION|VERSION) = ')([^']*)(';\s*)$/m;

/**
 * Diese beiden Dateien tragen den Stempel selbst. Ihr Stempelwert darf nicht
 * in die Rechnung eingehen - sonst änderte jedes Stempeln die Fassung, die
 * gerade gestempelt wurde, und man käme nie zur Ruhe.
 */
const GESTEMPELT = new Set([VERSION_DATEI, SW_DATEI]);

/** Alle ausgelieferten Dateien, in fester Reihenfolge. */
export function shippedFiles(dir = PUBLIC_DIR) {
  const gefunden = [];
  for (const eintrag of fs.readdirSync(dir, { withFileTypes: true })) {
    const voll = path.join(dir, eintrag.name);
    if (eintrag.isDirectory()) gefunden.push(...shippedFiles(voll));
    else if (eintrag.isFile()) gefunden.push(voll);
  }
  return gefunden.sort();
}

/** Inhalt einer Datei, den Stempel selbst herausgerechnet. */
function inhaltOhneStempel(datei) {
  const roh = fs.readFileSync(datei);
  if (!GESTEMPELT.has(datei)) return roh;
  return Buffer.from(roh.toString('utf8').replace(STEMPEL, '$1$3'), 'utf8');
}

/**
 * Rechnet die Fassung aus dem Inhalt aller ausgelieferten Dateien.
 * Der Pfad geht mit ein: eine umbenannte Datei ist eine Änderung.
 */
export function computeVersion() {
  const hash = crypto.createHash('sha256');
  for (const datei of shippedFiles()) {
    hash.update(path.relative(PUBLIC_DIR, datei).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(inhaltOhneStempel(datei));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

/** Liest den Stempel aus einer der beiden Dateien. */
export function readStamp(datei) {
  const treffer = STEMPEL.exec(fs.readFileSync(datei, 'utf8'));
  return treffer ? treffer[2] : null;
}

/** Schreibt die Fassung in beide Dateien. Gibt zurück, was sich geändert hat. */
export function stampVersion(version = computeVersion()) {
  const geaendert = [];
  for (const datei of [VERSION_DATEI, SW_DATEI]) {
    const alt = fs.readFileSync(datei, 'utf8');
    const neu = alt.replace(STEMPEL, `$1${version}$3`);
    if (neu === alt) continue;
    fs.writeFileSync(datei, neu);
    geaendert.push(path.relative(WURZEL, datei));
  }
  return { version, geaendert };
}

// Als Befehl aufgerufen: stempeln und sagen, was passiert ist.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const { version, geaendert } = stampVersion();
  if (geaendert.length === 0) console.log(`Fassung ${version} steht schon - nichts zu tun.`);
  else console.log(`Fassung ${version} gestempelt in: ${geaendert.join(', ')}`);
}
