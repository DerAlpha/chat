/**
 * Gemeinsame Grundlage für alle E2E-Tests.
 *
 * Die App fragt beim ersten Chat nach einem Namen, wenn keiner feststeht -
 * ein halbhohes Menü, das jeden Klick darunter abfängt. Für den einen Test,
 * der genau das prüft, ist das der Gegenstand; für alle anderen wäre es nur
 * eine Falle, in die jeder neue Test von selbst tappt. Deshalb bekommt hier
 * jeder Browser-Kontext vorab einen Namen, und wer ohne auskommen will, sagt
 * es ausdrücklich mit ohneNamen().
 */
import { test as base } from '@playwright/test';

export { expect, devices } from '@playwright/test';

const PREFS_KEY = 'fc:prefs:v1';

function seed(value) {
  try {
    const prefs = JSON.parse(localStorage.getItem('fc:prefs:v1') ?? '{}');
    localStorage.setItem('fc:prefs:v1', JSON.stringify({ ...prefs, nick: value }));
  } catch { /* ohne Speicher fragt die App eben */ }
}

/** Nimmt den vorab gesetzten Namen wieder weg - für den Test der Abfrage. */
export async function ohneNamen(target) {
  await target.addInitScript((key) => {
    try {
      const prefs = JSON.parse(localStorage.getItem(key) ?? '{}');
      delete prefs.nick;
      localStorage.setItem(key, JSON.stringify(prefs));
    } catch { /* egal */ }
  }, PREFS_KEY);
}

export const test = base.extend({
  browser: async ({ browser }, use) => {
    // Auch Kontexte, die ein Test selbst aufmacht, sollen den Namen haben.
    const original = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await original(options);
      await context.addInitScript(seed, 'Testkind');
      return context;
    };
    await use(browser);
    browser.newContext = original;
  },
  context: async ({ context }, use) => {
    await context.addInitScript(seed, 'Testkind');
    await use(context);
  },
});
