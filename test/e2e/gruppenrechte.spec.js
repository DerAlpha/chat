/**
 * Rechte in Gruppen - und dass der Server sie durchsetzt.
 *
 * Eine Oberfläche, die den Knopf versteckt, ist keine Sicherung: wer will,
 * schickt den Frame von Hand. Deshalb wird hier nicht nur geprüft, dass die
 * Knöpfe fehlen, sondern auch, dass es ohne sie trotzdem nicht geht.
 */
import { test, expect, devices } from './fixtures.js';
import { withName } from './helpers.js';

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

async function gruppeAnlegen(page, { name = 'Verein', count = 1, nick = 'Anton' } = {}) {
  await withName(page, nick);
  await page.goto('./');
  await page.getByRole('button', { name: /Gruppe erstellen/i }).click();
  await page.locator('#sheet input[type="text"]').fill(name);
  await page.locator('#group-size').fill(String(count));
  await page.locator('#sheet').getByRole('button', { name: /^Anlegen$/ }).click();
  await expect(page.locator('#screen-group')).toBeVisible({ timeout: 20_000 });
  const codes = await page.locator('#group-codes .invite-row__code').allInnerTexts();
  const basis = new URL(page.url());
  return codes.map((code) => `${basis.origin}${basis.pathname}#g:${encodeURIComponent(code.trim())}`);
}

async function beitreten(seite, link, nick) {
  await withName(seite, nick);
  await seite.goto(link);
  await expect(seite.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
}

/**
 * Eine Gruppe mit Anton (Verwalter) und Mira.
 *
 * Kleiner als zwei Codes geht nicht - das Anlegen setzt eine Untergrenze.
 * Die Gruppe hat also drei Plaetze, von denen einer frei bleibt.
 */
async function gruppeZuZweit(browser) {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const [link] = await gruppeAnlegen(seiteA, { count: 2, nick: 'Anton' });
  await beitreten(seiteB, link, 'Mira');
  await seiteA.locator('#btn-group-to-chat').click();
  await expect(seiteA.locator('#screen-chat')).toBeVisible();
  return { kontextA, kontextB, seiteA, seiteB };
}

const menue = async (seite) => {
  await seite.locator('#chat-menu').click();
  await expect(seite.locator('#sheet')).toBeVisible();
};

test('Wer die Gruppe anlegt, verwaltet sie - die anderen nicht', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await gruppeZuZweit(browser);

  await menue(seiteA);
  await seiteA.getByRole('button', { name: /^Gruppe/ }).click();
  await seiteA.getByRole('button', { name: /^Mitglieder/ }).click();
  await expect(seiteA.locator('#sheet')).toContainText(/Verwalter/);
  await expect(seiteA.locator('#sheet')).toContainText(/Mira/);
  await seiteA.keyboard.press('Escape');

  await menue(seiteB);
  // B sieht dasselbe Gruppenprofil - nur ohne Verwalterknöpfe.
  await seiteB.getByRole('button', { name: /^Gruppe/ }).click();
  await expect(seiteB.getByRole('button', { name: /^Mitglieder/ })).toBeVisible();
  await expect(seiteB.getByRole('button', { name: /Weitere einladen/ })).toHaveCount(0);
  await seiteB.getByRole('button', { name: /^Mitglieder/ }).click();
  await expect(seiteB.locator('#sheet')).toContainText(/Mitglied/);

  await kontextA.close();
  await kontextB.close();
});

test('Ein Verwalter kann Rechte weitergeben', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await gruppeZuZweit(browser);

  await menue(seiteA);
  await seiteA.getByRole('button', { name: /^Gruppe/ }).click();
  await seiteA.getByRole('button', { name: /^Mitglieder/ }).click();
  // Antippen öffnet das Profil - dort steht auch der Knopf für die Rechte.
  await seiteA.getByRole('button', { name: /Mira/ }).click();
  await expect(seiteA.locator('#sheet')).toContainText(/Gewöhnliches Mitglied/i);
  await seiteA.getByRole('button', { name: /Zum Verwalter machen/i }).click();

  // B erfährt es und darf danach selbst einladen.
  await expect(seiteB.locator('#toast')).toContainText(/verwaltest diese Gruppe jetzt/i, { timeout: 30_000 });
  await menue(seiteB);
  await seiteB.getByRole('button', { name: /^Gruppe/ }).click();
  await expect(seiteB.getByRole('button', { name: /Weitere einladen/ })).toBeVisible({ timeout: 15_000 });

  await kontextA.close();
  await kontextB.close();
});

/**
 * Der eigentliche Riegel: B geht an der Oberfläche vorbei und ruft die
 * Verwalter-Wege direkt auf, mit seinem eigenen gültigen Token. Der Server
 * muss beides abweisen - sonst wäre das Verstecken der Knöpfe die ganze
 * Sicherung, und das ist keine.
 */
test('Ohne Recht hilft auch der Aufruf von Hand nichts', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await gruppeZuZweit(browser);

  const antwort = await seiteB.evaluate(async () => {
    const [sitzung] = JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]');
    const kopf = { 'x-room-token': sitzung.token };
    const einladen = await fetch(new URL(`api/rooms/${sitzung.roomId}/slots`, location.href), {
      method: 'POST',
      headers: { ...kopf, 'content-type': 'application/json' },
      body: JSON.stringify({ slots: [{ id: 'AAAAAAAAAAAAAAAAAAAAAA', wrapped: 'x'.repeat(40) }] }),
    });
    const bild = await fetch(new URL(`api/rooms/${sitzung.roomId}/avatar/group`, location.href), {
      method: 'PUT',
      headers: { ...kopf, 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    return { einladen: einladen.status, bild: bild.status };
  });
  expect(antwort.einladen, 'B durfte Plaetze anlegen').toBe(403);
  expect(antwort.bild, 'B durfte das Gruppenbild setzen').toBe(403);

  // Und es ist auch wirklich nichts passiert: die Gruppe hat weiter drei
  // Plätze, und in der Kopfzeile steht kein Bild.
  await expect(seiteA.locator('#peer-status')).toContainText(/von 3/, { timeout: 25_000 });
  await expect(seiteB.locator('#peer-avatar img')).toHaveCount(0);

  await kontextA.close();
  await kontextB.close();
});

test('Eine Gruppe lässt sich nachträglich erweitern', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await gruppeZuZweit(browser);
  const kontextC = await browser.newContext(HANDY);
  const seiteC = await kontextC.newPage();

  await menue(seiteA);
  await seiteA.getByRole('button', { name: /^Gruppe/ }).click();
  await seiteA.getByRole('button', { name: /Weitere einladen/ }).click();
  await seiteA.locator('#sheet input[type="text"]').fill('1');
  await seiteA.locator('#sheet').getByRole('button', { name: /^Anlegen$/ }).click();

  // Ein Code mehr als vorher, und die Gruppe hat einen Platz mehr.
  await expect(seiteA.locator('#screen-group')).toBeVisible({ timeout: 20_000 });
  const codes = await seiteA.locator('#group-codes .invite-row__code').allInnerTexts();
  expect(codes).toHaveLength(3);

  const basis = new URL(seiteA.url());
  const link = `${basis.origin}${basis.pathname}#g:${encodeURIComponent(codes[2].trim())}`;
  await beitreten(seiteC, link, 'Cem');

  // Und Cem redet mit: seine Nachricht kommt bei beiden an.
  await seiteC.locator('#message-input').fill('Bin dabei');
  await seiteC.locator('#btn-send').click();
  await expect(seiteB.locator('#messages .msg--in:not(.msg--typing)')).toContainText('Bin dabei', { timeout: 30_000 });

  await seiteA.locator('#btn-group-to-chat').click();
  await expect(seiteA.locator('#peer-status')).toContainText(/von 4/, { timeout: 30_000 });

  await kontextA.close();
  await kontextB.close();
  await kontextC.close();
});

/**
 * Der Riegel nach dem Austritt.
 *
 * Beim Verlassen bleibt der Platz stehen - sonst wuessten die alten
 * Nachrichten der anderen nicht mehr, zu wem sie gehoerten. Das Token an
 * diesem Platz darf danach aber nichts mehr oeffnen: sonst haette jemand,
 * der "alle Daten geloescht" hat, weiter Zugriff auf die Gruppe.
 */
test('Nach dem Austritt öffnet das alte Token nichts mehr', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await gruppeZuZweit(browser);
  await seiteB.locator('#message-input').fill('Noch da');
  await seiteB.locator('#btn-send').click();
  await expect(seiteA.locator('#messages .msg--in:not(.msg--typing)')).toContainText('Noch da', { timeout: 30_000 });

  // B merkt sich seinen Zugang und tritt dann aus.
  const zugang = await seiteB.evaluate(() => {
    const [sitzung] = JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]');
    return { roomId: sitzung.roomId, token: sitzung.token };
  });
  const raus = await seiteB.evaluate(async ({ roomId, token }) => {
    const antwort = await fetch(new URL(`api/rooms/${roomId}/leave`, location.href), {
      method: 'POST',
      headers: { 'x-room-token': token },
    });
    return antwort.status;
  }, zugang);
  expect(raus).toBe(200);

  // Und ab jetzt geht mit demselben Token nichts mehr.
  const danach = await seiteB.evaluate(async ({ roomId, token }) => {
    const kopf = { 'x-room-token': token };
    const nochmal = await fetch(new URL(`api/rooms/${roomId}/leave`, location.href), { method: 'POST', headers: kopf });
    const bild = await fetch(new URL(`api/rooms/${roomId}/avatar/group`, location.href), { headers: kopf });
    const dabei = await fetch(new URL(`api/rooms/${roomId}/join`, location.href), {
      method: 'POST',
      headers: { ...kopf, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    return { nochmal: nochmal.status, bild: bild.status, dabei: dabei.status };
  }, zugang);
  expect(danach.nochmal, 'der Gegangene durfte nochmal austreten').toBe(401);
  expect(danach.bild, 'der Gegangene kam noch an Bilder').toBe(401);
  expect(danach.dabei, 'der Gegangene kam wieder herein').not.toBe(200);

  // Auch die offene Leitung nützt nichts mehr. Beim WebSocket fliegt B
  // sofort heraus und hat gar kein Eingabefeld mehr; beim Abholen per HTTP
  // darf er tippen, aber der Server nimmt es nicht an. Beides ist recht -
  // ankommen darf es nicht.
  // Beides ist recht: dass B gar nicht mehr tippen kann, oder dass er tippt
  // und der Server es abweist. Deshalb darf der Versuch auch fehlschlagen.
  try {
    await seiteB.locator('#message-input').fill('Und trotzdem', { timeout: 4000 });
    await seiteB.locator('#btn-send').click({ timeout: 4000 });
  } catch {
    // B ist schon draussen - genau das war der Sinn der Sache.
  }
  await seiteA.waitForTimeout(3000);
  await expect(seiteA.locator('#messages')).not.toContainText('Und trotzdem');

  // Bei A ist die Gruppe unverändert da, nur ohne B's Nachricht.
  await expect(seiteA.locator('#messages')).toContainText(/hat die Gruppe verlassen/i, { timeout: 30_000 });
  await expect(seiteA.locator('#messages')).not.toContainText('Noch da');

  await kontextA.close();
  await kontextB.close();
});

/**
 * Geht der letzte Verwalter, darf die Gruppe nicht führungslos zurückbleiben:
 * sonst könnte sie nie wieder jemanden einladen und nie wieder ihr Bild
 * ändern.
 */
test('Geht der Verwalter, rückt jemand nach - und erfährt es auch', async ({ browser }) => {
  const { kontextA, kontextB, seiteA, seiteB } = await gruppeZuZweit(browser);

  await seiteA.evaluate(async () => {
    const [sitzung] = JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]');
    await fetch(new URL(`api/rooms/${sitzung.roomId}/leave`, location.href), {
      method: 'POST',
      headers: { 'x-room-token': sitzung.token },
    });
  });

  await expect(seiteB.locator('#toast')).toContainText(/verwaltest diese Gruppe jetzt/i, { timeout: 30_000 });
  await menue(seiteB);
  await seiteB.getByRole('button', { name: /^Gruppe/ }).click();
  await expect(seiteB.getByRole('button', { name: /Weitere einladen/ })).toBeVisible({ timeout: 15_000 });

  await kontextA.close();
  await kontextB.close();
});
