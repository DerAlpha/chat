/**
 * Baut das fertige Verzeichnis zum Hochladen auf klassischen Webspace
 * (lima-city & Co.) - Client plus PHP-Backend, sonst nichts.
 *
 *   node scripts/build-webspace.mjs [--out dist/webspace]
 *
 * Der Inhalt kommt anschliessend per FTP in das Document Root der Domain.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outIndex = process.argv.indexOf('--out');
const out = path.resolve(root, outIndex === -1 ? 'dist/webspace' : process.argv[outIndex + 1]);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1) Der Client - unverändert derselbe wie beim Node-Betrieb.
fs.cpSync(path.join(root, 'public'), out, { recursive: true });

// 2) Das PHP-Backend.
fs.cpSync(path.join(root, 'php', 'api'), path.join(out, 'api'), { recursive: true });

// 3) Regeln und PHP-Einstellungen fürs Wurzelverzeichnis.
for (const file of ['.htaccess', '.user.ini']) {
  fs.copyFileSync(path.join(root, 'php', 'site', file), path.join(out, file));
}

// 4) Das Installationsskript liegt bei, damit im Paket alles Nötige steckt.
//    Beim Installieren wird es nicht mit ausgeliefert.
fs.copyFileSync(
  path.join(root, 'deploy', 'install-webspace.sh'),
  path.join(out, 'install-webspace.sh'),
);

// Nichts aus der Entwicklung mitschleppen.
for (const stray of ['api/lib/config.local.php', 'api/data']) {
  fs.rmSync(path.join(out, stray), { recursive: true, force: true });
}

function walk(dir) {
  const entries = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) entries.push(...walk(full));
    else entries.push(full);
  }
  return entries;
}

const files = walk(out);
const bytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);

console.log(`Fertig: ${path.relative(root, out)}`);
console.log(`${files.length} Dateien, ${(bytes / 1024).toFixed(0)} KB`);
console.log('');
console.log('Inhalt (oberste Ebene):');
for (const item of fs.readdirSync(out).sort()) {
  const full = path.join(out, item);
  console.log(`  ${fs.statSync(full).isDirectory() ? item + '/' : item}`);
}
console.log('');
console.log('Diesen Ordnerinhalt per FTP ins Document Root der Domain laden.');
console.log('Danach https://<domain>/api/setup-check.php aufrufen.');
