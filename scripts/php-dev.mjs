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

export function writeLocalConfig(target, overrides) {
  const body = `<?php\nreturn ${JSON.stringify(overrides, null, 4).replace(/"/g, "'")};\n`;
  fs.writeFileSync(path.join(target, 'api', 'lib', 'config.local.php'), body);
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
