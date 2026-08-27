/**
 * Der eigene Relaisdienst gegen den echten WebRTC-Stack des Browsers.
 *
 * Alles andere - Unit-Tests, nachgebaute Clients - prüft nur, ob der Dienst
 * das tut, was ich für richtig halte. Erst hier zeigt sich, ob Chromium das
 * genauso sieht. iceTransportPolicy 'relay' verbietet dem Browser jeden
 * direkten Weg: was ankommt, ist durch den Dienst gelaufen oder gar nicht.
 */
import { test, expect } from './fixtures.js';
import { createTurnServer } from '../../turn/server.js';
import { makeCredentials } from '../../turn/credentials.js';

const SECRET = 'test-geheimnis-fuer-den-relaisdienst';

async function mitDienst(fn, options = {}) {
  const server = createTurnServer({
    listenPort: 0,
    listenAddress: '127.0.0.1',
    publicAddress: '127.0.0.1',
    realm: 'fluesterchat',
    secret: SECRET,
    minPort: 42300,
    maxPort: 42599,
    ...options,
  });
  const { port } = await server.listen();
  try {
    return await fn(server, port);
  } finally {
    await server.close();
  }
}

/** Baut zwei Verbindungen im Browser auf und schickt eine Nachricht durch. */
const verbinde = async ({ port, username, credential, policy }) => {
  const iceServers = [{ urls: `turn:127.0.0.1:${port}?transport=udp`, username, credential }];
  const opts = { iceServers, iceTransportPolicy: policy };
  const a = new RTCPeerConnection(opts);
  const b = new RTCPeerConnection(opts);
  const aufräumen = () => { a.close(); b.close(); };
  try {
    a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate); };
    b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate); };

    const kanal = a.createDataChannel('probe');
    const empfangen = new Promise((resolve) => {
      b.ondatachannel = (e) => { e.channel.onmessage = (m) => resolve(m.data); };
    });
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ICE blieb bei ${a.iceConnectionState}`)), 20000);
      const prüfen = () => {
        if (['connected', 'completed'].includes(a.iceConnectionState)) { clearTimeout(timer); resolve(); }
        if (a.iceConnectionState === 'failed') { clearTimeout(timer); reject(new Error('ICE gescheitert')); }
      };
      a.oniceconnectionstatechange = prüfen;
      prüfen();
    });
    await new Promise((resolve) => { kanal.onopen = resolve; if (kanal.readyState === 'open') resolve(); });
    kanal.send('Hallo durch das Relais');
    const nachricht = await Promise.race([
      empfangen,
      new Promise((_, reject) => setTimeout(() => reject(new Error('keine Daten')), 8000)),
    ]);

    let paar = null;
    const stats = await a.getStats();
    stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') paar = s; });
    let lokal = null;
    if (paar) stats.forEach((s) => { if (s.id === paar.localCandidateId) lokal = s; });
    return { nachricht, typ: lokal?.candidateType ?? null, protokoll: lokal?.protocol ?? null };
  } finally {
    aufräumen();
  }
};

test('Ein Anruf läuft durch den eigenen Relaisdienst', async ({ page }) => {
  await page.goto('./');
  await mitDienst(async (server, port) => {
    const creds = makeCredentials(SECRET, { label: 'test' });
    const ergebnis = await page.evaluate(verbinde, {
      port, username: creds.username, credential: creds.password, policy: 'relay',
    });

    expect(ergebnis.nachricht).toBe('Hallo durch das Relais');
    // Das ist der Kern: der Browser hat einen Relais-Kandidaten gewählt, also
    // lief der ganze Verkehr - DTLS-Handschlag inklusive - durch den Dienst.
    expect(ergebnis.typ).toBe('relay');
    expect(ergebnis.protokoll).toBe('udp');
    // Beim Auflegen gibt der Browser die Zuteilungen sofort wieder frei -
    // gezählt wird deshalb, was insgesamt vergeben wurde.
    expect(server.allocationsTotal).toBeGreaterThanOrEqual(2);
    expect(server.bytesRelayed).toBeGreaterThan(0);
  });
});

test('Der Browser kommt mit falschen Zugangsdaten nicht durch', async ({ page }) => {
  await page.goto('./');
  await mitDienst(async (server, port) => {
    const echt = makeCredentials(SECRET, { label: 'test' });
    await expect(page.evaluate(verbinde, {
      port, username: echt.username, credential: 'ausgedacht', policy: 'relay',
    })).rejects.toThrow(/ICE/);
    expect(server.allocationsTotal).toBe(0);
  });
});

test('Ohne Relaiszwang findet der Browser den direkten Weg', async ({ page }) => {
  // Gegenprobe zum ersten Test: dieselbe Aufstellung, nur ohne Zwang. Dann
  // darf und soll der Dienst gar nicht gebraucht werden.
  await page.goto('./');
  await mitDienst(async (server, port) => {
    const creds = makeCredentials(SECRET, { label: 'test' });
    const ergebnis = await page.evaluate(verbinde, {
      port, username: creds.username, credential: creds.password, policy: 'all',
    });
    expect(ergebnis.nachricht).toBe('Hallo durch das Relais');
    // Welchen der direkten Wege der Browser nimmt, entscheidet ein Wettlauf:
    // "host" ist die lokale Adresse, "srflx" die, die er über den eigenen
    // STUN-Dienst erfahren hat. Beides ist richtig - "relay" wäre falsch,
    // denn ohne Zwang soll der Umweg gar nicht erst genommen werden.
    expect(['host', 'srflx']).toContain(ergebnis.typ);
    expect(server.allocationsTotal).toBe(0);
  });
});
