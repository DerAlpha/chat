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
  assert.match(conf, new RegExp(`OLD_DOCROOT='${docroot}'`));
  assert.match(conf, /OLD_SITE_URL='https:\/\/beispiel\.de'/);

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
  // Ein Ueberbleibsel aus einer aelteren Fassung.
  fs.writeFileSync(path.join(docroot, 'js/uralt.js'), 'alt');

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
  fs.rmSync(path.join(home, '.fluesterchat-install.conf'));
  fs.writeFileSync(path.join(docroot, 'js/uralt.js'), 'alt');

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
