/**
 * Der Webspace-Installer ist das einzige Stueck, das auf dem Zielserver
 * wirklich Dateien anfasst. Hier laeuft er gegen ein nachgebautes Home:
 * einmal installieren, dann aktualisieren - und dabei darf nichts Eigenes
 * verlorengehen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const installer = path.join(root, 'deploy/install-webspace.sh');

/** Nur public/ und php/ - der Rest des Projekts geht den Webspace nichts an. */
function makeSource() {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'fluesterchat-quelle-'));
  fs.cpSync(path.join(root, 'public'), path.join(source, 'public'), { recursive: true });
  fs.cpSync(path.join(root, 'php'), path.join(source, 'php'), { recursive: true });
  return source;
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fluesterchat-home-'));
  fs.mkdirSync(path.join(home, 'html'));
  return home;
}

/** Tut so, als wäre diese Datei beim letzten Mal mitgeliefert worden. */
function shippedLastTime(docroot, relative) {
  fs.mkdirSync(path.dirname(path.join(docroot, relative)), { recursive: true });
  fs.writeFileSync(path.join(docroot, relative), 'alte Fassung');
  fs.appendFileSync(path.join(docroot, '.fluesterchat'), `datei=${relative}\n`);
}

function install(home, source, extra = []) {
  return execFileSync('sh', [installer, '--source', source, ...extra], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

test('Der Installer legt die App ab und merkt sich den Weg dorthin', () => {
  const home = makeHome();
  const source = makeSource();
  const output = install(home, source, ['--url', 'https://beispiel.de']);

  const docroot = path.join(home, 'html');
  for (const file of ['index.html', '.htaccess', '.user.ini', 'api/index.php', 'js/app.js', 'img/icon.svg']) {
    assert.ok(fs.existsSync(path.join(docroot, file)), `${file} fehlt`);
  }
  // Der Datenordner liegt neben dem Docroot, nicht darin - sonst waere er abrufbar.
  assert.ok(fs.existsSync(path.join(home, 'fluesterchat-data')));
  assert.ok(!fs.existsSync(path.join(docroot, 'fluesterchat-data')));

  const conf = fs.readFileSync(path.join(home, '.fluesterchat-install.conf'), 'utf8');
  assert.match(conf, new RegExp(`^install\t${docroot}\t`, 'm'));
  assert.match(conf, /\thttps:\/\/beispiel\.de$/m);

  // Die Markierung hält fest, wohin installiert wurde und was dabei entstand.
  const marker = fs.readFileSync(path.join(docroot, '.fluesterchat'), 'utf8');
  assert.match(marker, new RegExp(`^docroot=${docroot}$`, 'm'));
  assert.match(marker, /^datei=js\/app\.js$/m);

  const updater = path.join(home, 'fluesterchat-update.sh');
  assert.ok(fs.existsSync(updater), 'fluesterchat-update.sh fehlt');
  assert.ok(fs.statSync(updater).mode & 0o100, 'fluesterchat-update.sh ist nicht ausfuehrbar');
  execFileSync('sh', ['-n', updater]);
  assert.match(output, /fluesterchat-update\.sh/);
});

test('Erneut ausführen aktualisiert am gemerkten Ort, ohne Eigenes zu zerstören', () => {
  const home = makeHome();
  const source = makeSource();
  // Bewusst ein Name, den die eingebaute Suche nicht kennt: nur so zeigt sich,
  // dass der zweite Lauf wirklich aus der Merkdatei liest und nicht raet.
  const docroot = path.join(home, 'webseite-42');
  fs.mkdirSync(docroot);
  const data = path.join(home, 'eigene-daten');
  install(home, source, ['--docroot', docroot, '--data', data, '--url', 'https://beispiel.de']);

  const ownConfig = path.join(docroot, 'api/lib/config.local.php');
  fs.writeFileSync(ownConfig, "<?php return ['dataDir' => '/mein/pfad'];\n");
  fs.mkdirSync(path.join(data, 'rooms'), { recursive: true });
  fs.writeFileSync(path.join(data, 'rooms/raum.json'), 'wichtig');
  // Ein Überbleibsel aus einer älteren Fassung: die Datei muss in der
  // Markierung stehen, sonst gilt sie als fremd - und Fremdes bleibt liegen.
  shippedLastTime(docroot, 'js/uralt.js');

  // Kein --docroot, kein --url: alles kommt aus der Merkdatei.
  const output = install(home, source);
  assert.match(output, /aus .*\.fluesterchat-install\.conf übernommen/);
  assert.match(output, /https:\/\/beispiel\.de/);

  assert.equal(fs.readFileSync(ownConfig, 'utf8'), "<?php return ['dataDir' => '/mein/pfad'];\n");
  assert.equal(fs.readFileSync(path.join(data, 'rooms/raum.json'), 'utf8'), 'wichtig');
  // Kein zweiter, leerer Datenordner am Vorgabeplatz.
  assert.ok(!fs.existsSync(path.join(home, 'fluesterchat-data')), 'ein zweiter Datenordner entstand');
  assert.ok(!fs.existsSync(path.join(docroot, 'js/uralt.js')), 'alte Datei blieb liegen');
  assert.ok(fs.existsSync(path.join(docroot, 'index.html')));
  // Und der naheliegende, aber falsche Ordner blieb unangetastet.
  assert.deepEqual(fs.readdirSync(path.join(home, 'html')), []);
});

test('Ohne Merkdatei findet der Installer die vorhandene Installation an ihrer Markierung', () => {
  const home = makeHome();
  const source = makeSource();
  // Ein Name, den weder die Suchliste kennt noch jemand erraten wuerde.
  const docroot = path.join(home, 'empty-install');
  fs.mkdirSync(docroot);
  install(home, source, ['--docroot', docroot]);

  // Wie bei einer Installation aus der Zeit vor der Merkdatei.
  shippedLastTime(docroot, 'js/uralt.js');
  fs.rmSync(path.join(home, '.fluesterchat-install.conf'));

  const output = install(home, source);
  assert.match(output, /vorhandene Installation gefunden/);
  assert.ok(!fs.existsSync(path.join(docroot, 'js/uralt.js')), 'die alte Fassung blieb liegen');
  // Und nicht etwa daneben ins naheliegende html/ installiert.
  assert.deepEqual(fs.readdirSync(path.join(home, 'html')), []);
  assert.ok(fs.existsSync(path.join(home, '.fluesterchat-install.conf')), 'Merkdatei nachgeholt');
});

test('Zwei Installationen nebeneinander werden nicht stillschweigend verwechselt', () => {
  const home = makeHome();
  const source = makeSource();
  const erste = path.join(home, 'seite-eins');
  const zweite = path.join(home, 'seite-zwei');
  fs.mkdirSync(erste);
  fs.mkdirSync(zweite);
  install(home, source, ['--docroot', erste]);
  install(home, source, ['--docroot', zweite]);
  fs.rmSync(path.join(home, '.fluesterchat-install.conf'));

  let failed = false;
  try {
    install(home, source);
  } catch (error) {
    failed = true;
    const text = String(error.stdout) + String(error.stderr);
    assert.match(text, /Es gibt mehrere Installationen/);
    assert.match(text, /seite-eins/);
    assert.match(text, /seite-zwei/);
  }
  assert.ok(failed, 'Der Installer hätte nachfragen müssen');
});

test('Ein Update löscht die Chats nicht, die im Docroot liegen', () => {
  // Wenn neben dem Docroot nicht geschrieben werden darf, legt die App ihre
  // Räume nach api/data - genau dorthin, wo der Installer früher pauschal
  // rm -rf api/ ausgeführt hat. Der Aktualisierer versprach im eigenen Kopf
  // das Gegenteil.
  const home = makeHome();
  const source = makeSource();
  const docroot = path.join(home, 'html');
  const daten = path.join(docroot, 'api/data');
  install(home, source, ['--data', daten]);

  fs.mkdirSync(path.join(daten, 'rooms/abc'), { recursive: true });
  fs.writeFileSync(path.join(daten, 'rooms/abc/messages.json'), '[{"ct":"..."}]');
  fs.writeFileSync(path.join(docroot, 'api/lib/config.local.php'), "<?php return ['dataDir' => '" + daten + "'];\n");

  install(home, source);
  assert.equal(
    fs.readFileSync(path.join(daten, 'rooms/abc/messages.json'), 'utf8'),
    '[{"ct":"..."}]',
    'die gespeicherten Nachrichten sind weg',
  );
});

test('Fremde Dateien in unseren Ordnern überleben ein Update', () => {
  const home = makeHome();
  const source = makeSource();
  const docroot = path.join(home, 'html');
  install(home, source);

  fs.writeFileSync(path.join(docroot, 'api/eigenes-skript.php'), '<?php echo "meins";');
  fs.writeFileSync(path.join(docroot, 'js/mein-zusatz.js'), 'console.log(1)');

  install(home, source);
  assert.ok(fs.existsSync(path.join(docroot, 'api/eigenes-skript.php')), 'eigenes PHP-Skript gelöscht');
  assert.ok(fs.existsSync(path.join(docroot, 'js/mein-zusatz.js')), 'eigene JS-Datei gelöscht');
});

test('Eine Sicherungskopie wird nicht für die Installation gehalten', () => {
  // Die Markierung wandert mit jeder Kopie mit. Ohne den Pfad darin hält der
  // Installer das Backup für die Installation, räumt es ab und aktualisiert
  // die echte Seite nie wieder.
  const home = makeHome();
  const source = makeSource();
  const echt = path.join(home, 'webseite-echt');
  fs.mkdirSync(echt);
  install(home, source, ['--docroot', echt]);

  const backup = path.join(home, 'sicherung');
  fs.cpSync(echt, backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'js/veraltet.js'), 'alt');
  fs.rmSync(path.join(home, '.fluesterchat-install.conf'));

  const output = install(home, source);
  assert.match(output, new RegExp(echt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(fs.existsSync(path.join(backup, 'js/veraltet.js')), 'die Sicherung wurde angetastet');
});

test('Ein Apostroph im Pfad legt spätere Läufe nicht lahm', () => {
  const home = makeHome();
  const source = makeSource();
  const docroot = path.join(home, "O'Briens Seite");
  fs.mkdirSync(docroot);
  install(home, source, ['--docroot', docroot, '--url', "https://o'brien.de"]);

  // Zweiter Lauf ohne Schalter: früher endete er hier wortlos mit Code 2,
  // weil die Merkdatei mit `.` eingelesen wurde.
  const output = install(home, source);
  assert.match(output, /Fertig/);
  assert.ok(fs.existsSync(path.join(docroot, 'index.html')));
});

test('Eine verfälschte Merkdatei kann den Fremdschutz nicht aushebeln', () => {
  const home = makeHome();
  const source = makeSource();
  const docroot = path.join(home, 'html');
  install(home, source);
  // Was ein Angreifer (oder ein abgebrochener Schreibvorgang) hineinschreiben
  // könnte, wenn die Datei als Shell-Code gelesen würde.
  fs.writeFileSync(
    path.join(home, '.fluesterchat-install.conf'),
    "FORCE=1\nMARKER='.egal'\nOLD_DOCROOT='/tmp/woanders'\n",
  );
  const fremd = path.join(home, 'fremde-seite');
  fs.mkdirSync(fremd);
  fs.writeFileSync(path.join(fremd, 'wichtig.php'), '<?php echo "fremd";');

  let failed = false;
  try {
    install(home, source, ['--docroot', fremd]);
  } catch (error) {
    failed = true;
    assert.match(String(error.stdout) + String(error.stderr), /Zur Sicherheit abgebrochen/);
  }
  assert.ok(failed, 'FORCE aus der Merkdatei hat gegriffen');
  assert.ok(fs.existsSync(path.join(fremd, 'wichtig.php')));
  assert.ok(fs.existsSync(path.join(docroot, 'index.html')));
});

test('Eine per FTP geleerte und neu belegte Seite wird nicht überbaut', () => {
  // .fluesterchat ist eine Punktdatei - FTP-Programme blenden sie aus, beim
  // Leerräumen bleibt sie liegen. Wenn sie allein als "das ist unseres" gilt,
  // löscht ein späterer Lauf css/, js/, img/ und api/ der fremden Seite.
  const home = makeHome();
  const source = makeSource();
  const docroot = path.join(home, 'html');
  install(home, source);

  for (const entry of fs.readdirSync(docroot)) {
    if (entry.startsWith('.')) continue;
    fs.rmSync(path.join(docroot, entry), { recursive: true, force: true });
  }
  assert.ok(fs.existsSync(path.join(docroot, '.fluesterchat')), 'die Markierung sollte übrig bleiben');
  fs.mkdirSync(path.join(docroot, 'img'), { recursive: true });
  fs.writeFileSync(path.join(docroot, 'img/logo.png'), 'fremdes Logo');
  fs.writeFileSync(path.join(docroot, 'index.php'), '<?php echo "andere Seite";');

  let failed = false;
  try {
    install(home, source, ['--docroot', docroot]);
  } catch (error) {
    failed = true;
    assert.match(String(error.stdout) + String(error.stderr), /Zur Sicherheit abgebrochen/);
  }
  assert.ok(failed, 'Der Installer hätte abbrechen müssen');
  assert.equal(fs.readFileSync(path.join(docroot, 'img/logo.png'), 'utf8'), 'fremdes Logo');
  assert.ok(fs.existsSync(path.join(docroot, 'index.php')));
});

test('Eine zweite Installation bekommt einen eigenen Datenordner', () => {
  // Sonst sieht eine Testinstanz die echten Chats - und löscht beim
  // Aufräumen darin mit.
  const home = makeHome();
  const source = makeSource();
  install(home, source);
  const probe = path.join(home, 'probe');
  fs.mkdirSync(probe);
  install(home, source, ['--docroot', probe]);

  const conf = fs.readFileSync(path.join(home, '.fluesterchat-install.conf'), 'utf8');
  const daten = conf.split('\n').filter((l) => l.startsWith('install\t')).map((l) => l.split('\t')[2]);
  assert.equal(daten.length, 2);
  assert.notEqual(daten[0], daten[1], 'beide Installationen teilen sich den Datenordner');
});

test('Die Hilfe gibt keinen Programmtext aus', () => {
  const output = execFileSync('sh', [installer, '--help'], { encoding: 'utf8' });
  assert.match(output, /Flüsterchat auf klassischen Webspace/);
  assert.doesNotMatch(output, /set -eu/);
  assert.doesNotMatch(output, /BRANCH=/);
  assert.doesNotMatch(output, /codeload\.github\.com/);
});

test('Der Aktualisierer bricht sauber ab, wenn nichts installiert ist', () => {
  const home = makeHome();
  const source = makeSource();
  install(home, source);
  const updater = path.join(home, 'fluesterchat-update.sh');
  fs.rmSync(path.join(home, '.fluesterchat-install.conf'));

  const result = execFileSync('sh', ['-c', `sh "${updater}" 2>&1; echo "rc=$?"`], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  assert.match(result, /Keine Installation gefunden/);
  assert.match(result, /rc=1/);
});

test('Ein fremd belegtes Verzeichnis wird nicht überschrieben', () => {
  const home = makeHome();
  const source = makeSource();
  fs.writeFileSync(path.join(home, 'html/wichtige-seite.php'), '<?php echo "fremd";');

  let failed = false;
  try {
    install(home, source);
  } catch (error) {
    failed = true;
    assert.match(String(error.stderr) + String(error.stdout), /Zur Sicherheit abgebrochen/);
  }
  assert.ok(failed, 'Der Installer hätte abbrechen müssen');
  assert.ok(fs.existsSync(path.join(home, 'html/wichtige-seite.php')));
  assert.ok(!fs.existsSync(path.join(home, 'html/index.html')));
});
