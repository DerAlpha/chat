import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 3199);
/**
 * Dieselbe Suite laeuft gegen die Wurzel und gegen einen Unterpfad:
 *   npm run test:e2e            -> http://127.0.0.1:3199/
 *   E2E_BASE_PATH=/chats ...    -> http://127.0.0.1:3199/chats/
 */
const BASE_PATH = (process.env.E2E_BASE_PATH ?? '').replace(/\/+$/, '');
const baseURL = `http://127.0.0.1:${PORT}${BASE_PATH}/`;
// Frischer Datenordner pro Lauf, damit Tests sich nicht gegenseitig sehen.
const dataDir = path.join(os.tmpdir(), `fluesterchat-e2e-${process.pid}`);

/** In vorbereiteten Umgebungen liegt Chromium bereits irgendwo. */
const executablePath = process.env.CHROMIUM_PATH || undefined;

/** Ohne echtes Mikrofon: Chromium liefert einen Testton und fragt nicht nach. */
const launchOptions = {
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
};

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
  webServer: {
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
