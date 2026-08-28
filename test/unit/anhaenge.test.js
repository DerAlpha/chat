/**
 * Was mit Anhaengen passiert, wenn niemand mehr auf sie zeigt.
 *
 * Ein Anhang wird zuerst hochgeladen und erst mit der naechsten Nachricht
 * beansprucht. Zwei Wege fuehren dazu, dass am Ende keine Nachricht mehr auf
 * ihn zeigt, und auf beiden blieb er im PHP-Backend liegen - Datei auf der
 * Platte, Groesse weiter auf dem Kontingent des Raums:
 *
 *   1. Die Obergrenze verdraengt die aelteste Nachricht.
 *   2. Der Upload wird nie gesendet (Fenster zu, Verbindung weg).
 *
 * Node raeumte beides von Anfang an weg. Geprueft wird deshalb gegen BEIDE
 * Backends mit demselben Ablauf: der Browser kennt den Unterschied nicht.
 */
process.env.MAX_MESSAGES_PER_ROOM = '3';

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { phpVorhanden, withPhp } from '../php-server.js';

const { withServer, TestClient, b64 } = await import('../helpers.js');

const WURZEL = path.resolve(import.meta.dirname, '../..');
const OBERGRENZE = 3;

let zaehler = 0;
const frisch = (was) => (`${was}${(zaehler += 1)}${'x'.repeat(22)}`).slice(0, 22);

/** Der PHP-Server mit derselben Obergrenze wie Node. */
const mitPhp = (fn) => withPhp({ config: { maxMessagesPerRoom: OBERGRENZE } }, fn);

const hochladen = (base, roomId, token, rumpf) =>
  fetch(`${base}/api/rooms/${roomId}/blobs`, {
    method: 'POST',
    headers: { 'x-room-token': token, 'content-type': 'application/octet-stream' },
    body: rumpf,
  }).then((a) => a.json());

const abrufen = (base, roomId, token, blobId) =>
  fetch(`${base}/api/rooms/${roomId}/blobs/${blobId}`, { headers: { 'x-room-token': token } })
    .then((a) => a.status);

/**
 * Derselbe Ablauf fuer beide Backends. `sende` ist das einzige Stueck, das
 * sich unterscheidet: Node schickt Frames ueber die WebSocket, PHP ueber
 * einen Aufruf.
 *
 * @param {{base: string, roomId: string, token: string,
 *          sende: (ct: string, blobs?: string[]) => Promise<void>}} umgebung
 */
async function ablauf({ base, roomId, token, sende }) {
  // 1. Ein Anhang, der an eine Nachricht kommt - und dann verdraengt wird.
  const anhang = await hochladen(base, roomId, token, Buffer.from('so-tun-als-waere-das-ein-bild'));
  await sende(b64('mit anhang'), [anhang.id]);
  const gleichNochDa = await abrufen(base, roomId, token, anhang.id);

  // Genug Nachrichten, um die erste ueber die Obergrenze zu schieben.
  for (let i = 0; i < OBERGRENZE; i += 1) await sende(b64(`fueller ${i}`));
  const nachVerdraengung = await abrufen(base, roomId, token, anhang.id);

  // 2. Ein Anhang, der noch auf seine Nachricht wartet: bleibt liegen - erst
  //    nach einer halben Stunde ist klar, dass keine mehr kommt. Der zweite
  //    Upload ist der eigentliche Pruefstein: er loest das Aufraeumen aus,
  //    und wer dabei die Altersgrenze vergisst, reisst dem, der drei Bilder
  //    fuer eine Nachricht auswaehlt, die ersten beiden weg.
  const wartet = await hochladen(base, roomId, token, Buffer.from('noch-nicht-gesendet'));
  const zweiter = await hochladen(base, roomId, token, Buffer.from('zweites-bild'));
  const wartetNochDa = await abrufen(base, roomId, token, wartet.id);

  // Und beide gehoeren dann auch wirklich zusammen an eine Nachricht.
  await sende(b64('zwei bilder'), [wartet.id, zweiter.id]);
  const beideGebunden = await abrufen(base, roomId, token, wartet.id);

  return { gleichNochDa, nachVerdraengung, wartetNochDa, beideGebunden };
}

async function gegenNode() {
  return withServer(async (ctx) => {
    const roomId = frisch('raum');
    const platz = frisch('platz');
    const angelegt = await fetch(`${ctx.base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, slots: [{ id: platz, wrapped: 'paket' }] }),
    }).then((a) => a.json());

    const client = await new TestClient(ctx, roomId, angelegt.you.token).opened();
    await client.next('welcome');
    let nummer = 0;
    const sende = async (ct, blobs) => {
      const cid = `c${(nummer += 1)}`;
      client.send({ t: 'msg', cid, ct, ...(blobs ? { blobs } : {}) });
      await client.next('ack');
    };
    try {
      return await ablauf({ base: ctx.base, roomId, token: angelegt.you.token, sende });
    } finally {
      client.close();
    }
  });
}

async function gegenPhp() {
  return mitPhp(async ({ base }) => {
    const roomId = frisch('raum');
    const platz = frisch('platz');
    const angelegt = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, slots: [{ id: platz, wrapped: 'paket' }] }),
    }).then((a) => a.json());
    const token = angelegt.you.token;

    let nummer = 0;
    const sende = async (ct, blobs) => {
      const antwort = await fetch(`${base}/api/rooms/${roomId}/frames`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-room-token': token },
        body: JSON.stringify({ frames: [{ t: 'msg', cid: `c${(nummer += 1)}`, ct, ...(blobs ? { blobs } : {}) }] }),
      });
      const rumpf = await antwort.json();
      const fehler = (rumpf.direct ?? []).find((f) => f.t === 'err');
      assert.ok(!fehler, `PHP lehnte die Nachricht ab: ${JSON.stringify(fehler)}`);
    };
    return ablauf({ base, roomId, token, sende });
  });
}

const erwartet = {
  gleichNochDa: 200,
  // Verdraengt heisst weg - Datei und Kontingent.
  nachVerdraengung: 404,
  // Noch keine halbe Stunde alt: der darf nicht angefasst werden.
  wartetNochDa: 200,
  beideGebunden: 200,
};

test('Node gibt Anhaenge verdraengter Nachrichten frei', async () => {
  assert.deepEqual(await gegenNode(), erwartet);
});

test('PHP macht es genauso', { skip: phpVorhanden ? false : 'PHP nicht vorhanden' }, async () => {
  assert.deepEqual(await gegenPhp(), erwartet);
});

/**
 * Der zweite Weg braucht Zeit, die im Test niemand hat: deshalb hier direkt
 * am Speicher, mit der Altersgrenze als Stellschraube.
 */
test('PHP raeumt verwaiste Uploads weg, sobald sie alt genug sind', { skip: phpVorhanden ? false : 'PHP nicht vorhanden' }, async () => {
  await mitPhp(async ({ base, dataDir }) => {
    const roomId = frisch('raum');
    const platz = frisch('platz');
    const angelegt = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, slots: [{ id: platz, wrapped: 'paket' }] }),
    }).then((a) => a.json());
    const token = angelegt.you.token;

    const gebunden = await hochladen(base, roomId, token, Buffer.from('gehoert-zu-einer-nachricht'));
    await fetch(`${base}/api/rooms/${roomId}/frames`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-room-token': token },
      body: JSON.stringify({ frames: [{ t: 'msg', cid: 'a', ct: b64('bild'), blobs: [gebunden.id] }] }),
    });
    const verwaist = await hochladen(base, roomId, token, Buffer.from('nie-gesendet'));

    // Der Kehrbesen laeuft mit dem naechsten Upload - mit einer Altersgrenze
    // von null Sekunden greift er sofort.
    const ergebnis = execFileSync('php', ['-r', `
      $wurzel = ${JSON.stringify(path.join(WURZEL, 'php/api/lib'))};
      require $wurzel . '/Http.php';
      require $wurzel . '/Config.php';
      require $wurzel . '/Store.php';
      $config = new Config();
      $config->dataDir = ${JSON.stringify(dataDir)};
      $store = new Store($config);
      $room = $store->loadRoom(${JSON.stringify(roomId)});
      $vorher = count($room['blobs']);
      $room = $store->sweepOrphanBlobs(${JSON.stringify(roomId)}, $room, 0);
      echo json_encode(['vorher' => $vorher, 'nachher' => count($room['blobs']),
                        'bytes' => $room['blobBytes'],
                        'gebundenDa' => is_file($store->blobPath(${JSON.stringify(roomId)}, ${JSON.stringify(gebunden.id)})),
                        'verwaistDa' => is_file($store->blobPath(${JSON.stringify(roomId)}, ${JSON.stringify(verwaist.id)}))]);
    `], { encoding: 'utf8' });

    assert.deepEqual(JSON.parse(ergebnis), {
      vorher: 2,
      nachher: 1,
      // Nur noch der gebundene Anhang zaehlt aufs Kontingent.
      bytes: Buffer.byteLength('gehoert-zu-einer-nachricht'),
      gebundenDa: true,
      verwaistDa: false,
    });
  });
});
