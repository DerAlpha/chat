/**
 * Die Übersicht auf der Startseite.
 *
 * Wenn dort bei jedem Chat "Gegenüber" steht, ist die Liste wertlos - man
 * findet den richtigen nur noch durch Ausprobieren. Zwei Dinge halten
 * dagegen, und beide werden hier geprüft: der Name, den das Gegenüber sich
 * selbst gegeben hat, muss über das Verlassen des Chats hinaus bekannt
 * bleiben; und wer keinen Namen bekommt, lässt sich selbst benennen.
 */
import { test, expect, devices } from './fixtures.js';
import { createChat, joinChat, longPress } from './helpers.js';

const HANDY = { ...devices['Pixel 5'], locale: 'de-DE', timezoneId: 'Europe/Berlin' };

const eintraege = (page) => page.locator('#chat-list .chat-list__item');
const namen = (page) => page.locator('#chat-list .chat-list__name');

/**
 * Der Fehler, um den es geht: A legt den Chat an und geht wieder auf die
 * Startseite - die Verbindung ist damit zu. Erst danach kommt B dazu und
 * gibt sich einen Namen. A erfährt den Namen also nicht über eine laufende
 * Verbindung, sondern erst beim nächsten Betreten, aus der Mitgliederliste.
 *
 * Genau dieser Name wurde bisher entschlüsselt, angezeigt - und nie
 * gespeichert. Kaum war der Chat wieder zu, stand in der Übersicht erneut
 * "Gegenüber".
 */
test('Der Name des Gegenübers bleibt auch nach dem Verlassen bekannt', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  const { link } = await createChat(seiteA, { nick: 'Anton' });
  // A geht zurück auf die Startseite: die Verbindung ist damit zu.
  await seiteA.locator('#invite-back').click();
  await expect(seiteA.locator('#screen-start')).toBeVisible();

  // Erst jetzt tritt B bei - mit Namen.
  await joinChat(seiteB, link, { nick: 'Mira' });

  // A betritt den Chat und erfährt den Namen aus der Mitgliederliste.
  await eintraege(seiteA).first().click();
  await expect(seiteA.locator('#peer-name')).toHaveText('Mira', { timeout: 20_000 });

  // Und zurück: in der Übersicht muss der Name stehen, nicht "Gegenüber".
  await seiteA.locator('#chat-back').click();
  await expect(seiteA.locator('#screen-start')).toBeVisible();
  await expect(namen(seiteA).first()).toHaveText('Mira');

  // Auch nach einem Neuladen - der Name liegt jetzt auf dem Gerät.
  await seiteA.reload();
  await expect(namen(seiteA).first()).toHaveText('Mira', { timeout: 20_000 });

  await kontextA.close();
  await kontextB.close();
});

test('Zwei Chats lassen sich in der Übersicht auseinanderhalten', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();

  const ersterChat = await createChat(seiteA, { nick: 'Anton' });
  await seiteA.locator('#invite-back').click();
  const zweiterChat = await createChat(seiteA, { nick: 'Anton' });
  await seiteA.locator('#invite-back').click();

  const gaeste = [];
  for (const [chat, name] of [[ersterChat, 'Mira'], [zweiterChat, 'Jonas']]) {
    const kontext = await browser.newContext(HANDY);
    const seite = await kontext.newPage();
    await joinChat(seite, chat.link, { nick: name });
    gaeste.push(kontext);
  }

  // Beide Chats einmal betreten, damit die Namen ankommen.
  await seiteA.reload();
  await expect(eintraege(seiteA)).toHaveCount(2, { timeout: 20_000 });
  for (let i = 0; i < 2; i += 1) {
    await eintraege(seiteA).nth(i).click();
    await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
    await expect(seiteA.locator('#peer-name')).not.toHaveText('Gegenüber', { timeout: 20_000 });
    await seiteA.locator('#chat-back').click();
  }

  const gezeigt = await namen(seiteA).allTextContents();
  expect(gezeigt.map((eintrag) => eintrag.trim()).sort()).toEqual(['Jonas', 'Mira']);
  // Und kein einziges blasses "Gegenüber" mehr.
  expect(gezeigt.join(' ')).not.toContain('Gegenüber');

  await kontextA.close();
  for (const kontext of gaeste) await kontext.close();
});

test('Einen Chat kann man selbst benennen - auch ohne Namen des Gegenübers', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  await createChat(seiteA, { nick: 'Anton' });
  await seiteA.locator('#invite-back').click();

  // Niemand ist beigetreten, es gibt also keinen fremden Namen.
  await expect(namen(seiteA).first()).toHaveText('Gegenüber');

  // Langes Drücken auf den Eintrag öffnet sein Menü.
  await longPress(seiteA, eintraege(seiteA).first());
  await expect(seiteA.locator('#sheet')).toBeVisible();
  await seiteA.getByRole('button', { name: /Chat umbenennen/i }).click();
  await seiteA.locator('#sheet input').fill('Mama');
  await seiteA.getByRole('button', { name: 'Speichern', exact: true }).click();

  await expect(namen(seiteA).first()).toHaveText('Mama', { timeout: 20_000 });
  // Der Code bleibt als zweite Zeile stehen - man muss wissen, welchen man
  // weitergegeben hat.
  await expect(seiteA.locator('#chat-list .chat-list__meta').first())
    .toHaveText(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/);

  // Und der eigene Name überlebt das Neuladen ...
  await seiteA.reload();
  await expect(namen(seiteA).first()).toHaveText('Mama', { timeout: 20_000 });

  // ... und das Wiederbetreten. Beim Betreten wird der Datensatz neu
  // geschrieben; wer dabei die Bezeichnung vergisst, hat sie für immer weg.
  await eintraege(seiteA).first().click();
  await expect(seiteA.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
  // Auch in der Kopfzeile steht der selbst vergebene Name.
  await expect(seiteA.locator('#peer-name')).toHaveText('Mama');
  await seiteA.locator('#chat-back').click();
  await expect(seiteA.locator('#screen-start')).toBeVisible();
  await expect(namen(seiteA).first()).toHaveText('Mama');

  await kontextA.close();
});

test('Der eigene Name für einen Chat gewinnt gegen den des Gegenübers', async ({ browser }) => {
  const kontextA = await browser.newContext(HANDY);
  const kontextB = await browser.newContext(HANDY);
  const seiteA = await kontextA.newPage();
  const seiteB = await kontextB.newPage();

  const { link } = await createChat(seiteA, { nick: 'Anton' });
  await joinChat(seiteB, link, { nick: 'Mira' });
  await expect(seiteA.locator('#peer-name')).toHaveText('Mira', { timeout: 20_000 });

  await seiteA.locator('#chat-menu').click();
  await seiteA.getByRole('button', { name: /Chat umbenennen/i }).click();
  await seiteA.locator('#sheet input').fill('Schwester');
  await seiteA.getByRole('button', { name: 'Speichern', exact: true }).click();

  // In der Kopfzeile steht jetzt der eigene Name ...
  await expect(seiteA.locator('#peer-name')).toHaveText('Schwester');
  await seiteA.locator('#chat-back').click();
  // ... in der Übersicht auch, und darunter der echte Name des Gegenübers.
  await expect(namen(seiteA).first()).toHaveText('Schwester');
  await expect(seiteA.locator('#chat-list .chat-list__meta').first()).toContainText('Mira');

  await kontextA.close();
  await kontextB.close();
});
