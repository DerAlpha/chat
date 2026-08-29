/**
 * Die Liste der Änderungen.
 *
 * Zwei Wege führen hin: der Knopf in der Fußzeile, und - genau einmal - eine
 * Aktualisierung. "Genau einmal" ist der heikle Teil: die Liste merkt sich
 * beim Öffnen sofort, dass sie gesehen wurde, sonst ginge sie bei jedem
 * Laden wieder auf.
 *
 * Geprüft wird auch, dass die einundfünfzig Einträge im Blatt wirklich
 * rollen und der letzte erreichbar ist - eine Liste, die in einem Flex-Kasten
 * zusammengedrückt wird, sieht vollständig aus und ist es nicht.
 */
import { test, expect, devices, rawContext } from './fixtures.js';
const G = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

test('Der Knopf öffnet die Chronik', async ({ browser }) => {
  const k = await browser.newContext(G); const p = await k.newPage();
  await p.goto('./');
  await expect(p.locator('#btn-changelog')).toBeVisible();
  await p.locator('#btn-changelog').click();
  await expect(p.locator('#sheet')).toBeVisible();
  const m = await p.evaluate(() => {
    const eintraege = [...document.querySelectorAll('.changelog__item')];
    const erste = eintraege[0];
    return {
      anzahl: eintraege.length,
      titel: document.getElementById('sheet-title').textContent,
      erstesDatum: erste.querySelector('time').textContent,
      erstesAttribut: erste.querySelector('time').dateTime,
      ersterText: erste.querySelector('.changelog__text').textContent.slice(0, 60),
      letztesDatum: eintraege[eintraege.length - 1].querySelector('time').textContent,
      neuMarken: document.querySelectorAll('.changelog__neu').length,
      quer: document.getElementById('sheet-body').scrollWidth - document.getElementById('sheet-body').clientWidth,
      // Rollt das Blatt wirklich, oder wird die Liste zusammengedrueckt?
      blattRollt: (() => { const b = document.querySelector('.sheet__panel'); return b.scrollHeight > b.clientHeight + 1; })(),
      listeHoch: Math.round(document.querySelector('.changelog').getBoundingClientRect().height),
      summeEintraege: eintraege.reduce((n, e) => n + e.getBoundingClientRect().height, 0) | 0,
      letzterErreichbar: (() => {
        const b = document.querySelector('.sheet__panel');
        b.scrollTop = b.scrollHeight;
        const l = eintraege[eintraege.length - 1].getBoundingClientRect();
        const r = b.getBoundingClientRect();
        return l.bottom <= r.bottom + 2 && l.top >= r.top - 2;
      })(),
    };
  });
  expect(m.anzahl, 'die Chronik ist leer').toBeGreaterThan(40);
  expect(m.titel).toBe('Was sich geändert hat');
  expect(m.erstesAttribut, 'der Zeitpunkt fehlt als maschinenlesbares Attribut').toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  expect(m.erstesDatum, 'kein lesbares Datum').toMatch(/\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/);
  expect(m.quer, 'die Chronik läuft seitlich über').toBeLessThanOrEqual(0);
  expect(m.blattRollt, 'das Blatt rollt nicht - die Liste wird zusammengedrückt').toBe(true);
  expect(m.letzterErreichbar, 'der älteste Eintrag ist nicht zu erreichen').toBe(true);
  // Ohne Anlass keine Neu-Marken.
  expect(m.neuMarken).toBe(0);
  await k.close();
});

test('Nach einem Update poppt sie von selbst auf', async ({ browser }) => {
  const k = await browser.newContext(G); const p = await k.newPage();
  // Erst ganz normal ankommen, dann so tun, als sei zuletzt eine aeltere
  // Fassung gelaufen. Ueber addInitScript ginge das nicht: das liefe bei
  // JEDEM Laden wieder und setzte den Merker immer wieder zurueck.
  await p.goto('./');
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('fc:prefs:v1') || '{}');
    localStorage.setItem('fc:prefs:v1', JSON.stringify({
      ...prefs, seenVersion: 'aaaaaaaaaaaa', seenChangelog: '2026-08-28T20:58',
    }));
  });
  await p.reload();
  await expect(p.locator('#sheet')).toBeVisible({ timeout: 10000 });
  const m = await p.evaluate(() => ({
    titel: document.getElementById('sheet-title').textContent,
    hinweis: document.querySelector('#sheet-body .sheet-note').textContent,
    neuMarken: document.querySelectorAll('.changelog__neu').length,
    gemerkt: JSON.parse(localStorage.getItem('fc:prefs:v1')).seenVersion,
  }));
  expect(m.hinweis, 'es fehlt der Satz, dass sich etwas getan hat').toContain('letzten Besuch');
  expect(m.neuMarken, 'nichts ist als neu markiert').toBeGreaterThan(0);
  expect(m.gemerkt, 'die Fassung wurde nicht gemerkt').not.toBe('aaaaaaaaaaaa');

  // Zweiter Aufruf: jetzt darf nichts mehr aufpoppen
  await p.reload();
  await p.waitForTimeout(1200);
  const nochmal = await p.evaluate(() => ({
    blattOffen: !document.getElementById('sheet').hidden,
  }));
  expect(nochmal.blattOffen, 'die Chronik geht bei jedem Laden wieder auf').toBe(false);
  await k.close();
});

test('Beim allerersten Besuch bleibt sie zu', async ({ browser }) => {
  const k = await browser.newContext({ ...G });
  const p = await k.newPage();
  await p.goto('./');
  await p.waitForTimeout(1200);
  const m = await p.evaluate(() => ({
    blattOffen: !document.getElementById('sheet').hidden,
    gemerkt: JSON.parse(localStorage.getItem('fc:prefs:v1') || '{}').seenVersion,
  }));
  expect(m.blattOffen, 'beim ersten Besuch soll nichts aufpoppen').toBe(false);
  expect(m.gemerkt, 'die Fassung wurde beim ersten Besuch nicht gemerkt').toBeTruthy();
  await k.close();
});

/**
 * Auf einem leeren Speicher legt die Chronik nichts an.
 *
 * Der Merker ist bequem - aber er ist ein Schluessel wie jeder andere. Wer
 * gerade alles geloescht hat, faende ihn beim naechsten Start schon wieder
 * vor. Hier ohne die Voreinstellungen der Testumgebung, die sonst selbst
 * einen Eintrag schreibt und den Blick verstellt.
 */
test('Ohne gespeicherte Daten schreibt die Chronik nichts', async ({ browser }) => {
  const k = await rawContext(browser, G);
  const p = await k.newPage();
  await p.goto('./');
  await expect(p.locator('#screen-start')).toBeVisible({ timeout: 20_000 });
  await p.waitForTimeout(1200);
  const m = await p.evaluate(() => ({
    blattOffen: !document.getElementById('sheet').hidden,
    eigene: Object.keys(localStorage).filter((s) => s.startsWith('fc:')),
  }));
  expect(m.blattOffen, 'ohne Vorgeschichte soll nichts aufpoppen').toBe(false);
  expect(m.eigene, `angelegt: ${m.eigene.join(', ')}`).toEqual([]);
  await k.close();
});
