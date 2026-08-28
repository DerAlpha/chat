/**
 * Profilbilder verbergen und ausblenden.
 *
 * Zwei Richtungen, die nur wie eine aussehen:
 *
 * Das EIGENE Bild vor jemandem zu verbergen ist eine Zusage über Sichtbarkeit
 * – und die wird hier nicht an der Anzeige geprüft, sondern an der Leitung:
 * das Bild muss wirklich aus dem Raum verschwinden, mit dem gültigen Token
 * der Gegenseite nachgefragt. Eine leere Kopfzeile beweist gar nichts, wenn
 * das Bild eine Sekunde später wieder hochgeht.
 *
 * Das Bild eines ANDEREN auszublenden ist dagegen nur eine Entscheidung über
 * die eigene Anzeige. Dort ist die Frage, ob es wirklich überall verschwindet
 * – auch aus der Liste auf der Startseite, wo eine winzige Kopie liegt.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat, joinChat, withName, makePng } from './helpers.js';

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

async function bildWaehlen(seite, oeffnen) {
  const [dialog] = await Promise.all([seite.waitForEvent('filechooser'), oeffnen()]);
  await dialog.setFiles({ name: 'foto.png', mimeType: 'image/png', buffer: makePng(400, 300) });
  const uebernehmen = seite.locator('#crop-apply');
  await expect(uebernehmen).toBeVisible({ timeout: 15_000 });
  await uebernehmen.click();
}

async function eigenesBildSetzen(seite) {
  await seite.locator('#btn-avatar').click();
  await bildWaehlen(seite, () => seite.getByRole('button', { name: /Bild auswählen/i }).click());
  await expect(seite.locator('#btn-avatar .avatar.has-image')).toBeVisible({ timeout: 15_000 });
}

/** Legt eine Gruppe an und gibt die Beitrittslinks zurueck. */
async function gruppeAnlegen(page, { name = 'Verein', count = 1, nick = 'Anton' } = {}) {
  if (nick) await withName(page, nick);
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

/**
 * Fragt vom Geraet der Gegenseite aus nach, ob dort wirklich ein Bild liegt.
 *
 * Mit deren eigenem, gueltigem Token - also genau so, wie es die App selbst
 * tut. Das ist der einzige Nachweis, der zaehlt: die Anzeige kann aus
 * hundert Gruenden leer sein.
 *
 * `no-store` ist hier keine Kleinigkeit: das PHP-Backend laesst Bilder einen
 * Tag lang zwischenspeichern, und ohne diesen Zusatz antwortet der Browser
 * aus seinem eigenen Speicher mit 200 - ueber ein Bild, das auf dem Server
 * laengst weg ist. Gefragt wird hier nach dem Server, nicht nach dem Browser.
 */
const liegtDort = (seite, owner) => seite.evaluate(async (wer) => {
  const sitzung = JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]')[0];
  const wo = new URL(`api/rooms/${sitzung.roomId}/avatar/${wer}`, location.href);
  const antwort = await fetch(wo, { headers: { 'x-room-token': sitzung.token }, cache: 'no-store' });
  return antwort.status;
}, owner);

/** Den Umschalter im Chat-Menue umlegen. */
async function verbergenUmlegen(seite) {
  await seite.locator('#chat-menu').click();
  await expect(seite.locator('#sheet')).toBeVisible({ timeout: 10_000 });
  await seite.getByRole('button', { name: /Mein Bild hier verbergen/ }).click();
  await expect(seite.locator('#sheet')).toBeHidden({ timeout: 15_000 });
}

test('Verborgen heißt: es liegt gar nicht erst da', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  await withName(seiteA, 'Anton');
  await seiteA.goto('./');
  await eigenesBildSetzen(seiteA);
  const { link } = await createChat(seiteA, { nick: null });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });

  // Erst ist es da - bei B zu sehen und auf dem Server abrufbar.
  await expect(seiteB.locator('#peer-avatar img.avatar__img')).toBeVisible({ timeout: 25_000 });
  const wer = await seiteA.evaluate(() =>
    JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]')[0].memberId);
  expect(await liegtDort(seiteB, wer), 'vor dem Verbergen muss es da sein').toBe(200);

  await verbergenUmlegen(seiteA);

  // Bei B steht wieder der Anfangsbuchstabe.
  await expect(seiteB.locator('#peer-avatar')).toHaveText('A', { timeout: 25_000 });
  await expect(seiteB.locator('#peer-avatar img')).toHaveCount(0);
  // Und das ist kein Anzeigetrick: mit Miras eigenem Token kommt nichts mehr.
  await expect.poll(() => liegtDort(seiteB, wer), { timeout: 20_000 }).toBe(404);

  await kontextA.close();
  await kontextB.close();
});

/**
 * Der eigentliche Fehler war nicht das Verbergen, sondern das Wiederkommen:
 * beim Oeffnen aus der Liste wurde die Sitzung aus einer festen Feldliste neu
 * gebaut, und alles, was nicht darin stand, fiel weg. Die Sperre hielt genau
 * eine Sitzung - danach lud die App das Bild von selbst wieder hoch.
 */
test('Die Sperre überlebt das erneute Betreten', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  await withName(seiteA, 'Anton');
  await seiteA.goto('./');
  await eigenesBildSetzen(seiteA);
  const { link } = await createChat(seiteA, { nick: null });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  await expect(seiteB.locator('#peer-avatar img.avatar__img')).toBeVisible({ timeout: 25_000 });

  const wer = await seiteA.evaluate(() =>
    JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]')[0].memberId);
  await verbergenUmlegen(seiteA);
  await expect.poll(() => liegtDort(seiteB, wer), { timeout: 20_000 }).toBe(404);

  // Kein einziges PUT mehr auf diese Adresse - ab jetzt wird mitgeschnitten.
  const hochgeladen = [];
  await seiteA.route('**/api/rooms/*/avatar/*', async (route) => {
    if (route.request().method() === 'PUT') hochgeladen.push(route.request().url());
    return route.fallback();
  });

  // Raus aus dem Chat, neu laden, und aus der Liste wieder hinein.
  await seiteA.locator('#chat-back').click();
  await seiteA.reload();
  const eintrag = seiteA.locator('#chat-list .chat-list__item').first();
  await expect(eintrag).toBeVisible({ timeout: 25_000 });
  await eintrag.click();
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  await seiteA.waitForTimeout(2500);

  expect(hochgeladen, `nach dem Verbergen doch hochgeladen: ${hochgeladen.join(', ')}`).toEqual([]);
  expect(await liegtDort(seiteB, wer), 'das Bild ist beim Wiederkommen zurückgekehrt').toBe(404);

  // Und der Schalter steht immer noch auf An.
  await seiteA.locator('#chat-menu').click();
  await expect(seiteA.getByRole('button', { name: /Mein Bild hier verbergen/ })).toContainText('An');

  await kontextA.close();
  await kontextB.close();
});

test('Wieder zeigen legt das Bild zurück', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  await withName(seiteA, 'Anton');
  await seiteA.goto('./');
  await eigenesBildSetzen(seiteA);
  const { link } = await createChat(seiteA, { nick: null });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  await expect(seiteB.locator('#peer-avatar img.avatar__img')).toBeVisible({ timeout: 25_000 });
  const wer = await seiteA.evaluate(() =>
    JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]')[0].memberId);

  await verbergenUmlegen(seiteA);
  await expect.poll(() => liegtDort(seiteB, wer), { timeout: 20_000 }).toBe(404);

  await verbergenUmlegen(seiteA);
  await expect.poll(() => liegtDort(seiteB, wer), { timeout: 25_000 }).toBe(200);
  await expect(seiteB.locator('#peer-avatar img.avatar__img')).toBeVisible({ timeout: 25_000 });

  await kontextA.close();
  await kontextB.close();
});

/**
 * Ein neues Bild darf im gesperrten Chat nicht doch noch landen. Es geht
 * ueber einen anderen Weg hinaus - mit force, das den Kurzschluss ueber die
 * Bildmarke aushebelt.
 */
test('Ein neues Bild landet nicht im verborgenen Chat', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  await withName(seiteA, 'Anton');
  await seiteA.goto('./');
  await eigenesBildSetzen(seiteA);
  const { link } = await createChat(seiteA, { nick: null });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  await expect(seiteB.locator('#peer-avatar img.avatar__img')).toBeVisible({ timeout: 25_000 });
  const wer = await seiteA.evaluate(() =>
    JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]')[0].memberId);

  await verbergenUmlegen(seiteA);
  await expect.poll(() => liegtDort(seiteB, wer), { timeout: 20_000 }).toBe(404);

  // Jetzt ein anderes Bild waehlen - mitten im gesperrten Chat.
  await seiteA.locator('#chat-menu').click();
  await seiteA.getByRole('button', { name: /^Mein Profil/ }).click();
  const [dialog] = await Promise.all([
    seiteA.waitForEvent('filechooser'),
    seiteA.getByRole('button', { name: /Anderes Bild auswählen/i }).click(),
  ]);
  await dialog.setFiles({ name: 'zwei.png', mimeType: 'image/png', buffer: makePng(300, 500) });
  await seiteA.locator('#crop-apply').click();
  await seiteA.waitForTimeout(2500);

  expect(await liegtDort(seiteB, wer), 'das neue Bild ist doch im Raum gelandet').toBe(404);
  await expect(seiteB.locator('#peer-avatar img')).toHaveCount(0);

  await kontextA.close();
  await kontextB.close();
});

/**
 * Die andere Richtung: fremde Bilder ausblenden. Das bleibt hier - und muss
 * deshalb auch wirklich ueberall verschwinden, die winzige Kopie in der
 * Chatliste eingeschlossen.
 */
test('Ausgeblendet verschwindet auch aus der Übersicht', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  await withName(seiteA, 'Anton');
  await seiteA.goto('./');
  await eigenesBildSetzen(seiteA);
  const { link } = await createChat(seiteA, { nick: null });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  await expect(seiteB.locator('#peer-avatar img.avatar__img')).toBeVisible({ timeout: 25_000 });

  // Erst steht das Bildchen auch in der Liste.
  await expect.poll(
    () => seiteB.evaluate(() => Boolean(JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]')[0]?.listAvatar)),
    { timeout: 25_000 },
  ).toBe(true);

  // Ueber das Profil des Gegenuebers ausblenden.
  await seiteB.locator('#peer-open').click();
  await expect(seiteB.locator('#sheet')).toBeVisible({ timeout: 10_000 });
  await seiteB.getByRole('button', { name: /^Bild ausblenden/ }).click();
  await expect(seiteB.locator('#sheet')).toBeHidden({ timeout: 10_000 });

  await expect(seiteB.locator('#peer-avatar')).toHaveText('A', { timeout: 15_000 });
  await expect(seiteB.locator('#peer-avatar img')).toHaveCount(0);

  // Auch die kleine Kopie ist weg - und bleibt es ueber einen Neustart.
  await expect.poll(
    () => seiteB.evaluate(() => JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]')[0]?.listAvatar ?? null),
    { timeout: 20_000 },
  ).toBe(null);

  await seiteB.reload();
  await expect(seiteB.locator('#chat-list .chat-list__item')).toBeVisible({ timeout: 25_000 });
  await expect(seiteB.locator('#chat-list .avatar img')).toHaveCount(0);
  expect(
    await seiteB.evaluate(() => JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]')[0]?.listAvatar ?? null),
    'das Bildchen ist nach dem Neustart zurückgekehrt',
  ).toBe(null);

  // Und Anton merkt nichts davon: sein Bild liegt unveraendert im Raum.
  // Ausblenden ist eine Entscheidung ueber die eigene Anzeige, mehr nicht.
  const wer = await seiteA.evaluate(() =>
    JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]')[0].memberId);
  expect(await liegtDort(seiteB, wer), 'das Ausblenden hat beim anderen etwas verändert').toBe(200);

  await kontextA.close();
  await kontextB.close();
});

test('Wieder zeigen holt das ausgeblendete Bild zurück', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  await withName(seiteA, 'Anton');
  await seiteA.goto('./');
  await eigenesBildSetzen(seiteA);
  const { link } = await createChat(seiteA, { nick: null });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteB.locator('#peer-avatar img.avatar__img')).toBeVisible({ timeout: 25_000 });

  const umlegen = async (name) => {
    await seiteB.locator('#peer-open').click();
    await expect(seiteB.locator('#sheet')).toBeVisible({ timeout: 10_000 });
    await seiteB.getByRole('button', { name }).click();
    await expect(seiteB.locator('#sheet')).toBeHidden({ timeout: 10_000 });
  };

  await umlegen(/^Bild ausblenden/);
  await expect(seiteB.locator('#peer-avatar img')).toHaveCount(0);
  await umlegen(/^Bild wieder zeigen/);
  await expect(seiteB.locator('#peer-avatar img.avatar__img')).toBeVisible({ timeout: 25_000 });

  await kontextA.close();
  await kontextB.close();
});

/**
 * Ausgeblendet bleibt ausgeblendet - auch wenn die Person ihr Bild wechselt.
 *
 * Das ist der Weg, auf dem sich ein ausgeblendetes Bild selbst zurueckholt:
 * eine Meldung "hat sein Bild geaendert" kommt herein, und wer sie unbesehen
 * abarbeitet, laedt genau das Gesicht wieder, das man weggeklickt hat.
 */
test('Ein gewechseltes Bild kommt nicht durch die Ausblendung', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  await withName(seiteA, 'Anton');
  await seiteA.goto('./');
  await eigenesBildSetzen(seiteA);
  const { link } = await createChat(seiteA, { nick: null });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteB.locator('#peer-avatar img.avatar__img')).toBeVisible({ timeout: 25_000 });

  await seiteB.locator('#peer-open').click();
  await expect(seiteB.locator('#sheet')).toBeVisible({ timeout: 10_000 });
  await seiteB.getByRole('button', { name: /^Bild ausblenden/ }).click();
  await expect(seiteB.locator('#peer-avatar img')).toHaveCount(0, { timeout: 10_000 });

  // Ab hier wird mitgeschnitten: Mira darf Antons Bild nicht mehr anfassen.
  const geholt = [];
  await seiteB.route('**/api/rooms/*/avatar/*', async (route) => {
    if (route.request().method() === 'GET') geholt.push(route.request().url());
    return route.fallback();
  });

  // Anton wechselt sein Bild.
  await seiteA.locator('#chat-menu').click();
  await seiteA.getByRole('button', { name: /^Mein Profil/ }).click();
  const [dialog] = await Promise.all([
    seiteA.waitForEvent('filechooser'),
    seiteA.getByRole('button', { name: /Anderes Bild auswählen/i }).click(),
  ]);
  await dialog.setFiles({ name: 'zwei.png', mimeType: 'image/png', buffer: makePng(300, 500) });
  await seiteA.locator('#crop-apply').click();
  await seiteA.waitForTimeout(3000);

  // Bei Mira steht weiterhin der Buchstabe - und sie hat nichts nachgeladen.
  await expect(seiteB.locator('#peer-avatar')).toHaveText('A');
  await expect(seiteB.locator('#peer-avatar img')).toHaveCount(0);
  expect(geholt, `trotz Ausblendung geholt: ${geholt.join(', ')}`).toEqual([]);
  expect(
    await seiteB.evaluate(() => JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]')[0]?.listAvatar ?? null),
    'das gewechselte Bild ist in der Übersicht gelandet',
  ).toBe(null);

  await kontextA.close();
  await kontextB.close();
});

/**
 * In einer Gruppe kann es das Versprechen "nur vor dieser einen Person" nicht
 * geben: alle teilen denselben Schluessel. Die Beschriftung sagt das - und
 * der Schalter tut, was sie sagt.
 */
test('In einer Gruppe gilt das Verbergen für alle - und sagt es auch', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  await withName(seiteA, 'Anton');
  await seiteA.goto('./');
  await eigenesBildSetzen(seiteA);
  const [linkB] = await gruppeAnlegen(seiteA, { count: 1, nick: null });
  await withName(seiteB, 'Mira');
  await seiteB.goto(linkB);
  await expect(seiteB.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  await seiteA.locator('#btn-group-to-chat').click();

  // Erst muss dort wirklich etwas liegen - sonst waere die 404 danach kein
  // Beweis, sondern nur der Zustand, der ohnehin schon herrschte.
  const wer = await seiteA.evaluate(() =>
    JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]')[0].memberId);
  await expect.poll(() => liegtDort(seiteB, wer), { timeout: 25_000 }).toBe(200);

  await seiteA.locator('#chat-menu').click();
  const schalter = seiteA.getByRole('button', { name: /Mein Bild hier verbergen/ });
  await expect(schalter).toContainText(/Gilt für alle in dieser Gruppe/);
  await schalter.click();
  await expect(seiteA.locator('#sheet')).toBeHidden({ timeout: 15_000 });

  await expect.poll(() => liegtDort(seiteB, wer), { timeout: 20_000 }).toBe(404);

  await kontextA.close();
  await kontextB.close();
});

/**
 * Verbergen gilt pro Chat - das ist die Zusage, die neben dem Schalter steht.
 *
 * Ohne diese Pruefung koennte aus "hier verbergen" unbemerkt "ueberall
 * verbergen" werden: das Bild wohnt in den Einstellungen und geht in jeden
 * Raum einzeln, eine falsch gesetzte Sperre traefe alle.
 */
test('Verborgen ist es nur hier - der andere Chat behält das Bild', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const kontextC = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const seiteC = await kontextC.newPage();

  await withName(seiteA, 'Anton');
  await seiteA.goto('./');
  await eigenesBildSetzen(seiteA);

  // Zwei Chats, zwei Gegenüber.
  const ersterChat = await createChat(seiteA, { nick: null });
  await joinChat(seiteB, ersterChat.link, { nick: 'Mira' });
  await expect(seiteB.locator('#peer-avatar img.avatar__img')).toBeVisible({ timeout: 25_000 });
  const werB = await seiteA.evaluate(() =>
    JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]')[0].memberId);

  await seiteA.locator('#chat-back').click();
  const zweiterChat = await createChat(seiteA, { nick: null });
  await joinChat(seiteC, zweiterChat.link, { nick: 'Nora' });
  await expect(seiteC.locator('#peer-avatar img.avatar__img')).toBeVisible({ timeout: 25_000 });
  const werC = await seiteA.evaluate(() => {
    const alle = JSON.parse(localStorage.getItem('fc:sessions:v1') ?? '[]');
    return alle[0].memberId;
  });

  // Im zweiten Chat verbergen.
  await verbergenUmlegen(seiteA);
  await expect.poll(() => liegtDort(seiteC, werC), { timeout: 20_000 }).toBe(404);
  await expect(seiteC.locator('#peer-avatar img')).toHaveCount(0, { timeout: 20_000 });

  // Und jetzt der Punkt: zurück in den ERSTEN Chat. Genau dort räumt die App
  // beim Betreten auf, wenn dieser Chat gesperrt ist - eine Sperre, die in
  // Wahrheit geräteweit gilt, nimmt hier das Bild mit. Ohne dieses erneute
  // Betreten bliebe der Test grün, auch wenn die Sperre alle Chats träfe.
  await seiteA.locator('#chat-back').click();
  const eintraege = seiteA.locator('#chat-list .chat-list__item');
  await expect(eintraege).toHaveCount(2, { timeout: 20_000 });
  await eintraege.nth(1).click();
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  await seiteA.waitForTimeout(2500);

  expect(await liegtDort(seiteB, werB), 'das Verbergen hat auch den anderen Chat getroffen').toBe(200);
  await expect(seiteB.locator('#peer-avatar img.avatar__img')).toBeVisible();
  // Und im ersten Chat steht der Schalter folgerichtig auf Aus.
  await seiteA.locator('#chat-menu').click();
  await expect(seiteA.getByRole('button', { name: /Mein Bild hier verbergen/ })).toContainText('Aus');

  await kontextA.close();
  await kontextB.close();
  await kontextC.close();
});

/**
 * Auch die andere Richtung muss das erneute Betreten überstehen. Es ist
 * derselbe Fehler wie beim Verbergen - nur fällt er hier leiser aus: das
 * Gesicht ist einfach wieder da.
 */
test('Die Ausblendung überlebt das erneute Betreten', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  await withName(seiteA, 'Anton');
  await seiteA.goto('./');
  await eigenesBildSetzen(seiteA);
  const { link } = await createChat(seiteA, { nick: null });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteB.locator('#peer-avatar img.avatar__img')).toBeVisible({ timeout: 25_000 });

  await seiteB.locator('#peer-open').click();
  await expect(seiteB.locator('#sheet')).toBeVisible({ timeout: 10_000 });
  await seiteB.getByRole('button', { name: /^Bild ausblenden/ }).click();
  await expect(seiteB.locator('#peer-avatar img')).toHaveCount(0, { timeout: 10_000 });

  // Raus, neu laden, wieder hinein.
  await seiteB.locator('#chat-back').click();
  await seiteB.reload();
  const eintrag = seiteB.locator('#chat-list .chat-list__item').first();
  await expect(eintrag).toBeVisible({ timeout: 25_000 });
  await expect(seiteB.locator('#chat-list .avatar img')).toHaveCount(0);
  await eintrag.click();
  await expect(seiteB.locator('#screen-chat')).toBeVisible({ timeout: 25_000 });
  await seiteB.waitForTimeout(2500);

  await expect(seiteB.locator('#peer-avatar')).toHaveText('A');
  await expect(seiteB.locator('#peer-avatar img')).toHaveCount(0);
  // Und im Profil steht weiterhin der Weg zurück.
  await seiteB.locator('#peer-open').click();
  await expect(seiteB.getByRole('button', { name: /^Bild wieder zeigen/ })).toBeVisible({ timeout: 10_000 });

  await kontextA.close();
  await kontextB.close();
});

/** Ohne eigenes Bild gibt es nichts zu verbergen - und keinen Schalter. */
test('Kein Bild, kein Schalter', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();
  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });

  await seiteA.locator('#chat-menu').click();
  await expect(seiteA.locator('#sheet')).toBeVisible({ timeout: 10_000 });
  await expect(seiteA.getByRole('button', { name: /Mein Bild hier verbergen/ })).toHaveCount(0);
  // Und ohne Bild des Gegenübers gibt es auch dort nichts auszublenden.
  await seiteA.keyboard.press('Escape');
  await seiteA.locator('#peer-open').click();
  await expect(seiteA.locator('#sheet')).toBeVisible({ timeout: 10_000 });
  await expect(seiteA.getByRole('button', { name: /^Bild ausblenden/ })).toHaveCount(0);

  await kontextA.close();
  await kontextB.close();
});
