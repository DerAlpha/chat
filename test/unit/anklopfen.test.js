/**
 * Anklopfen an einem fremden Raum - beide Backends muessen mitzaehlen.
 *
 * Ein Zweierchat nimmt den zweiten auf, der sich ohne Token verbindet. Wer
 * die Raum-ID kennt, kann also versuchen, sich den freien Platz zu nehmen.
 * PHP zaehlte diese Versuche seit jeher (`/join`), Node nicht: dort kommt
 * der Beitritt ueber die WebSocket zustande, und der Weg lag ausserhalb
 * jeder Begrenzung. Beliebig oft anklopfen war umsonst.
 *
 * Wer schon ein Token hat, gehoert zum Raum: dessen Wiederverbinden zaehlt
 * nicht mit, sonst sperrt sich eine wacklige Mobilfunkleitung selbst aus.
 */
process.env.JOIN_ATTEMPTS_PER_HOUR = '3';

import test from 'node:test';
import assert from 'node:assert/strict';

const { withServer, makeRoom, TestClient } = await import('../helpers.js');

const GRENZE = 3;

/** Ein Verbindungsversuch: kam er durch, oder wurde er abgewiesen? */
async function anklopfen(ctx, roomId, token) {
  const client = new TestClient(ctx, roomId, token);
  try {
    await client.opened();
    await client.next('welcome', 2000);
    return 'durch';
  } catch {
    return 'abgewiesen';
  } finally {
    client.close();
  }
}

test('Ohne Token ist das Anklopfen begrenzt', async () => {
  await withServer(async (ctx) => {
    const versuche = [];
    // Jeder Versuch an einem eigenen Raum: es geht um die Adresse, die
    // anklopft, nicht um den Raum, an dem sie es tut.
    for (let i = 0; i < GRENZE + 2; i += 1) {
      versuche.push(await anklopfen(ctx, await makeRoom(ctx), null));
    }
    assert.deepEqual(
      versuche,
      ['durch', 'durch', 'durch', 'abgewiesen', 'abgewiesen'],
      'die Beitrittsversuche werden nicht gezaehlt',
    );
  });
});

test('Wer schon dazugehoert, kommt trotzdem wieder herein', async () => {
  await withServer(async (ctx) => {
    const roomId = await makeRoom(ctx);
    const erster = new TestClient(ctx, roomId, null);
    await erster.opened();
    const willkommen = await erster.next('welcome');
    erster.close();

    // Das Kontingent ohne Token aufbrauchen ...
    for (let i = 0; i < GRENZE + 2; i += 1) await anklopfen(ctx, await makeRoom(ctx), null);

    // ... und mit dem eigenen Token trotzdem zurueckkommen.
    assert.equal(await anklopfen(ctx, roomId, willkommen.you.token), 'durch');
  });
});

/**
 * Das HTTP-Kontingent und das der WebSocket sind derselbe Eimer: zwei
 * getrennte Toepfe waeren zusammen das Doppelte, und dass es zwei Wege in
 * denselben Raum gibt, ist ein Umstand des Servers, nicht der Anfrage.
 */
test('Beide Wege in den Raum teilen sich ein Kontingent', async () => {
  await withServer(async (ctx) => {
    for (let i = 0; i < GRENZE; i += 1) await anklopfen(ctx, await makeRoom(ctx), null);

    const antwort = await fetch(`${ctx.base}/api/slots/${'x'.repeat(22)}/claim`, { method: 'POST' });
    assert.equal(antwort.status, 429, 'die HTTP-Seite zaehlt in einem eigenen Topf');
  });
});

/**
 * Und die Kehrseite: der Header darf nur zaehlen, wenn wirklich eine
 * Zwischenstation davorsteht. Sonst schreibt sich jeder Anrufer bei jedem
 * Versuch eine neue Adresse hinein und die Begrenzung ist keine.
 */
test('Ohne Reverse Proxy zaehlt nur die echte Adresse', async () => {
  await withServer(async (ctx) => {
    const versuche = [];
    for (let i = 0; i < GRENZE + 1; i += 1) {
      const roomId = await makeRoom(ctx);
      const client = new TestClient(ctx, roomId, null, { 'x-forwarded-for': `10.0.0.${i}` });
      try {
        await client.opened();
        await client.next('welcome', 2000);
        versuche.push('durch');
      } catch {
        versuche.push('abgewiesen');
      } finally {
        client.close();
      }
    }
    assert.equal(versuche[GRENZE], 'abgewiesen', 'ein erfundener Header hebelt die Begrenzung aus');
  });
});
