import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 3199);
/**
 * Dieselbe Suite laeuft gegen die Wurzel und gegen einen Unterpfad:
 *   npm run test:e2e            -> http://127.0.0.1:3199/
 *   E2E_BASE_PATH=/chats ...    -> http://127.0.0.1:3199/chats/
 */
const BASE_PATH = (process.env.E2E_BASE_PATH ?? '').replace(/\/+$/, '');
/** Gegen eine bereits laufende Auslieferung testen (z. B. das gebaute Paket unter Apache). */
const EXTERNAL = process.env.E2E_EXTERNAL_URL ?? '';
const baseURL = EXTERNAL || `http://127.0.0.1:${PORT}${BASE_PATH}/`;
// Frischer Datenordner pro Lauf, damit Tests sich nicht gegenseitig sehen.
const dataDir = path.join(os.tmpdir(), `fluesterchat-e2e-${process.pid}`);

/** In vorbereiteten Umgebungen liegt Chromium bereits irgendwo. */
const executablePath = process.env.CHROMIUM_PATH || undefined;

/** Ohne echtes Mikrofon: Chromium liefert einen Testton und fragt nicht nach. */
const launchOptions = {
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
};

/**
 * Dieselbe Suite läuft gegen beide Backends:
 *   npm run test:e2e      -> Node mit WebSocket
 *   npm run test:e2e:php  -> PHP mit Long-Polling (wie auf dem Webspace)
 */
const BACKEND = process.env.E2E_BACKEND === 'php' ? 'php' : 'node';

function phpWebServer() {
  const docRoot = path.join(os.tmpdir(), `fluesterchat-php-e2e-${process.pid}`);
  const dataDir = path.join(os.tmpdir(), `fluesterchat-php-data-${process.pid}`);
  fs.rmSync(docRoot, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(docRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.cpSync('public', docRoot, { recursive: true });
  fs.cpSync('php/api', path.join(docRoot, 'api'), { recursive: true });
  fs.writeFileSync(
    path.join(docRoot, 'api', 'lib', 'config.local.php'),
    `<?php return ['dataDir' => '${dataDir}', 'pollWaitSeconds' => 15, 'welcomeHistory' => 5];\n`,
  );
  return {
    command: `php -S 127.0.0.1:${PORT} -t ${docRoot} php/router.php`,
    // Ohne Arbeitsprozesse blockiert eine wartende Abfrage den ganzen Server.
    env: { PHP_CLI_SERVER_WORKERS: '24' },
    url: `${baseURL}api/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
  };
}

export default defineConfig({
  testDir: './test/e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions,
  },
  projects: [
    {
      name: 'Smartphone',
      use: {
        ...devices['Pixel 5'],
        launchOptions,
        // Die Oberflaeche ist zweisprachig - getestet wird die deutsche Fassung.
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
        permissions: ['clipboard-read', 'clipboard-write'],
      },
    },
  ],
  webServer: EXTERNAL ? undefined : BACKEND === 'php' ? phpWebServer() : {
    command: 'node server/index.js',
    url: `${baseURL}healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      BASE_PATH,
      LOG_LEVEL: 'warn',
      CREATE_ROOM_PER_HOUR: '2000',
      JOIN_ATTEMPTS_PER_HOUR: '5000',
      UPLOADS_PER_HOUR: '2000',
      // Klein gehalten, damit das Nachladen älterer Nachrichten überhaupt geprüft wird.
      WELCOME_HISTORY: '5',
    },
  },
});
