/**
 * Startet das PHP-Backend zusammen mit dem Client - zum Entwickeln und für
 * die Tests. Baut dazu einen Docroot zusammen, wie er später auf dem
 * Webspace liegt: Client im Wurzelverzeichnis, API darunter.
 *
 *   node scripts/php-dev.mjs [--port 8080] [--data <ordner>] [--docroot <ordner>]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const port = Number(arg('port', process.env.PHP_PORT ?? 8080));
const docRoot = arg('docroot', path.join(os.tmpdir(), `fluesterchat-php-${process.pid}`));
const dataDir = arg('data', path.join(docRoot, '..', `fluesterchat-data-${process.pid}`));

/** Docroot frisch zusammenlegen, damit nichts von einem alten Lauf stehen bleibt. */
export function buildDocRoot(target = docRoot) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.join(root, 'public'), target, { recursive: true });
  fs.cpSync(path.join(root, 'php', 'api'), path.join(target, 'api'), { recursive: true });
  return target;
}

/**
 * Schreibt die oertliche Konfiguration als PHP.
 *
 * Nicht als JSON mit getauschten Anfuehrungszeichen: `{ 'a': 1 }` ist ein
 * gueltiges JavaScript-Objekt, aber kein gueltiges PHP - dort braucht es
 * eckige Klammern und `=>`. Die Datei liess sich deshalb nicht einlesen, und
 * `npm run php:dev` antwortete auf jede Anfrage mit einem Parse-Fehler.
 */
export function writeLocalConfig(target, overrides) {
  fs.writeFileSync(path.join(target, 'api', 'lib', 'config.local.php'), phpConfig(overrides));
}

/** @param {Record<string, string|number|boolean>} overrides */
export function phpConfig(overrides) {
  const zeilen = Object.entries(overrides).map(([name, wert]) => `    ${phpWert(name)} => ${phpWert(wert)},`);
  return `<?php\nreturn [\n${zeilen.join('\n')}\n];\n`;
}

function phpWert(wert) {
  if (typeof wert === 'number' && Number.isFinite(wert)) return String(wert);
  if (typeof wert === 'boolean') return wert ? 'true' : 'false';
  // Einfache Anfuehrungszeichen kennen in PHP genau zwei Fluchtzeichen:
  // den Backslash und das Anfuehrungszeichen selbst.
  return `'${String(wert).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildDocRoot();
  fs.mkdirSync(dataDir, { recursive: true });
  writeLocalConfig(docRoot, { dataDir, pollWaitSeconds: 20 });

  console.log(`Docroot: ${docRoot}`);
  console.log(`Daten:   ${dataDir}`);
  console.log(`http://127.0.0.1:${port}/`);

  // Ohne mehrere Arbeitsprozesse blockiert eine wartende Abfrage den ganzen
  // Server - der eingebaute Server nimmt sonst nur eine Anfrage gleichzeitig.
  const php = spawn(
    'php',
    ['-S', `127.0.0.1:${port}`, '-t', docRoot, path.join(root, 'php', 'router.php')],
    { env: { ...process.env, PHP_CLI_SERVER_WORKERS: '16' }, stdio: 'inherit' },
  );
  const stop = () => {
    php.kill('SIGTERM');
    fs.rmSync(docRoot, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
