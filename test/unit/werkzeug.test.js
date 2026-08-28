/**
 * Die Werkzeuge um die App herum.
 *
 * Sie laufen nicht im Browser und stehen in keinem E2E-Test - genau deshalb
 * faellt hier nichts von selbst auf. `npm run php:dev` schrieb seine
 * Konfiguration als JSON mit getauschten Anfuehrungszeichen: `{ 'a': 1 }` ist
 * ein gueltiges JavaScript-Objekt, aber kein gueltiges PHP. Der Server
 * antwortete danach auf jede Anfrage mit einem Parse-Fehler, und der Befehl
 * steht so in der README.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { phpConfig } from '../../scripts/php-dev.mjs';

test('Die oertliche PHP-Konfiguration ist gueltiges PHP', () => {
  const text = phpConfig({ dataDir: '/tmp/daten', pollWaitSeconds: 20, debug: false });

  // Ein PHP-Feld, kein JavaScript-Objekt.
  assert.match(text, /^<\?php\nreturn \[\n/);
  assert.match(text, /\];\n$/);
  assert.ok(!text.includes('{'), 'geschweifte Klammern sind hier kein PHP');
  assert.match(text, /'dataDir' => '\/tmp\/daten',/);
  // Zahlen und Wahrheitswerte bleiben unangefuehrt - sonst kaeme aus 20 "20".
  assert.match(text, /'pollWaitSeconds' => 20,/);
  assert.match(text, /'debug' => false,/);
});

test('Anfuehrungszeichen und Schraegstriche im Pfad bleiben heil', () => {
  const text = phpConfig({ dataDir: "/tmp/o'brien\\daten" });
  assert.match(text, /'dataDir' => '\/tmp\/o\\'brien\\\\daten',/);
});

/**
 * Und der eigentliche Beweis, wo PHP zur Hand ist: der Parser selbst.
 * Wo es fehlt, bleibt es bei der Formpruefung oben - ein fehlendes PHP soll
 * die Suite nicht rot machen.
 */
test('PHP liest die Datei auch wirklich ein', (ctx) => {
  let php;
  try {
    php = execFileSync('php', ['-v'], { encoding: 'utf8' });
  } catch {
    return ctx.skip('kein PHP vorhanden');
  }
  assert.ok(php);

  const datei = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cfg-')), 'config.local.php');
  fs.writeFileSync(datei, phpConfig({ dataDir: "/tmp/o'brien", pollWaitSeconds: 20, debug: false }));
  const heraus = execFileSync('php', ['-r', `var_export(require ${JSON.stringify(datei)});`], { encoding: 'utf8' });
  assert.match(heraus, /'dataDir' => '\/tmp\/o\\'brien'/);
  assert.match(heraus, /'pollWaitSeconds' => 20/);
  assert.match(heraus, /'debug' => false/);
  fs.rmSync(path.dirname(datei), { recursive: true, force: true });
});
