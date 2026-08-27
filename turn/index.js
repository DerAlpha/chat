#!/usr/bin/env node
/**
 * Startet den Relaisdienst.
 *
 *   TURN_SECRET=... TURN_PUBLIC_ADDRESS=203.0.113.5 node turn/index.js
 *
 * Dasselbe Geheimnis muss im Webbackend stehen (TURN_SECRET beim Node-Server,
 * 'turnSecret' in api/lib/config.local.php beim PHP-Backend). Aus ihm rechnen
 * beide Seiten dieselben kurzlebigen Zugangsdaten aus, ohne je miteinander zu
 * reden - deshalb kann der Dienst auf einer ganz anderen Maschine stehen als
 * die Webseite.
 *
 * Der Dienst braucht:
 *   - einen freien UDP-Port (Vorgabe 3478) für die Aushandlung
 *   - einen UDP-Portbereich für die Relais selbst (Vorgabe 49152-65535)
 *   - eine von aussen erreichbare Adresse
 *
 * Auf klassischem PHP-Webspace läuft er nicht - der erlaubt keine dauerhaften
 * Prozesse und keine eigenen Ports. Dort läuft nur die Aushandlung über die
 * Webseite, und Anrufe gehen den direkten Weg zwischen den Geräten.
 */
import { createTurnServer, DEFAULTS } from './server.js';
import { makeCredentials } from './credentials.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function readConfig(env = process.env) {
  const number = (name, fallback) => {
    const raw = env[name];
    if (raw == null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${name} ist keine Zahl: ${raw}`);
    return value;
  };
  return {
    secret: env.TURN_SECRET ?? '',
    listenPort: number('TURN_PORT', DEFAULTS.listenPort),
    listenAddress: env.TURN_HOST ?? DEFAULTS.listenAddress,
    publicAddress: env.TURN_PUBLIC_ADDRESS ?? null,
    realm: env.TURN_REALM ?? DEFAULTS.realm,
    minPort: number('TURN_MIN_PORT', DEFAULTS.minPort),
    maxPort: number('TURN_MAX_PORT', DEFAULTS.maxPort),
    maxAllocations: number('TURN_MAX_ALLOCATIONS', DEFAULTS.maxAllocations),
    maxAllocationsPerAddress: number('TURN_MAX_PER_ADDRESS', DEFAULTS.maxAllocationsPerAddress),
    allocationLifetime: number('TURN_LIFETIME', DEFAULTS.allocationLifetime),
    logLevel: env.TURN_LOG_LEVEL ?? 'info',
  };
}

function main() {
  const config = readConfig();

  if (!config.secret) {
    process.stderr.write([
      'FEHLER: TURN_SECRET fehlt.',
      '',
      'Der Dienst und das Webbackend teilen sich ein Geheimnis, aus dem beide',
      'dieselben kurzlebigen Zugangsdaten ausrechnen. Ein neues erzeugen:',
      '',
      '    node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      '',
      'Dann hier als TURN_SECRET setzen und im Webbackend hinterlegen.',
      '',
    ].join('\n'));
    process.exit(2);
  }
  if (!config.publicAddress) {
    process.stderr.write(
      'Hinweis: TURN_PUBLIC_ADDRESS ist nicht gesetzt. Hinter NAT nennt der\n'
      + 'Dienst dann eine Adresse, die von aussen niemand erreicht.\n\n',
    );
  }
  if (config.minPort >= config.maxPort) {
    process.stderr.write('FEHLER: TURN_MIN_PORT muss kleiner als TURN_MAX_PORT sein.\n');
    process.exit(2);
  }

  const threshold = LEVELS[config.logLevel] ?? LEVELS.info;
  const log = (level, message) => {
    if ((LEVELS[level] ?? 0) < threshold) return;
    process.stdout.write(`${new Date().toISOString()} ${level.padEnd(5)} ${message}\n`);
  };

  const server = createTurnServer({ ...config, log });
  server.listen().then((address) => {
    log('info', `Relaisdienst hört auf ${address.address}:${address.port}`);
    log('info', `Relais-Ports ${config.minPort}-${config.maxPort}, Bereich "${config.realm}"`);
    if (config.publicAddress) log('info', `Nach aussen gemeldet als ${config.publicAddress}`);
    // Ein Beispiel, damit man beim Einrichten sofort etwas zum Prüfen hat.
    const probe = makeCredentials(config.secret, { ttlSeconds: 600, label: 'probe' });
    log('debug', `Beispiel-Zugangsdaten: ${probe.username} / ${probe.password}`);
  }).catch((err) => {
    process.stderr.write(`FEHLER beim Start: ${err.message}\n`);
    process.exit(1);
  });

  const stop = (signal) => {
    log('info', `${signal} - beende.`);
    server.close().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

export { readConfig };

// Nur starten, wenn direkt aufgerufen - beim Import aus Tests nicht.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
