import http from 'node:http';
import { config } from './config.js';
import { log } from './logger.js';
import { Store } from './store.js';
import { Hub } from './ws.js';
import { createApp } from './app.js';

export async function startServer(overrides = {}) {
  const store = new Store({ dataDir: overrides.dataDir });
  await store.init();

  const hub = new Hub(store);
  const app = createApp(store, hub);
  const server = http.createServer(app);

  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;

  const cleanup = setInterval(() => {
    store.cleanup()
      .then((count) => {
        if (count > 0) log.info(`Aufraeumen: ${count} abgelaufene(r) Raum/Raeume entfernt.`);
        for (const room of store.rooms.values()) store.sweepOrphanBlobs(room);
      })
      .catch((err) => log.error('Aufraeumen fehlgeschlagen:', err));
  }, config.cleanupIntervalMs);
  if (typeof cleanup.unref === 'function') cleanup.unref();

  const port = overrides.port ?? config.port;
  const host = overrides.host ?? config.host;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  log.info(`Fluesterchat laeuft auf http://${host}:${address.port}`);

  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(cleanup);
      app.locals.stop?.();
      hub.close();
      await new Promise((resolve) => server.close(resolve));
      await store.close();
      log.info('Server gestoppt.');
    })();
    return closing;
  };

  return { server, store, hub, app, port: address.port, close };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const instance = await startServer();
  const shutdown = (signal) => {
    log.info(`${signal} empfangen, fahre herunter ...`);
    instance.close().then(
      () => process.exit(0),
      (err) => {
        log.error('Fehler beim Herunterfahren:', err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error('Unbehandelte Promise-Ablehnung:', err));
}
