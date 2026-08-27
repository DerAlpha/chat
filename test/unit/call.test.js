/**
 * Anrufe: Ablauf, Prüfzeichen und die unangenehmen Fälle.
 *
 * WebRTC selbst gibt es in Node nicht. Getestet wird deshalb gegen einen
 * Nachbau, der sich beim Aushandeln so verhält wie ein Browser: aus "stabil"
 * wird ein Angebot, auf ein fremdes Angebot folgt eine Antwort, und wer
 * beides hat, ist verbunden. Damit lässt sich das prüfen, worauf es
 * ankommt - dass zwei Sitzungen, die nur über verschlüsselte Pakete
 * miteinander reden, verlässlich zusammenfinden und dabei beide dieselben
 * Prüfzeichen sehen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CallSession, CONNECT_TIMEOUT, RING_TIMEOUT, SIGNAL_VERSION, WORKER_TIMEOUT,
  fingerprintsOf, safetyCode,
} from '../../public/js/call.js';

// ---------------------------------------------------------------- Nachbau

class FakeTrack {
  constructor(kind, id) {
    this.kind = kind;
    this.id = id;
    this.enabled = true;
    this.stopped = false;
    this.facingMode = 'user';
  }

  stop() { this.stopped = true; }
  getSettings() { return { facingMode: this.facingMode }; }
}

class FakeStream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  getTrackById(id) { return this.tracks.find((track) => track.id === id) ?? null; }
  addTrack(track) { if (!this.tracks.includes(track)) this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter((entry) => entry !== track); }
}

let laufendeNummer = 0;

/** Erzeugt eine Beschreibung mit einem eigenen Fingerabdruck je Gegenstelle. */
const sdpText = (typ, fingerabdruck) => [
  'v=0',
  'o=- 1 1 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  `a=fingerprint:sha-256 ${fingerabdruck}`,
  `a=setup:${typ === 'offer' ? 'actpass' : 'active'}`,
  '',
].join('\r\n');

class FakePeerConnection {
  constructor(config) {
    this.config = config;
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.senders = [];
    this.receivers = [];
    this.transceivers = [];
    this.candidates = [];
    this.closed = false;
    laufendeNummer += 1;
    this.fingerprint = String(laufendeNummer).padStart(2, '0').repeat(32).slice(0, 95).toUpperCase();
    FakePeerConnection.alle.push(this);
  }

  addTrack(track, stream) {
    const sender = { track, stream, replaceTrack: async (next) => { sender.track = next; } };
    // Wie im Browser: zu jedem Sender gehört ein Empfänger im selben Platz.
    const receiver = { track: null };
    this.senders.push(sender);
    this.receivers.push(receiver);
    this.transceivers.push({ sender, receiver, direction: 'sendrecv' });
    this.scheduleNegotiation();
    return sender;
  }

  addTransceiver(kind, { direction } = {}) {
    const sender = { track: null, replaceTrack: async (next) => { sender.track = next; } };
    const receiver = { track: new FakeTrack(kind, `r${kind}`) };
    const transceiver = { sender, receiver, direction: direction ?? 'sendrecv' };
    this.senders.push(sender);
    this.receivers.push(receiver);
    this.transceivers.push(transceiver);
    return transceiver;
  }

  getSenders() { return [...this.senders]; }
  getReceivers() { return [...this.receivers]; }
  getTransceivers() { return [...this.transceivers]; }

  scheduleNegotiation() {
    if (this.negotiationQueued) return;
    this.negotiationQueued = true;
    queueMicrotask(() => {
      this.negotiationQueued = false;
      this.onnegotiationneeded?.();
    });
  }

  async setLocalDescription(description) {
    const type = description?.type ?? (this.signalingState === 'stable' ? 'offer' : 'answer');
    this.localDescription = { type, sdp: sdpText(type, this.fingerprint) };
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
    // Ein Kandidat, sobald es etwas zu verschicken gibt.
    queueMicrotask(() => this.onicecandidate?.({ candidate: { candidate: `cand-${this.fingerprint.slice(0, 4)}`, toJSON() { return { candidate: this.candidate }; } } }));
    this.maybeConnect();
  }

  async setRemoteDescription(description) {
    this.remoteDescription = { type: description.type, sdp: description.sdp };
    // Wie im Browser: ein fremdes Angebot rollt ein eigenes stillschweigend zurück.
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    if (description.type === 'answer') this.maybeConnect();
  }

  async addIceCandidate(candidate) { this.candidates.push(candidate); }

  maybeConnect() {
    if (!this.localDescription || !this.remoteDescription) return;
    if (this.connectionState === 'connected') return;
    queueMicrotask(() => {
      if (this.closed) return;
      this.connectionState = 'connected';
      this.onconnectionstatechange?.();
      // Der Browser meldet die Spuren der Gegenstelle - hier eine reicht.
      this.ontrack?.({ streams: [new FakeStream([new FakeTrack('audio', `fern-${this.fingerprint.slice(0, 4)}`)])], track: null });
    });
  }

  async getStats() { return new Map(); }

  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }
}
FakePeerConnection.alle = [];

/** Mikrofon und Kamera, die es immer gibt. */
const fakeMedia = {
  calls: [],
  async getUserMedia(constraints) {
    fakeMedia.calls.push(constraints);
    const tracks = [new FakeTrack('audio', `a${fakeMedia.calls.length}`)];
    if (constraints.video) tracks.push(new FakeTrack('video', `v${fakeMedia.calls.length}`));
    return new FakeStream(tracks);
  },
};

/** Ein Mikrofon, das der Nutzer verweigert. */
const verweigerndesMedia = {
  async getUserMedia() {
    const fehler = new Error('nope');
    fehler.name = 'NotAllowedError';
    throw fehler;
  },
};

/**
 * Der Faden für die zweite Schicht - hier ein Briefkasten, der wie der echte
 * "bereit" zurückmeldet, sobald er den Schlüssel hat. `FakeWorker.antwort`
 * schaltet das um: 'stumm' meldet nie etwas zurück (dann darf die zweite
 * Schicht nicht vereinbart werden), 'kaputt' meldet einen Fehler.
 */
class FakeWorker {
  constructor(url, options) {
    this.url = String(url);
    this.options = options;
    this.posts = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    FakeWorker.alle.push(this);
  }

  postMessage(message) {
    this.posts.push(message);
    if (FakeWorker.antwort === 'stumm') return;
    queueMicrotask(() => {
      if (FakeWorker.antwort === 'kaputt') this.onerror?.(new Error('kaputt'));
      else this.onmessage?.({ data: { type: 'ready' } });
    });
  }

  terminate() { this.terminated = true; }
}
FakeWorker.alle = [];
FakeWorker.antwort = 'bereit';

class FakeScriptTransform {
  constructor(worker, options) {
    this.worker = worker;
    this.options = options;
  }
}

globalThis.RTCPeerConnection = FakePeerConnection;
globalThis.MediaStream = FakeStream;
globalThis.Worker = FakeWorker;
globalThis.RTCRtpScriptTransform = FakeScriptTransform;
globalThis.RTCRtpSender = { getCapabilities: () => ({ codecs: [] }) };

/** Wartet, bis alle angestossenen Mikrotasks und Timer durch sind. */
const ruhe = async (runden = 30) => {
  for (let i = 0; i < runden; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Zwei Sitzungen, die nur über Signalpakete miteinander reden - so wie im
 * Betrieb über den verschlüsselten Kanal.
 */
function paar({ media = fakeMedia, salt = 'raum-1', relayOnly = false, roomKey = null } = {}) {
  const zustand = { a: null, b: null };
  const protokoll = [];
  const a = new CallSession({
    salt,
    relayOnly,
    media,
    roomKey,
    send: (payload) => { protokoll.push(['a', payload.k]); void b.receive(structuredClone(payload)); },
    ice: async () => ({ iceServers: [] }),
    onChange: (state) => { zustand.a = state; },
  });
  const b = new CallSession({
    salt,
    relayOnly,
    media,
    roomKey,
    send: (payload) => { protokoll.push(['b', payload.k]); void a.receive(structuredClone(payload)); },
    ice: async () => ({ iceServers: [] }),
    onChange: (state) => { zustand.b = state; },
  });
  return { a, b, zustand, protokoll };
}

// ----------------------------------------------------------- Fingerabdruck

test('Fingerabdrücke werden aus der Beschreibung gelesen', () => {
  const sdp = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\nm=audio 9\r\na=fingerprint:sha-256 AA:BB:CC\r\n';
  assert.deepEqual(fingerprintsOf(sdp), ['sha-256 AA:BB:CC']);
});

test('Ohne Fingerabdruck gibt es keine Prüfzeichen', async () => {
  assert.equal(await safetyCode('v=0\r\n', 'v=0\r\n', 'raum'), '');
});

test('Beide Seiten rechnen dieselben Prüfzeichen aus', async () => {
  const meins = 'a=fingerprint:sha-256 AA:11\r\n';
  const deins = 'a=fingerprint:sha-256 BB:22\r\n';
  const hier = await safetyCode(meins, deins, 'raum-x');
  const dort = await safetyCode(deins, meins, 'raum-x');
  assert.equal(hier, dort);
  assert.equal([...hier].length >= 4, true, 'vier Zeichen erwartet');
});

test('Ein anderer Raum ergibt andere Prüfzeichen - trotz gleicher Schlüssel', async () => {
  const meins = 'a=fingerprint:sha-256 AA:11\r\n';
  const deins = 'a=fingerprint:sha-256 BB:22\r\n';
  assert.notEqual(await safetyCode(meins, deins, 'raum-x'), await safetyCode(meins, deins, 'raum-y'));
});

test('Ein ausgetauschter Fingerabdruck ändert die Prüfzeichen', async () => {
  const meins = 'a=fingerprint:sha-256 AA:11\r\n';
  const echt = 'a=fingerprint:sha-256 BB:22\r\n';
  const untergeschoben = 'a=fingerprint:sha-256 CC:33\r\n';
  assert.notEqual(await safetyCode(meins, echt, 'raum'), await safetyCode(meins, untergeschoben, 'raum'));
});

// -------------------------------------------------------------- Der Ablauf

test('Ein angenommener Anruf kommt auf beiden Seiten zustande', async () => {
  const { a, b, zustand } = paar();
  await a.invite('audio');
  await ruhe();

  assert.equal(b.state, 'ringing', 'es hätte klingeln müssen');
  assert.equal(zustand.b.incoming, true);
  assert.equal(zustand.b.kind, 'audio');

  await b.accept();
  await ruhe();

  assert.equal(a.state, 'active');
  assert.equal(b.state, 'active');
  a.hangUp();
  b.finish('hangup');
});

test('Beide sehen am Ende dieselben Prüfzeichen', async () => {
  const { a, b } = paar({ salt: 'raum-pruef' });
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();

  assert.notEqual(a.safety, '', 'ohne Prüfzeichen wäre die Absicherung wertlos');
  assert.equal(a.safety, b.safety);
  a.hangUp();
  b.finish('hangup');
});

test('Ein Videoanruf fragt auch nach der Kamera, ein Sprachanruf nicht', async () => {
  fakeMedia.calls.length = 0;
  const { a, b } = paar();
  await a.invite('video');
  await ruhe();
  assert.equal(fakeMedia.calls.at(-1).video !== false, true);
  a.hangUp();
  b.finish('hangup');

  fakeMedia.calls.length = 0;
  const zweites = paar();
  await zweites.a.invite('audio');
  await ruhe();
  assert.equal(fakeMedia.calls.at(-1).video, false);
  zweites.a.hangUp();
  zweites.b.finish('hangup');
});

test('Abgelehnt heisst abgelehnt - der Anrufer erfährt den Grund', async () => {
  const { a, b } = paar();
  await a.invite('audio');
  await ruhe();
  b.hangUp('declined');
  await ruhe();

  assert.equal(a.state, 'ended');
  assert.equal(a.endReason, 'declined');
  assert.equal(b.state, 'ended');
});

test('Auflegen beendet auch die Gegenseite', async () => {
  const { a, b } = paar();
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();

  a.hangUp('hangup');
  await ruhe();
  assert.equal(b.state, 'ended');
  assert.equal(b.endReason, 'remote_hangup');
});

test('Aufgelegte Anrufe geben Mikrofon und Kamera wieder frei', async () => {
  const { a, b } = paar();
  await a.invite('video');
  await ruhe();
  const spuren = a.localStream.getTracks();
  assert.equal(spuren.length, 2);
  a.hangUp();
  assert.equal(spuren.every((spur) => spur.stopped), true, 'die Kamera lief weiter');
  b.finish('hangup');
});

test('Wer schon telefoniert, wird nicht gestört - der zweite Anrufer hört das', async () => {
  const { a, b } = paar();
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();

  // Ein Dritter klopft an, während das Gespräch läuft.
  let antwort = null;
  await b.receive({ v: SIGNAL_VERSION, c: 'fremder-anruf', k: 'ring', kind: 'audio' });
  // Die Absage geht über denselben Kanal - hier sichtbar als eigenes Signal.
  assert.equal(b.state, 'active', 'das laufende Gespräch wurde zerschossen');
  assert.equal(a.state, 'active');

  // Und derselbe Fall aus Sicht des Signals: es kommt ein "bye" mit Grund.
  const einsam = new CallSession({
    send: (payload) => { antwort = payload; },
    ice: async () => ({ iceServers: [] }),
    onChange: () => {},
    media: fakeMedia,
  });
  await einsam.invite('audio');
  await ruhe();
  await einsam.receive({ v: SIGNAL_VERSION, c: 'noch-einer', k: 'ring', kind: 'audio' });
  assert.equal(antwort.k, 'bye');
  assert.equal(antwort.why, 'busy');
  einsam.hangUp();
  a.hangUp();
  b.finish('hangup');
});

test('Signale aus einem fremden Anruf werden ignoriert', async () => {
  const { a, b } = paar();
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();

  await a.receive({ v: SIGNAL_VERSION, c: 'ganz-woanders', k: 'bye', why: 'hangup' });
  assert.equal(a.state, 'active', 'ein fremdes Signal hat den Anruf beendet');
  a.hangUp();
  b.finish('hangup');
});

test('Eine unbekannte Fassung des Formats wird verworfen', async () => {
  const { a } = paar();
  await a.receive({ v: SIGNAL_VERSION + 1, c: 'x', k: 'ring', kind: 'audio' });
  assert.equal(a.state, 'idle');
});

test('Ohne Freigabe für das Mikrofon endet der Anruf mit klarem Grund', async () => {
  const { a } = paar({ media: verweigerndesMedia });
  await assert.rejects(() => a.invite('audio'));
  assert.equal(a.state, 'ended');
  assert.equal(a.endReason, 'no_permission');
});

test('Stummschalten schaltet die Tonspur ab, nicht den Anruf', async () => {
  const { a, b } = paar();
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();

  assert.equal(a.toggleMute(), true);
  assert.equal(a.localStream.getAudioTracks().every((spur) => spur.enabled === false), true);
  assert.equal(a.state, 'active');
  assert.equal(a.toggleMute(), false);
  assert.equal(a.localStream.getAudioTracks().every((spur) => spur.enabled === true), true);
  a.hangUp();
  b.finish('hangup');
});

test('Die Kamera lässt sich in einem laufenden Sprachanruf zuschalten', async () => {
  const { a, b } = paar();
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();
  assert.equal(a.localStream.getVideoTracks().length, 0);

  assert.equal(await a.addCamera(), true);
  assert.equal(a.localStream.getVideoTracks().length, 1);
  assert.equal(a.kind, 'video');
  a.hangUp();
  b.finish('hangup');
});

test('"Nur über das Relais" landet in der Einstellung der Verbindung', async () => {
  const { a, b } = paar({ relayOnly: true });
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();
  assert.equal(a.pc.config.iceTransportPolicy, 'relay');
  a.hangUp();
  b.finish('hangup');
});

test('Ohne "nur über das Relais" bleibt der direkte Weg erlaubt', async () => {
  const { a, b } = paar();
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();
  assert.equal(a.pc.config.iceTransportPolicy, 'all');
  a.hangUp();
  b.finish('hangup');
});

test('Adresskandidaten vor der Beschreibung gehen nicht verloren', async () => {
  const { a, b } = paar();
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();
  // Beide Seiten haben Kandidaten des jeweils anderen eingespielt.
  assert.equal(a.pc.candidates.length > 0, true);
  assert.equal(b.pc.candidates.length > 0, true);
  a.hangUp();
  b.finish('hangup');
});

/**
 * Die erste Runde macht allein der Anrufer. Machten beide gleichzeitig ein
 * Angebot, löste sich das zwar auf - aber es kostet eine Runde, und genau
 * dort bleibt ein Anruf gern hängen.
 */
test('Beim Aufbau macht nur der Anrufer ein Angebot', async () => {
  const { a, b, protokoll } = paar();
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();

  assert.equal(a.state, 'active');
  const angebote = protokoll.filter(([, art]) => art === 'sdp');
  // Genau zwei Beschreibungen: ein Angebot von A, eine Antwort von B.
  assert.equal(angebote.length, 2);
  assert.deepEqual(angebote.map(([wer]) => wer), ['a', 'b']);
  a.hangUp();
  b.finish('hangup');
});

// -------------------------------------------- Zweite Schicht über den Strom

const RAUMSCHLUESSEL = new Uint8Array(32).fill(3);

const arten = (endpunkte) => endpunkte.map((e) => e.transform?.options?.operation ?? null);

test('Ohne Schlüssel gibt es keine zweite Schicht', async () => {
  const { a, b } = paar();
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();
  assert.equal(a.doubleEncrypted, false);
  assert.equal(b.doubleEncrypted, false);
  a.hangUp();
  b.finish('hangup');
});

test('Mit Schlüssel einigen sich beide auf die zweite Schicht', async () => {
  const { a, b } = paar({ roomKey: RAUMSCHLUESSEL });
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();
  assert.equal(a.doubleEncrypted, true);
  assert.equal(b.doubleEncrypted, true);
  a.hangUp();
  b.finish('hangup');
});

test('Kann die Gegenstelle sie nicht, verzichten beide - statt Rauschen zu schicken', async () => {
  const { a, b } = paar({ roomKey: RAUMSCHLUESSEL });
  // Ein Anruf von einer Gegenstelle, die die zweite Schicht nicht anbietet.
  await b.receive({ v: SIGNAL_VERSION, c: 'alter-anruf', k: 'ring', kind: 'audio', m: false });
  await b.accept();
  await ruhe();
  assert.equal(b.doubleEncrypted, false);
  b.finish('hangup');
  a.reset();
});

test('Beide Fäden bekommen denselben Schlüssel und dieselbe Anrufkennung', async () => {
  FakeWorker.alle.length = 0;
  const { a, b } = paar({ roomKey: RAUMSCHLUESSEL });
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();

  const posts = FakeWorker.alle.map((w) => w.posts[0]);
  assert.equal(posts.length, 2, 'jede Seite braucht ihren eigenen Faden');
  // Und zwar die Kennung dieses Anrufs, nicht irgendeine feste: sonst
  // benutzten zwei Gespräche im selben Chat denselben Schlüssel.
  assert.equal(posts[0].callId, a.callId);
  assert.equal(posts[1].callId, a.callId);
  assert.deepEqual(new Uint8Array(posts[0].room), new Uint8Array(posts[1].room));
  assert.deepEqual(new Uint8Array(posts[0].room), RAUMSCHLUESSEL);
  a.hangUp();
  b.finish('hangup');
});

/**
 * Ein Faden, der sich nicht meldet, darf nicht vereinbart werden. Sonst
 * schickte diese Seite verschlüsselt, was die andere nie aufmachen kann -
 * und der Anruf wäre stumm und schwarz, ohne dass jemand wüsste, warum.
 */
test('Meldet sich der Faden nicht, wird ohne zweite Schicht telefoniert', async () => {
  const uhr = steuerbareZeit();
  FakeWorker.antwort = 'stumm';
  try {
    const gesendet = [];
    const a = new CallSession({
      send: (payload) => gesendet.push(payload),
      ice: async () => ({ iceServers: [] }),
      onChange: () => {},
      media: fakeMedia,
      roomKey: RAUMSCHLUESSEL,
      timers: uhr.timers,
    });
    const geklopft = a.invite('audio');
    await ruhe(3);
    uhr.vor(WORKER_TIMEOUT + 1);
    await geklopft;

    const ring = gesendet.find((p) => p.k === 'ring');
    assert.ok(ring, 'es wurde gar nicht angeklopft');
    assert.equal(ring.m, false, 'eine zweite Schicht wurde versprochen, die es nicht gibt');
    assert.ok(FakeWorker.alle.at(-1).terminated, 'der stumme Faden lief weiter');
    a.finish('hangup');
  } finally {
    FakeWorker.antwort = 'bereit';
  }
});

/**
 * Der Fehler, der beim ersten Anlauf eine Stunde gekostet hat: die Empfänger
 * erst in `ontrack` einzuhängen genügt nicht. Wer das Angebot macht, hat
 * seine Empfänger schon vorher - und wenn sie erst mit der Antwort
 * eingehängt würden, liefen sie längst und nähmen die Entschlüsselung nicht
 * mehr an. Das Bild kam dann verschlüsselt beim Decoder an: schwarz.
 */
test('Auch die Empfänger des Anrufers hängen von Anfang an in der Verschlüsselung', async () => {
  const { a, b } = paar({ roomKey: RAUMSCHLUESSEL });
  await a.invite('video');
  await ruhe();
  await b.accept();
  await ruhe();

  for (const [wer, sitzung] of [['Anrufer', a], ['Angerufener', b]]) {
    const sender = arten(sitzung.pc.getSenders());
    const empfaenger = arten(sitzung.pc.getReceivers());
    assert.ok(sender.length > 0, `${wer}: keine Sender`);
    assert.ok(empfaenger.length > 0, `${wer}: keine Empfänger`);
    assert.ok(sender.every((art) => art === 'encode'), `${wer}: ein Sender verschlüsselt nicht (${sender})`);
    assert.ok(empfaenger.every((art) => art === 'decode'), `${wer}: ein Empfänger entschlüsselt nicht (${empfaenger})`);
  }
  a.hangUp();
  b.finish('hangup');
});

test('Ohne zweite Schicht wird auch nichts eingehängt', async () => {
  const { a, b } = paar();
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();
  assert.deepEqual(arten(a.pc.getSenders()).filter(Boolean), []);
  assert.deepEqual(arten(a.pc.getReceivers()).filter(Boolean), []);
  a.hangUp();
  b.finish('hangup');
});

test('Beim Auflegen wird der Faden beendet', async () => {
  FakeWorker.alle.length = 0;
  const { a, b } = paar({ roomKey: RAUMSCHLUESSEL });
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();
  a.hangUp();
  b.finish('hangup');
  await ruhe(3);
  assert.ok(FakeWorker.alle.length >= 2);
  assert.ok(FakeWorker.alle.every((w) => w.terminated), 'ein Faden lief weiter');
});

/** Uhr und Wecker in der Hand des Tests - sonst dauerte der 45 Sekunden. */
function steuerbareZeit() {
  const wecker = new Map();
  let jetzt = 1_000_000;
  let nummer = 0;
  return {
    timers: {
      setTimeout: (fn, ms) => { nummer += 1; wecker.set(nummer, { fn, faellig: jetzt + ms }); return nummer; },
      clearTimeout: (id) => wecker.delete(id),
      now: () => jetzt,
    },
    vor(ms) {
      jetzt += ms;
      for (const [id, eintrag] of [...wecker]) {
        if (eintrag.faellig <= jetzt) { wecker.delete(id); eintrag.fn(); }
      }
    },
  };
}

test('Ein Anruf, den niemand annimmt, gibt von selbst auf', async () => {
  const uhr = steuerbareZeit();
  const gesendet = [];
  const a = new CallSession({
    send: (payload) => gesendet.push(payload),
    ice: async () => ({ iceServers: [] }),
    onChange: () => {},
    media: fakeMedia,
    timers: uhr.timers,
  });
  await a.invite('audio');
  await ruhe(3);
  assert.equal(a.state, 'calling');

  uhr.vor(RING_TIMEOUT + 1);
  assert.equal(a.state, 'ended');
  assert.equal(a.endReason, 'no_answer');
  assert.equal(gesendet.at(-1).k, 'bye');
});

/**
 * Der Fall, den man erst im Betrieb sieht: angenommen ist angenommen, aber
 * die Geräte finden trotzdem keinen Weg zueinander. Ohne Frist bliebe hier
 * für immer "Verbinde ..." stehen.
 */
test('Ein Verbindungsaufbau, der nicht zustande kommt, endet mit einer Ansage', async () => {
  const uhr = steuerbareZeit();
  // Die Adresssuche hängt - der Aufbau kommt nicht von der Stelle.
  let weiter;
  const haengt = new Promise((resolve) => { weiter = resolve; });
  const a = new CallSession({
    send: () => {},
    ice: () => haengt.then(() => ({ iceServers: [] })),
    onChange: () => {},
    media: fakeMedia,
    timers: uhr.timers,
  });
  await a.receive({ v: SIGNAL_VERSION, c: 'ein-anruf', k: 'ring', kind: 'audio' });
  assert.equal(a.state, 'ringing');
  const angenommen = a.accept();
  await ruhe(3);
  assert.equal(a.state, 'connecting');

  uhr.vor(CONNECT_TIMEOUT + 1);
  assert.equal(a.state, 'ended');
  assert.equal(a.endReason, 'failed');

  // Aufräumen: die Adresssuche darf jetzt zurückkommen, sie findet einen
  // längst beendeten Anruf vor und lässt ihn in Ruhe.
  weiter();
  await angenommen;
  assert.equal(a.pc, null);
});

test('Nach dem Auflegen ist ein neuer Anruf sofort wieder möglich', async () => {
  const { a, b } = paar();
  await a.invite('audio');
  await ruhe();
  await b.accept();
  await ruhe();
  a.hangUp();
  await ruhe();

  assert.equal(a.busy, false);
  await a.invite('audio');
  await ruhe();
  assert.equal(b.state, 'ringing');
  a.hangUp();
  b.finish('hangup');
});
