/**
 * Ein PHP-Backend fuer die Dauer eines Tests.
 *
 * Fluesterchat hat zwei Server fuer denselben Browser: Node mit WebSocket und
 * PHP mit Abholen per HTTP. Was der eine tut, muss der andere auch tun -
 * deshalb faehrt mehr als ein Test denselben Ablauf gegen beide. Das Starten
 * stand vorher in jeder dieser Dateien noch einmal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';

const WURZEL = path.resolve(import.meta.dirname, '..');

/** Ohne PHP auf dem Rechner werden die Vergleichstests uebersprungen. */
export const phpVorhanden = (() => {
  try {
    execFileSync('php', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Ein Port, auf dem gerade nichts lauscht.
 *
 * Fest vergebene Nummern gingen schief, sobald mehrere Testdateien
 * gleichzeitig liefen - und `node --test` laesst sie gleichzeitig laufen.
 * Das Betriebssystem weiss besser, was frei ist.
 */
function freierPort() {
  return new Promise((fertig, schiefgegangen) => {
    const horcher = net.createServer();
    horcher.once('error', schiefgegangen);
    horcher.listen(0, '127.0.0.1', () => {
      const { port } = horcher.address();
      horcher.close(() => fertig(port));
    });
  });
}

/**
 * Startet `php -S` auf einem eigenen Port, ruft `fn` und raeumt danach auf.
 *
 * @param {{ config?: Record<string, string|number|boolean>, mitPublic?: boolean }} optionen
 * @param {(umgebung: {base: string, dataDir: string, docRoot: string}) => Promise<any>} fn
 */
export async function withPhp(optionen, fn) {
  const { config = {}, mitPublic = false } = optionen;
  const docRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fluesterchat-php-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluesterchat-daten-'));
  if (mitPublic) fs.cpSync(path.join(WURZEL, 'public'), docRoot, { recursive: true });
  fs.cpSync(path.join(WURZEL, 'php/api'), path.join(docRoot, 'api'), { recursive: true });

  const werte = { dataDir, ...config };
  const zeilen = Object.entries(werte).map(([name, wert]) => {
    const roh = typeof wert === 'string'
      ? `'${wert.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
      : String(wert);
    return `  '${name}' => ${roh},`;
  });
  fs.writeFileSync(
    path.join(docRoot, 'api', 'lib', 'config.local.php'),
    `<?php\nreturn [\n${zeilen.join('\n')}\n];\n`,
  );

  // Jeder Lauf einen eigenen Port: mehrere Testdateien laufen gleichzeitig.
  const port = await freierPort();
  const kind = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', docRoot, path.join(WURZEL, 'php/router.php')], {
    stdio: 'ignore',
    env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let versuch = 0; versuch < 100; versuch += 1) {
      try {
        if ((await fetch(`${base}/api/healthz`)).ok) break;
      } catch { /* noch nicht da */ }
      await new Promise((weiter) => setTimeout(weiter, 100));
    }
    return await fn({ base, dataDir, docRoot });
  } finally {
    kind.kill('SIGKILL');
    fs.rmSync(docRoot, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
