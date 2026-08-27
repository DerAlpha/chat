/**
 * Der Stempel muss zum Inhalt passen.
 *
 * Das ist kein Formtest, sondern der Kern der Sache: Der Service Worker
 * raeumt seinen Speicher nur, wenn sich seine Fassung aendert. Stand die als
 * handgepflegte Zahl im Quelltext, reichte ein einziges Vergessen - und die
 * Nutzer sahen auf ewig eine alte App und fragten sich, wo die neuen
 * Funktionen bleiben. Genau das ist passiert.
 *
 * Deshalb wird die Fassung aus dem Inhalt gerechnet, und dieser Test wird
 * rot, sobald sich irgendetwas an der Auslieferung geaendert hat, ohne dass
 * neu gestempelt wurde. Der Weg zurueck ist ein Befehl: npm run stamp
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  PUBLIC_DIR, SW_DATEI, VERSION_DATEI, computeVersion, readStamp, shippedFiles,
} from '../../scripts/version.mjs';
import { appVersion, forgetVersion } from '../../server/version.js';

const phpVorhanden = (() => {
  try {
    execFileSync('php', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('Der Stempel passt zum Inhalt - sonst: npm run stamp', () => {
  const gerechnet = computeVersion();
  assert.equal(
    readStamp(VERSION_DATEI),
    gerechnet,
    'public/js/version.js ist nicht mehr aktuell. Bitte "npm run stamp" laufen lassen.',
  );
});

test('Service Worker und App tragen dieselbe Fassung', () => {
  // Laufen die auseinander, glaubt die App an eine Aktualisierung, die der
  // Worker gar nicht hat - oder umgekehrt.
  assert.equal(readStamp(SW_DATEI), readStamp(VERSION_DATEI));
});

test('Eine geaenderte Datei aendert die Fassung', () => {
  const vorher = computeVersion();
  const opfer = path.join(PUBLIC_DIR, 'js', 'app.js');
  const original = fs.readFileSync(opfer);
  try {
    fs.writeFileSync(opfer, Buffer.concat([original, Buffer.from('\n// nur ein Test\n')]));
    assert.notEqual(computeVersion(), vorher, 'eine Aenderung blieb ohne Wirkung auf die Fassung');
  } finally {
    fs.writeFileSync(opfer, original);
  }
  assert.equal(computeVersion(), vorher, 'nach dem Zuruecknehmen muss dieselbe Fassung herauskommen');
});

test('Eine neue Datei aendert die Fassung', () => {
  const vorher = computeVersion();
  const neue = path.join(PUBLIC_DIR, 'js', 'zz-test-datei.js');
  try {
    fs.writeFileSync(neue, '// nur ein Test\n');
    assert.notEqual(computeVersion(), vorher);
  } finally {
    fs.rmSync(neue, { force: true });
  }
  assert.equal(computeVersion(), vorher);
});

test('Das Stempeln selbst aendert die Fassung nicht', () => {
  // Sonst jagte man sich im Kreis: stempeln, dadurch neue Fassung, wieder
  // stempeln. Die beiden gestempelten Dateien zaehlen deshalb ohne ihren
  // eigenen Stempelwert.
  const einmal = computeVersion();
  const zweimal = computeVersion();
  assert.equal(einmal, zweimal);
  assert.match(einmal, /^[0-9a-f]{12}$/);
});

test('Alle ausgelieferten Dateien gehen in die Rechnung ein', () => {
  const dateien = shippedFiles().map((datei) => path.relative(PUBLIC_DIR, datei).split(path.sep).join('/'));
  // Ein paar, die auf jeden Fall dabei sein muessen.
  for (const pflicht of ['index.html', 'sw.js', 'js/app.js', 'js/version.js', 'css/app.css', 'manifest.webmanifest']) {
    assert.ok(dateien.includes(pflicht), `${pflicht} fehlt in der Rechnung`);
  }
});

/**
 * Die Liste der Dateien im Service Worker wird von Hand gepflegt. Fehlt dort
 * ein Modul, scheitert offline der Import - und die App startet mit einem
 * weissen Bildschirm, ohne dass irgendwo eine Meldung erschiene. Deshalb
 * zaehlt dieser Test nach.
 */
test('Jedes ausgelieferte Modul steht in der Liste des Service Workers', () => {
  const sw = fs.readFileSync(SW_DATEI, 'utf8');
  const huelle = sw.slice(sw.indexOf('const SHELL = ['), sw.indexOf('].map('));
  const module = shippedFiles(path.join(PUBLIC_DIR, 'js'))
    .map((datei) => 'js/' + path.basename(datei));
  const fehlend = module.filter((eintrag) => !huelle.includes(`'${eintrag}'`));
  assert.deepEqual(fehlend, [], 'diese Module fehlen in SHELL in public/sw.js');
});

test('Auch Stilvorlage, Startseite und Manifest stehen in der Liste', () => {
  const sw = fs.readFileSync(SW_DATEI, 'utf8');
  const huelle = sw.slice(sw.indexOf('const SHELL = ['), sw.indexOf('].map('));
  for (const pflicht of ['index.html', 'css/app.css', 'manifest.webmanifest']) {
    assert.ok(huelle.includes(`'${pflicht}'`), `${pflicht} fehlt in SHELL`);
  }
});

test('Der Node-Server meldet genau die ausgelieferte Fassung', () => {
  forgetVersion();
  assert.equal(appVersion(PUBLIC_DIR), readStamp(VERSION_DATEI));
  forgetVersion();
});

test('Ohne lesbare Datei meldet der Node-Server gar keine Fassung', () => {
  // Lieber nichts sagen als etwas Erfundenes: eine falsche Fassung wuerde
  // jeden Nutzer aussperren.
  forgetVersion();
  assert.equal(appVersion('/gibt/es/nicht'), '');
  forgetVersion();
});

test('Node und PHP lesen dieselbe Fassung', { skip: phpVorhanden ? false : 'PHP nicht vorhanden' }, () => {
  // Das PHP-Backend liest js/version.js relativ zu seinem eigenen Ordner.
  // Hier wird genau diese Rechnung nachgestellt.
  const ausgabe = execFileSync('php', ['-r', `
    $roh = file_get_contents(${JSON.stringify(path.join(PUBLIC_DIR, 'js', 'version.js'))});
    echo preg_match("/const APP_VERSION = '([^']*)'/", $roh, $m) === 1 ? $m[1] : '';
  `], { encoding: 'utf8' });
  forgetVersion();
  assert.equal(ausgabe.trim(), appVersion(PUBLIC_DIR));
  forgetVersion();
});
