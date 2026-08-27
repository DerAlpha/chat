/**
 * Der Relaisdienst im Betrieb.
 *
 * Getestet wird gegen einen echten UDP-Client, der den Ablauf so durchspielt,
 * wie ein Browser ihn durchspielt: Binding, dann Allocate ohne Anmeldung
 * (Antwort 401 mit Bereich und Nonce), dann Allocate mit Signatur, Erlaubnis
 * erteilen, Daten hin und zurück. Am Ende laufen tatsächlich Bytes zwischen
 * zwei fremden Sockets über den Dienst - alles andere wäre nur Behauptung.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  ATTR, CLASS, METHOD, MessageBuilder, decode, decodeChannelData,
  encodeChannelData, isChannelData, longTermKey,
} from '../../turn/stun.js';
import { makeCredentials } from '../../turn/credentials.js';
import { createTurnServer } from '../../turn/server.js';
import { callSupport } from '../../server/ice.js';

const SECRET = 'ein-geheimnis-das-beide-seiten-kennen';
const REALM = 'fluesterchat-test';

/** Startet einen Dienst auf einem freien Port. */
async function startServer(options = {}) {
  const server = createTurnServer({
    listenPort: 0,
    listenAddress: '127.0.0.1',
    publicAddress: '127.0.0.1',
    realm: REALM,
    secret: SECRET,
    minPort: 41000,
    maxPort: 41999,
    ...options,
  });
  const address = await server.listen();
  return { server, port: address.port };
}

/** Ein UDP-Sprecher mit Warteschlange - Antworten kommen asynchron. */
function udpClient() {
  const socket = dgram.createSocket('udp4');
  const queue = [];
  const waiting = [];
  socket.on('message', (data, rinfo) => {
    const item = { data, rinfo };
    const next = waiting.shift();
    if (next) next(item);
    else queue.push(item);
  });
  const ready = new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    socket,
    ready,
    port: () => socket.address().port,
    send(buffer, port) {
      socket.send(buffer, port, '127.0.0.1');
    },
    receive(timeout = 2000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('nichts empfangen')), timeout);
        waiting.push((item) => { clearTimeout(timer); resolve(item); });
      });
    },
    close() { socket.close(); },
  };
}

/** Der ganze Anmelde-Tanz: erst ohne, dann mit Zugangsdaten. */
async function allocate(client, port, credentials) {
  const erst = new MessageBuilder(METHOD.ALLOCATE, CLASS.REQUEST)
    .addUInt32(ATTR.REQUESTED_TRANSPORT, 17 << 24)
    .build();
  client.send(erst, port);
  const abgelehnt = decode((await client.receive()).data);
  assert.equal(abgelehnt.class, CLASS.ERROR, 'ohne Anmeldung muss abgelehnt werden');
  const fehler = abgelehnt.get(ATTR.ERROR_CODE);
  assert.equal(fehler[2] * 100 + fehler[3], 401);

  const realm = abgelehnt.text(ATTR.REALM);
  const nonce = abgelehnt.text(ATTR.NONCE);
  assert.equal(realm, REALM);
  assert.ok(nonce, 'keine Nonce mitgeschickt');

  const key = longTermKey(credentials.username, realm, credentials.password);
  const zweit = new MessageBuilder(METHOD.ALLOCATE, CLASS.REQUEST)
    .addUInt32(ATTR.REQUESTED_TRANSPORT, 17 << 24)
    .addText(ATTR.USERNAME, credentials.username)
    .addText(ATTR.REALM, realm)
    .addText(ATTR.NONCE, nonce)
    .sign(key)
    .build();
  client.send(zweit, port);
  const antwort = decode((await client.receive()).data);
  return { antwort, key, realm, nonce };
}

async function createPermission(client, port, auth, peerPort) {
  const nachricht = new MessageBuilder(METHOD.CREATE_PERMISSION, CLASS.REQUEST)
    .addXorAddress(ATTR.XOR_PEER_ADDRESS, '127.0.0.1', peerPort)
    .addText(ATTR.USERNAME, auth.username)
    .addText(ATTR.REALM, auth.realm)
    .addText(ATTR.NONCE, auth.nonce)
    .sign(auth.key)
    .build();
  client.send(nachricht, port);
  return decode((await client.receive()).data);
}

// --- STUN ------------------------------------------------------------------

test('Binding verrät dem Gerät seine eigene öffentliche Adresse', async () => {
  const { server, port } = await startServer();
  const client = udpClient();
  await client.ready;
  try {
    client.send(new MessageBuilder(METHOD.BINDING, CLASS.REQUEST).addFingerprint().build(), port);
    const antwort = decode((await client.receive()).data);
    assert.equal(antwort.method, METHOD.BINDING);
    assert.equal(antwort.class, CLASS.SUCCESS);
    const adresse = antwort.getAddress(ATTR.XOR_MAPPED_ADDRESS);
    assert.equal(adresse.address, '127.0.0.1');
    assert.equal(adresse.port, client.port(), 'der gemeldete Port ist nicht der eigene');
  } finally {
    client.close();
    await server.close();
  }
});

// --- Anmeldung -------------------------------------------------------------

test('Ohne Zugangsdaten gibt es keine Zuteilung', async () => {
  const { server, port } = await startServer();
  const client = udpClient();
  await client.ready;
  try {
    const nachricht = new MessageBuilder(METHOD.ALLOCATE, CLASS.REQUEST)
      .addUInt32(ATTR.REQUESTED_TRANSPORT, 17 << 24)
      .build();
    client.send(nachricht, port);
    const antwort = decode((await client.receive()).data);
    assert.equal(antwort.class, CLASS.ERROR);
    assert.equal(server.allocationCount, 0);
  } finally {
    client.close();
    await server.close();
  }
});

test('Abgelaufene Zugangsdaten werden abgewiesen', async () => {
  const { server, port } = await startServer();
  const client = udpClient();
  await client.ready;
  try {
    // Ausgestellt für einen Zeitpunkt, der längst vorbei ist.
    const alt = makeCredentials(SECRET, { ttlSeconds: 60, now: Date.now() - 3600_000 });
    const { antwort } = await allocate(client, port, alt);
    assert.equal(antwort.class, CLASS.ERROR, 'abgelaufen und trotzdem durchgelassen');
    assert.equal(server.allocationCount, 0);
  } finally {
    client.close();
    await server.close();
  }
});

test('Ein erratenes Passwort nützt nichts', async () => {
  const { server, port } = await startServer();
  const client = udpClient();
  await client.ready;
  try {
    const echt = makeCredentials(SECRET, {});
    const gefälscht = { username: echt.username, password: 'ausgedacht' };
    const { antwort } = await allocate(client, port, gefälscht);
    assert.equal(antwort.class, CLASS.ERROR);
    assert.equal(server.allocationCount, 0);
  } finally {
    client.close();
    await server.close();
  }
});

// --- Zuteilung und Weiterleitung -------------------------------------------

test('Mit gültigen Zugangsdaten gibt es einen Relais-Port', async () => {
  const { server, port } = await startServer();
  const client = udpClient();
  await client.ready;
  try {
    const { antwort } = await allocate(client, port, makeCredentials(SECRET, {}));
    assert.equal(antwort.class, CLASS.SUCCESS, 'Zuteilung abgelehnt');
    const relais = antwort.getAddress(ATTR.XOR_RELAYED_ADDRESS);
    assert.ok(relais.port >= 41000 && relais.port <= 41999, `Port ausserhalb des Bereichs: ${relais.port}`);
    assert.equal(antwort.getAddress(ATTR.XOR_MAPPED_ADDRESS).port, client.port());
    assert.ok(antwort.get(ATTR.LIFETIME).readUInt32BE(0) > 0);
    assert.equal(server.allocationCount, 1);
  } finally {
    client.close();
    await server.close();
  }
});

test('Ein Paket geht durch den Dienst - hin und zurück', async () => {
  const { server, port } = await startServer();
  const client = udpClient();
  const gegenstelle = udpClient();
  await Promise.all([client.ready, gegenstelle.ready]);
  try {
    const credentials = makeCredentials(SECRET, {});
    const { antwort, key, realm, nonce } = await allocate(client, port, credentials);
    assert.equal(antwort.class, CLASS.SUCCESS);
    const relais = antwort.getAddress(ATTR.XOR_RELAYED_ADDRESS);
    const auth = { key, realm, nonce, username: credentials.username };

    const erlaubt = await createPermission(client, port, auth, gegenstelle.port());
    assert.equal(erlaubt.class, CLASS.SUCCESS, 'Erlaubnis abgelehnt');

    // Hinweg: der Client schickt über den Dienst an die Gegenstelle.
    const hin = Buffer.from('Ein verschlüsseltes Medienpaket');
    client.send(new MessageBuilder(METHOD.SEND, CLASS.INDICATION)
      .addXorAddress(ATTR.XOR_PEER_ADDRESS, '127.0.0.1', gegenstelle.port())
      .add(ATTR.DATA, hin)
      .build(), port);

    const angekommen = await gegenstelle.receive();
    assert.deepEqual(angekommen.data, hin, 'am Ziel kam etwas anderes an');
    assert.equal(angekommen.rinfo.port, relais.port, 'Absender ist nicht der Relais-Port');

    // Rückweg: die Gegenstelle antwortet an den Relais-Port.
    const zurück = Buffer.from('Und die Antwort darauf');
    gegenstelle.send(zurück, relais.port);
    const daten = decode((await client.receive()).data);
    assert.equal(daten.method, METHOD.DATA);
    assert.equal(daten.class, CLASS.INDICATION);
    assert.deepEqual(daten.get(ATTR.DATA), zurück);
    assert.equal(daten.getAddress(ATTR.XOR_PEER_ADDRESS).port, gegenstelle.port());
  } finally {
    client.close();
    gegenstelle.close();
    await server.close();
  }
});

test('Ohne Erlaubnis reicht der Dienst nichts weiter', async () => {
  const { server, port } = await startServer();
  const client = udpClient();
  const fremd = udpClient();
  await Promise.all([client.ready, fremd.ready]);
  try {
    const credentials = makeCredentials(SECRET, {});
    const { antwort } = await allocate(client, port, credentials);
    const relais = antwort.getAddress(ATTR.XOR_RELAYED_ADDRESS);

    // Senden ohne vorherige Erlaubnis.
    client.send(new MessageBuilder(METHOD.SEND, CLASS.INDICATION)
      .addXorAddress(ATTR.XOR_PEER_ADDRESS, '127.0.0.1', fremd.port())
      .add(ATTR.DATA, Buffer.from('unerlaubt'))
      .build(), port);
    await assert.rejects(() => fremd.receive(400), /nichts empfangen/);

    // Und umgekehrt: unaufgefordert an den Relais-Port geschickt.
    fremd.send(Buffer.from('von aussen'), relais.port);
    await assert.rejects(() => client.receive(400), /nichts empfangen/);
  } finally {
    client.close();
    fremd.close();
    await server.close();
  }
});

test('Über einen gebundenen Kanal läuft es mit kürzerem Kopf', async () => {
  const { server, port } = await startServer();
  const client = udpClient();
  const gegenstelle = udpClient();
  await Promise.all([client.ready, gegenstelle.ready]);
  try {
    const credentials = makeCredentials(SECRET, {});
    const { antwort, key, realm, nonce } = await allocate(client, port, credentials);
    const relais = antwort.getAddress(ATTR.XOR_RELAYED_ADDRESS);

    const kanalNummer = Buffer.alloc(4);
    kanalNummer.writeUInt16BE(0x4001, 0);
    client.send(new MessageBuilder(METHOD.CHANNEL_BIND, CLASS.REQUEST)
      .add(ATTR.CHANNEL_NUMBER, kanalNummer)
      .addXorAddress(ATTR.XOR_PEER_ADDRESS, '127.0.0.1', gegenstelle.port())
      .addText(ATTR.USERNAME, credentials.username)
      .addText(ATTR.REALM, realm)
      .addText(ATTR.NONCE, nonce)
      .sign(key)
      .build(), port);
    const gebunden = decode((await client.receive()).data);
    assert.equal(gebunden.class, CLASS.SUCCESS, 'Kanal nicht gebunden');

    // Hinweg über den Kanal.
    const nutzlast = Buffer.from('Kanaldaten, kurz und schmerzlos');
    client.send(encodeChannelData(0x4001, nutzlast), port);
    assert.deepEqual((await gegenstelle.receive()).data, nutzlast);

    // Rückweg kommt jetzt ebenfalls als Kanaldaten, nicht als Indication.
    gegenstelle.send(nutzlast, relais.port);
    const rück = (await client.receive()).data;
    assert.ok(isChannelData(rück), 'Antwort kam nicht als Kanaldaten');
    const entpackt = decodeChannelData(rück);
    assert.equal(entpackt.channel, 0x4001);
    assert.deepEqual(entpackt.data, nutzlast);
  } finally {
    client.close();
    gegenstelle.close();
    await server.close();
  }
});

// --- Lebensdauer und Grenzen ----------------------------------------------

test('Refresh mit Lebensdauer null gibt den Port wieder frei', async () => {
  const { server, port } = await startServer();
  const client = udpClient();
  await client.ready;
  try {
    const credentials = makeCredentials(SECRET, {});
    const { key, realm, nonce } = await allocate(client, port, credentials);
    assert.equal(server.allocationCount, 1);

    client.send(new MessageBuilder(METHOD.REFRESH, CLASS.REQUEST)
      .addUInt32(ATTR.LIFETIME, 0)
      .addText(ATTR.USERNAME, credentials.username)
      .addText(ATTR.REALM, realm)
      .addText(ATTR.NONCE, nonce)
      .sign(key)
      .build(), port);
    const antwort = decode((await client.receive()).data);
    assert.equal(antwort.class, CLASS.SUCCESS);
    assert.equal(server.allocationCount, 0, 'Zuteilung blieb bestehen');
  } finally {
    client.close();
    await server.close();
  }
});

test('Eine abgelaufene Zuteilung wird von selbst geräumt', async () => {
  let jetzt = Date.now();
  const { server, port } = await startServer({ allocationLifetime: 60, now: () => jetzt });
  const client = udpClient();
  await client.ready;
  try {
    await allocate(client, port, makeCredentials(SECRET, { now: jetzt }));
    assert.equal(server.allocationCount, 1);
    jetzt += 61_000;
    await new Promise((resolve) => setTimeout(resolve, 5200));
    assert.equal(server.allocationCount, 0, 'die Zuteilung blieb hängen');
  } finally {
    client.close();
    await server.close();
  }
});

test('Nur UDP wird weitergereicht', async () => {
  const { server, port } = await startServer();
  const client = udpClient();
  await client.ready;
  try {
    const credentials = makeCredentials(SECRET, {});
    const erst = new MessageBuilder(METHOD.ALLOCATE, CLASS.REQUEST).build();
    client.send(erst, port);
    const abgelehnt = decode((await client.receive()).data);
    const key = longTermKey(credentials.username, REALM, credentials.password);
    // TCP statt UDP anfragen.
    client.send(new MessageBuilder(METHOD.ALLOCATE, CLASS.REQUEST)
      .addUInt32(ATTR.REQUESTED_TRANSPORT, 6 << 24)
      .addText(ATTR.USERNAME, credentials.username)
      .addText(ATTR.REALM, REALM)
      .addText(ATTR.NONCE, abgelehnt.text(ATTR.NONCE))
      .sign(key)
      .build(), port);
    const antwort = decode((await client.receive()).data);
    const fehler = antwort.get(ATTR.ERROR_CODE);
    assert.equal(fehler[2] * 100 + fehler[3], 442, 'TCP wurde nicht abgelehnt');
    assert.equal(server.allocationCount, 0);
  } finally {
    client.close();
    await server.close();
  }
});

test('Mehr Zuteilungen als erlaubt gibt es nicht', async () => {
  const { server, port } = await startServer({ maxAllocationsPerAddress: 2 });
  const clients = [udpClient(), udpClient(), udpClient()];
  await Promise.all(clients.map((c) => c.ready));
  try {
    const ergebnisse = [];
    for (const client of clients) {
      const { antwort } = await allocate(client, port, makeCredentials(SECRET, {}));
      ergebnisse.push(antwort.class);
    }
    assert.deepEqual(ergebnisse, [CLASS.SUCCESS, CLASS.SUCCESS, CLASS.ERROR]);
    assert.equal(server.allocationCount, 2);
  } finally {
    for (const client of clients) client.close();
    await server.close();
  }
});

test('Fremder Verkehr auf dem Port bringt den Dienst nicht durcheinander', async () => {
  const { server, port } = await startServer();
  const client = udpClient();
  await client.ready;
  try {
    for (const müll of ['GET / HTTP/1.1\r\n\r\n', '\x00\x00', 'x'.repeat(600)]) {
      client.send(Buffer.from(müll), port);
    }
    // Danach muss ein ganz normales Binding weiterhin gehen.
    client.send(new MessageBuilder(METHOD.BINDING, CLASS.REQUEST).build(), port);
    const antwort = decode((await client.receive()).data);
    assert.equal(antwort.class, CLASS.SUCCESS);
  } finally {
    client.close();
    await server.close();
  }
});

// --- Zusammenspiel mit dem PHP-Backend ------------------------------------

/**
 * Der Kern des ganzen Aufbaus: der Relaisdienst kann auf lima-city nicht
 * laufen, die Zugangsdaten dafür kann der Webspace aber ausstellen. Beide
 * Seiten rechnen dasselbe aus einem gemeinsamen Geheimnis - ohne je
 * miteinander zu reden. Wenn das auseinanderläuft, kommt niemand mehr durch,
 * und zwar erst im Betrieb.
 */
const phpVorhanden = (() => {
  try {
    execFileSync('php', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('Vom PHP-Backend ausgestellte Zugangsdaten öffnen den Relaisdienst', { skip: phpVorhanden ? false : 'PHP nicht vorhanden' }, async () => {
  const wurzel = path.resolve(import.meta.dirname, '../..');
  const ausgabe = execFileSync('php', ['-r', `
    require ${JSON.stringify(path.join(wurzel, 'php/api/lib/Config.php'))};
    require ${JSON.stringify(path.join(wurzel, 'php/api/lib/Ice.php'))};
    $config = (new ReflectionClass("Config"))->newInstanceWithoutConstructor();
    $config->stunUrls = ["stun:beispiel:3478"];
    $config->turnUrls = ["turn:beispiel:3478?transport=udp"];
    $config->turnSecret = ${JSON.stringify(SECRET)};
    $config->turnTtlSeconds = 3600;
    echo json_encode(Ice::servers($config, "raum1234"));
  `], { encoding: 'utf8' });

  const vomWebspace = JSON.parse(ausgabe);
  const turn = vomWebspace.iceServers.find((eintrag) => Array.isArray(eintrag.urls));
  assert.ok(turn, 'PHP hat keinen Relaisdienst ausgegeben');
  assert.match(turn.username, /^\d+:raum1234$/);

  // Und jetzt damit wirklich anmelden - nicht nur nachrechnen.
  const { server, port } = await startServer();
  const client = udpClient();
  await client.ready;
  try {
    const { antwort } = await allocate(client, port, { username: turn.username, password: turn.credential });
    assert.equal(antwort.class, CLASS.SUCCESS, 'der Dienst hat die PHP-Zugangsdaten abgelehnt');
    assert.equal(server.allocationCount, 1);
  } finally {
    client.close();
    await server.close();
  }
});

test('Ein anderes Geheimnis im Webspace sperrt aus', { skip: phpVorhanden ? false : 'PHP nicht vorhanden' }, async () => {
  const wurzel = path.resolve(import.meta.dirname, '../..');
  const ausgabe = execFileSync('php', ['-r', `
    require ${JSON.stringify(path.join(wurzel, 'php/api/lib/Config.php'))};
    require ${JSON.stringify(path.join(wurzel, 'php/api/lib/Ice.php'))};
    $config = (new ReflectionClass("Config"))->newInstanceWithoutConstructor();
    $config->turnUrls = ["turn:beispiel:3478"];
    $config->turnSecret = "ein-ganz-anderes-geheimnis";
    $config->turnTtlSeconds = 3600;
    echo json_encode(Ice::servers($config, "raum1234"));
  `], { encoding: 'utf8' });
  const turn = JSON.parse(ausgabe).iceServers.find((eintrag) => Array.isArray(eintrag.urls));

  const { server, port } = await startServer();
  const client = udpClient();
  await client.ready;
  try {
    const { antwort } = await allocate(client, port, { username: turn.username, password: turn.credential });
    assert.equal(antwort.class, CLASS.ERROR);
    assert.equal(server.allocationCount, 0);
  } finally {
    client.close();
    await server.close();
  }
});

/** Fragt das PHP-Backend, was es an Anrufmoeglichkeiten meldet. */
function phpSupport(zeilen = '') {
  const wurzel = path.resolve(import.meta.dirname, '../..');
  const ausgabe = execFileSync('php', ['-r', `
    require ${JSON.stringify(path.join(wurzel, 'php/api/lib/Config.php'))};
    require ${JSON.stringify(path.join(wurzel, 'php/api/lib/Ice.php'))};
    $config = (new ReflectionClass("Config"))->newInstanceWithoutConstructor();
    ${zeilen}
    echo json_encode(Ice::support($config));
  `], { encoding: 'utf8' });
  return JSON.parse(ausgabe);
}

/**
 * Anrufe laufen zwischen den Browsern - dafuer muss auf dem Server nichts
 * eingetragen sein. Im selben WLAN funktioniert das sogar voellig ohne
 * Dienste. Angeboten wird die Moeglichkeit deshalb immer; was fehlt, sagt
 * `discovery` und `relay`, damit die App einen ehrlichen Hinweis anzeigen
 * kann, statt die Funktion stillschweigend zu verstecken.
 */
test('Ohne eingetragene Dienste bleiben Anrufe moeglich, aber ohne Adresssuche', { skip: phpVorhanden ? false : 'PHP nicht vorhanden' }, () => {
  assert.deepEqual(phpSupport(), { calls: true, discovery: false, relay: false });
  assert.deepEqual(callSupport({}), { calls: true, discovery: false, relay: false });
});

test('Ein eingetragener STUN-Dienst bringt die Adresssuche, aber kein Relais', { skip: phpVorhanden ? false : 'PHP nicht vorhanden' }, () => {
  const erwartet = { calls: true, discovery: true, relay: false };
  assert.deepEqual(phpSupport('$config->stunUrls = ["stun:beispiel:3478"];'), erwartet);
  assert.deepEqual(callSupport({ stunUrls: ['stun:beispiel:3478'] }), erwartet);
});

test('Erst ein Relaisdienst mit Geheimnis zaehlt als Relais - in beiden Backends', { skip: phpVorhanden ? false : 'PHP nicht vorhanden' }, () => {
  // Adresse ohne Geheimnis nuetzt nichts: ausstellen liesse sich damit nichts.
  const halb = { calls: true, discovery: false, relay: false };
  assert.deepEqual(phpSupport('$config->turnUrls = ["turn:beispiel:3478"];'), halb);
  assert.deepEqual(callSupport({ turnUrls: ['turn:beispiel:3478'] }), halb);

  const ganz = { calls: true, discovery: true, relay: true };
  assert.deepEqual(
    phpSupport('$config->turnUrls = ["turn:beispiel:3478"]; $config->turnSecret = "geheim";'),
    ganz,
  );
  assert.deepEqual(callSupport({ turnUrls: ['turn:beispiel:3478'], turnSecret: 'geheim' }), ganz);
});
