/**
 * Sprach- und Videoanrufe.
 *
 * Der Ton und das Bild gehen direkt von Gerät zu Gerät. Der Server hilft nur
 * beim Finden - und selbst dabei sieht er nichts: die gesamte Aushandlung
 * (Angebot, Antwort, Adresskandidaten) ist mit dem Raumschlüssel
 * verschlüsselt, genau wie eine Nachricht. Wer diesen Server betreibt oder
 * übernimmt, kann sich deshalb nicht dazwischenschalten: um ein eigenes
 * Angebot unterzuschieben, müsste er es gültig verschlüsseln - und dafür
 * bräuchte er den Code, den er nie zu sehen bekommt.
 *
 * Darüber liegt noch WebRTC selbst: der Medienstrom ist per DTLS-SRTP
 * verschlüsselt, mit Schlüsseln, die aus den ausgehandelten Zertifikaten
 * entstehen. Ein Relaisdienst sieht deshalb nur unlesbare Pakete.
 *
 * Und wo der Browser es hergibt, kommt eine zweite Schicht darüber: jedes
 * einzelne Bild und jedes Tonpaket wird noch einmal verschlüsselt, mit einem
 * Schlüssel aus dem Code des Chats (siehe framecrypto.js und call-worker.js).
 * Selbst wer den WebRTC-Handschlag bräche - heute nicht, aber Aufzeichnungen
 * sind geduldig -, hätte dann immer noch nichts.
 *
 * Und als letzte Sicherung gibt es die Prüfzeichen: vier Symbole, aus den
 * Fingerabdrücken beider Zertifikate gerechnet. Beide Seiten sehen dieselben,
 * wenn niemand dazwischensitzt. Das ist der Handgriff, der auch dann noch
 * greift, wenn alles andere versagt hätte.
 *
 * Diese Datei kennt weder den Bildschirm noch die Verschlüsselung - sie
 * bekommt eine `send`-Funktion und meldet Zustände zurück. Dadurch lässt sie
 * sich einzeln prüfen.
 */

/** Fassung des Aushandlungsformats. Ältere Gegenstellen sollen sauber ablehnen. */
export const SIGNAL_VERSION = 1;

/**
 * Kann dieser Browser die zweite Schicht über Ton und Bild?
 *
 * Nötig ist RTCRtpScriptTransform - der Weg, auf dem sich fertig kodierte
 * Pakete anfassen lassen, bevor sie auf die Leitung gehen. Ältere Browser
 * können das nicht; dort bleibt es bei der Verschlüsselung von WebRTC selbst,
 * und die App sagt das dazu, statt es zu verschweigen.
 */
export const mediaCryptoAvailable = () =>
  typeof RTCRtpScriptTransform === 'function' && typeof Worker === 'function';

/** So lange klingelt es, dann gibt der Anrufer auf. */
export const RING_TIMEOUT = 45_000;

/**
 * So lange darf der Verbindungsaufbau nach dem Annehmen dauern.
 *
 * Ohne diese Frist bliebe ein Anruf, der die Gegenstelle nicht erreicht,
 * ewig bei "Verbinde ..." stehen - in manchen Netzen findet ICE schlicht
 * keinen Weg, und das merkt der Browser nicht immer selbst. Lieber ehrlich
 * abbrechen als endlos warten lassen.
 */
export const CONNECT_TIMEOUT = 30_000;

/**
 * So lange warten wir auf den Faden für die zweite Schicht. Meldet er sich
 * nicht, wird sie gar nicht erst vereinbart - besser ohne zweite Schicht
 * telefonieren als verschlüsselt senden, was drüben niemand aufmacht.
 */
export const WORKER_TIMEOUT = 3_000;

/**
 * Die Prüfzeichen kommen aus diesem Alphabet: 64 Symbole, die sich auch auf
 * kleinen Bildschirmen deutlich unterscheiden. Vier davon sind 24 Bit - wer
 * blind raten wollte, hätte eine Chance von 1 zu 16 Millionen, und er müsste
 * dabei live danebenstehen.
 */
const SAS_ALPHABET = [
  '🐶', '🐱', '🦊', '🐻', '🐼', '🐨', '🦁', '🐯',
  '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🦆', '🦉',
  '🦋', '🐝', '🐢', '🐬', '🐳', '🐙', '🦀', '🐊',
  '🌵', '🌲', '🍀', '🌻', '🌹', '🍄', '🌰', '🍁',
  '🍎', '🍌', '🍇', '🍓', '🍑', '🍍', '🥕', '🌽',
  '🍕', '🍔', '🍟', '🥐', '🧀', '🍩', '🍪', '🎂',
  '⚽', '🏀', '🎾', '🎸', '🎺', '🎨', '🎁', '🎈',
  '🚗', '🚂', '✈️', '🚀', '⛵', '🏠', '⭐', '🌙',
];

/** Was der Browser aufnehmen soll. Ruhe und Deutlichkeit vor Brillanz. */
const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const VIDEO_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
  facingMode: 'user',
};

/**
 * Liest die Zertifikats-Fingerabdrücke aus einer Beschreibung.
 * In der Regel steht genau einer drin; bei mehreren Medienspuren derselbe.
 */
export function fingerprintsOf(sdp) {
  const found = new Set();
  for (const line of String(sdp ?? '').split(/\r?\n/)) {
    const match = /^a=fingerprint:(\S+)\s+(\S+)/i.exec(line.trim());
    if (match) found.add(`${match[1].toLowerCase()} ${match[2].toUpperCase()}`);
  }
  return [...found];
}

/**
 * Rechnet die Prüfzeichen aus beiden Fingerabdrücken.
 *
 * Sortiert wird, damit beide Seiten trotz vertauschter Rollen dasselbe
 * herausbekommen. Die Raum-ID kommt mit hinein: sie hängt am Code, den nur
 * die beiden kennen - so lassen sich Prüfzeichen nicht aus einem fremden
 * Gespräch herüberkopieren.
 */
export async function safetyCode(localSdp, remoteSdp, salt = '') {
  const parts = [...fingerprintsOf(localSdp), ...fingerprintsOf(remoteSdp)].sort();
  if (parts.length < 2) return '';
  const material = new TextEncoder().encode(`fluesterchat-sas|${salt}|${parts.join('|')}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
  let out = '';
  for (let i = 0; i < 4; i += 1) out += SAS_ALPHABET[digest[i] & 0x3f];
  return out;
}

/**
 * Ein Anruf, von der Einladung bis zum Auflegen.
 *
 * Zustände:
 *   idle       – nichts los
 *   calling    – wir haben angeklopft und warten
 *   ringing    – es klingelt bei uns
 *   connecting – angenommen, die Leitung wird aufgebaut
 *   active     – man hört sich
 *   ended      – vorbei (mit Grund)
 */
export class CallSession {
  /**
   * @param {object} options
   * @param {(payload: object) => void} options.send Verschickt ein Signal (wird aussen verschlüsselt).
   * @param {() => Promise<RTCConfiguration>} options.ice Holt die Dienste für die Adresssuche.
   * @param {(state: object) => void} options.onChange Meldet jeden Zustandswechsel.
   * @param {string} [options.salt] Geht in die Prüfzeichen ein - hier die Raum-ID.
   * @param {boolean} [options.relayOnly] Nur über den Relaisdienst - verbirgt die eigene Adresse.
   */
  constructor({ send, ice, onChange, salt = '', relayOnly = false, roomKey = null, media = null, timers = null }) {
    this.sendSignal = send;
    this.loadIce = ice;
    this.onChange = onChange ?? (() => {});
    this.salt = salt;
    this.relayOnly = relayOnly;
    /** Die rohen Bytes des Chatschlüssels - Grundlage der zweiten Schicht. */
    this.roomKey = roomKey;
    this.media = media ?? (typeof navigator !== 'undefined' ? navigator.mediaDevices : null);
    this.timers = timers ?? { setTimeout: setTimeout.bind(null), clearTimeout: clearTimeout.bind(null), now: Date.now };

    this.state = 'idle';
    this.callId = null;
    this.kind = 'audio';
    this.incoming = false;
    this.endReason = '';
    this.startedAt = 0;
    this.safety = '';
    this.muted = false;
    this.cameraOff = false;
    this.relayed = null;
    /** Läuft die zweite Schicht über Ton und Bild? Erst nach Absprache. */
    this.doubleEncrypted = false;
    /** Was die Gegenstelle dazu kann - kommt mit der Einladung herein. */
    this.peerCanDouble = false;
    this.worker = null;

    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    /** Perfekte Aushandlung: der Höfliche gibt bei einer Kollision nach. */
    this.polite = false;
    this.makingOffer = false;
    this.ignoreOffer = false;
    /** Ist die erste Runde durch? Vorher macht nur der Anrufer ein Angebot. */
    this.negotiated = false;
    this.earlyCandidates = [];
    this.ringTimer = null;
    /**
     * Signale werden streng nacheinander abgearbeitet. Beschreibung und
     * Kandidaten dürfen sich nicht überholen - sonst landet ein Kandidat vor
     * der Beschreibung, zu der er gehört.
     */
    this.chain = Promise.resolve();
  }

  get busy() {
    return this.state !== 'idle' && this.state !== 'ended';
  }

  /** Wie lange läuft das Gespräch schon (in Millisekunden)? */
  get duration() {
    return this.startedAt ? this.timers.now() - this.startedAt : 0;
  }

  emit() {
    this.onChange({
      state: this.state,
      kind: this.kind,
      incoming: this.incoming,
      endReason: this.endReason,
      safety: this.safety,
      muted: this.muted,
      cameraOff: this.cameraOff,
      relayed: this.relayed,
      doubleEncrypted: this.doubleEncrypted,
      localStream: this.localStream,
      remoteStream: this.remoteStream,
      startedAt: this.startedAt,
    });
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit();
  }

  // -------------------------------------------------------------- anrufen

  /** Klopft beim Gegenüber an. @param {'audio'|'video'} kind */
  async invite(kind = 'audio') {
    if (this.busy) throw new Error('call_busy');
    this.reset();
    this.kind = kind === 'video' ? 'video' : 'audio';
    this.incoming = false;
    this.polite = false; // Der Anrufer macht das Angebot und bleibt dabei.
    this.callId = randomCallId();
    this.setState('calling');

    try {
      this.localStream = await this.capture(this.kind);
    } catch (error) {
      this.finish(error?.name === 'NotAllowedError' ? 'no_permission' : 'no_device');
      throw error;
    }
    // Zwischen Frage und Antwort kann längst aufgelegt worden sein.
    if (this.state !== 'calling') {
      this.stopLocal();
      return;
    }
    this.emit();
    // Erst nachsehen, ob die zweite Schicht hier wirklich läuft - versprochen
    // wird der Gegenstelle nur, was gehalten werden kann.
    const zweiteSchicht = await this.prepareWorker();
    if (this.state !== 'calling') {
      this.stopLocal();
      this.stopWorker();
      return;
    }
    this.signal({ k: 'ring', kind: this.kind, m: zweiteSchicht });
    this.guard(RING_TIMEOUT, 'calling', 'no_answer');
  }

  /** Nimmt einen eingehenden Anruf an. */
  async accept() {
    if (this.state !== 'ringing') return;
    this.setState('connecting');
    try {
      this.localStream = await this.capture(this.kind);
    } catch (error) {
      this.signal({ k: 'bye', why: 'no_device' });
      this.finish(error?.name === 'NotAllowedError' ? 'no_permission' : 'no_device');
      throw error;
    }
    if (this.state !== 'connecting') {
      this.stopLocal();
      return;
    }
    this.guard(CONNECT_TIMEOUT, 'connecting', 'failed');
    // Der Angerufene ist der Höfliche: bei gleichzeitigen Angeboten gibt er nach.
    this.polite = true;
    // Erst zusagen, dann aufbauen: so weiss die Gegenseite Bescheid und hat
    // ihre eigene Leitung schon offen, wenn das erste Angebot eintrifft.
    // Der Angerufene entscheidet: die zweite Schicht geht nur, wenn beide
    // Browser sie können. Wer sie nicht kann, bekommt sie auch nicht
    // untergeschoben - sonst käme dort nur Rauschen an.
    this.doubleEncrypted = this.peerCanDouble && await this.prepareWorker();
    if (this.state !== 'connecting') {
      this.stopLocal();
      this.stopWorker();
      return;
    }
    this.signal({ k: 'accept', m: this.doubleEncrypted });
    await this.openPeer();
    this.emit();
  }

  /** Lehnt ab oder legt auf - je nachdem, wo wir gerade stehen. */
  hangUp(why = 'hangup') {
    if (!this.busy) return;
    this.signal({ k: 'bye', why });
    this.finish(why);
  }

  // ---------------------------------------------------------- hereinkommend

  /**
   * Ein entschlüsseltes Signal vom Gegenüber. Wird eingereiht, damit zwei
   * schnell hintereinander eintreffende Pakete sich nicht überholen.
   */
  receive(payload) {
    this.chain = this.chain.then(() => this.handle(payload)).catch(() => {});
    return this.chain;
  }

  async handle(payload) {
    if (!payload || payload.v !== SIGNAL_VERSION) return;
    const id = String(payload.c ?? '');
    if (!id) return;

    if (payload.k === 'ring') {
      // Schon im Gespräch? Dann höflich absagen, statt es zu zerschiessen.
      if (this.busy) {
        this.sendSignal({ v: SIGNAL_VERSION, c: id, k: 'bye', why: 'busy' });
        return;
      }
      this.reset();
      this.callId = id;
      this.kind = payload.kind === 'video' ? 'video' : 'audio';
      this.peerCanDouble = payload.m === true;
      this.incoming = true;
      this.setState('ringing');
      // Hier nur auflegen, nicht absagen: der Anrufer gibt selbst auf, und
      // zwei "bye" zum selben Anruf sind einer zu viel.
      this.guard(RING_TIMEOUT, 'ringing', 'no_answer', { still: true });
      return;
    }

    // Alles Weitere gehört zu genau einem Anruf. Fremdes ignorieren.
    if (id !== this.callId) return;

    switch (payload.k) {
      case 'accept':
        if (this.state !== 'calling') return;
        // Was der Angerufene entschieden hat, gilt - der eigene Faden läuft
        // seit dem Anklopfen und wartet nur darauf, gebraucht zu werden.
        this.doubleEncrypted = payload.m === true && Boolean(this.worker);
        if (!this.doubleEncrypted) this.stopWorker();
        this.setState('connecting');
        this.guard(CONNECT_TIMEOUT, 'connecting', 'failed');
        // Erst jetzt die Leitung aufbauen: das löst das Angebot aus.
        await this.openPeer();
        return;
      case 'sdp':
        return this.onDescription(payload.sdp);
      case 'ice':
        return this.onCandidate(payload.cand);
      case 'bye':
        if (!this.busy) return;
        return this.finish(payload.why === 'busy' ? 'busy' : (this.state === 'calling' ? 'declined' : 'remote_hangup'));
      default:
        return undefined;
    }
  }

  // ------------------------------------------------------------- Innenleben

  async capture(kind) {
    if (!this.media?.getUserMedia) {
      const error = new Error('no_media');
      error.name = 'NotFoundError';
      throw error;
    }
    return this.media.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
      video: kind === 'video' ? VIDEO_CONSTRAINTS : false,
    });
  }

  async openPeer() {
    const config = await this.loadIce();
    if (!this.busy) return;
    const pc = new RTCPeerConnection({
      ...config,
      // Nur über den Relaisdienst: dann sieht das Gegenüber die eigene
      // Adresse nie. Kostet Umweg, spart Preisgabe.
      iceTransportPolicy: this.relayOnly ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    this.pc = pc;

    for (const track of this.localStream?.getTracks() ?? []) {
      pc.addTrack(track, this.localStream);
    }
    // Bei einem Sprachanruf trotzdem einen Platz für Bild freihalten - dann
    // lässt sich die Kamera später zuschalten, ohne neu zu verhandeln.
    if (this.kind !== 'video') pc.addTransceiver('video', { direction: 'recvonly' });
    // Jeder Sender wird eingehängt, auch der noch leere Bildplatz: wird dort
    // später eine Kamera eingesetzt, läuft sie von der ersten Aufnahme an
    // durch die Verschlüsselung - und nicht erst ab der zweiten.
    for (const sender of pc.getSenders()) this.protect(sender);
    // Und die Empfänger gleich mit. Das ist keine Vorsicht, sondern nötig:
    // wer das Angebot macht, hat seine Empfänger schon hier - und wenn sie
    // erst beim Eintreffen der Antwort eingehängt würden, liefen sie längst
    // und nähmen die Entschlüsselung nicht mehr an. Wer antwortet, bekommt
    // seine Empfänger erst mit dem Angebot; die fängt ontrack ab.
    for (const receiver of pc.getReceivers()) this.protect(receiver);
    this.preferSimpleCodecs(pc);

    this.remoteStream = new MediaStream();
    this.emit();

    pc.ontrack = (event) => {
      this.protect(event.receiver);
      for (const stream of event.streams) {
        for (const track of stream.getTracks()) {
          if (!this.remoteStream.getTrackById(track.id)) this.remoteStream.addTrack(track);
        }
      }
      if (!event.streams.length && !this.remoteStream.getTrackById(event.track.id)) {
        this.remoteStream.addTrack(event.track);
      }
      this.emit();
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) this.signal({ k: 'ice', cand: event.candidate.toJSON() });
    };

    pc.onnegotiationneeded = async () => {
      // Die erste Runde macht allein der Anrufer. Zwei gleichzeitige Angebote
      // lösen sich zwar auf (der Höfliche gibt nach), aber sie kosten eine
      // Runde und sind eine Fehlerquelle, die es hier nicht braucht. Später
      // im Gespräch - etwa wenn jemand die Kamera zuschaltet - darf jede
      // Seite anfangen; dafür ist die Nachgiebigkeit weiter da.
      if (this.polite && !this.negotiated) return;
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.signal({ k: 'sdp', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      } catch {
        /* Ein abgebrochener Anruf räumt gleich hinterher. */
      } finally {
        this.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      if (pc.connectionState === 'connected') {
        if (!this.startedAt) this.startedAt = this.timers.now();
        this.clearRing();
        void this.describeRoute();
        void this.refreshSafety();
        this.setState('active');
      } else if (pc.connectionState === 'failed') {
        this.hangUp('failed');
      } else if (pc.connectionState === 'disconnected' && this.state === 'active') {
        // Kurze Aussetzer sind normal - erst melden, dann abwarten.
        this.emit();
      }
    };
  }

  // ------------------------------------------ Zweite Schicht über den Strom

  /** Kann diese Seite die zweite Schicht - und hat sie den Schlüssel dafür? */
  canDouble() {
    return mediaCryptoAvailable() && this.roomKey instanceof Uint8Array && this.roomKey.length > 0;
  }

  /**
   * Startet den Faden und wartet, bis er den Schlüssel abgeleitet hat.
   *
   * Das Warten ist der Punkt: erst wenn der Faden nachweislich läuft, darf
   * die zweite Schicht mit der Gegenstelle vereinbart werden. Andernfalls
   * schickte eine Seite verschlüsselt, was die andere nicht aufmachen kann -
   * und der Anruf wäre stumm und schwarz, ohne dass jemand wüsste, warum.
   *
   * @returns {Promise<boolean>} ob die zweite Schicht möglich ist.
   */
  async prepareWorker() {
    if (!this.canDouble()) return false;
    if (this.worker) return true;
    let worker;
    try {
      worker = new Worker(new URL('./call-worker.js', import.meta.url), { type: 'module' });
    } catch {
      return false;
    }
    const bereit = await new Promise((resolve) => {
      const fertig = (antwort) => {
        this.timers.clearTimeout(frist);
        worker.onmessage = null;
        worker.onerror = null;
        resolve(antwort);
      };
      const frist = this.timers.setTimeout(() => fertig(false), WORKER_TIMEOUT);
      worker.onmessage = (event) => fertig(event.data?.type === 'ready');
      worker.onerror = () => fertig(false);
      // Eine Kopie der Bytes: die eigene Ableitung soll unberührt bleiben.
      worker.postMessage({ type: 'key', room: this.roomKey.slice().buffer, callId: this.callId });
    });
    if (!bereit) {
      worker.terminate();
      return false;
    }
    this.worker = worker;
    return true;
  }

  /** Hängt Sender oder Empfänger in den Faden ein. */
  protect(endpoint) {
    if (!this.doubleEncrypted || !this.worker || !endpoint || endpoint.transform) return;
    try {
      const operation = typeof endpoint.replaceTrack === 'function' ? 'encode' : 'decode';
      endpoint.transform = new RTCRtpScriptTransform(this.worker, { operation });
    } catch {
      /* Kann dieser Browser doch nicht - dann eben nur die Schicht von WebRTC. */
    }
  }

  /**
   * Beschränkt die Auswahl auf VP8 und Opus, solange die zweite Schicht läuft.
   *
   * Grund: der Browser muss ein fertiges Bild noch in RTP-Pakete zerlegen und
   * liest dafür ein paar Bytes am Anfang. Wie viele das sind, hängt am Codec.
   * Für VP8 ist es sauber bekannt (drei Bytes, zehn beim Schlüsselbild), und
   * genau so viele bleiben im Klartext. Bei H.264 wäre es eine Wette. Für ein
   * Gespräch zu zweit ist VP8 gut genug - eine Wette wäre es nicht.
   */
  preferSimpleCodecs(pc) {
    if (!this.doubleEncrypted || typeof RTCRtpSender.getCapabilities !== 'function') return;
    const erlaubt = (kind, muster) => {
      const codecs = RTCRtpSender.getCapabilities(kind)?.codecs ?? [];
      // Die Helfer (Wiederholung, Fehlerkorrektur) müssen mit drinbleiben.
      return codecs.filter((codec) => muster.test(codec.mimeType) || /\/(rtx|red|ulpfec)$/i.test(codec.mimeType));
    };
    for (const transceiver of pc.getTransceivers()) {
      if (typeof transceiver.setCodecPreferences !== 'function') continue;
      const kind = transceiver.sender?.track?.kind ?? transceiver.receiver?.track?.kind;
      try {
        if (kind === 'video') transceiver.setCodecPreferences(erlaubt('video', /\/VP8$/i));
        else if (kind === 'audio') transceiver.setCodecPreferences(erlaubt('audio', /\/opus$/i));
      } catch {
        /* Verweigert der Browser die Auswahl, nimmt er eben seine eigene. */
      }
    }
  }

  async onDescription(description) {
    if (!description?.type) return;
    if (!this.pc) return;
    const pc = this.pc;
    const offerCollision = description.type === 'offer'
      && (this.makingOffer || pc.signalingState !== 'stable');
    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;

    try {
      await pc.setRemoteDescription(description);
    } catch {
      return;
    }
    for (const candidate of this.earlyCandidates.splice(0)) {
      await pc.addIceCandidate(candidate).catch(() => {});
    }
    if (description.type === 'offer') {
      await pc.setLocalDescription();
      this.signal({ k: 'sdp', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    }
    // Ab jetzt darf auch diese Seite von sich aus neu aushandeln.
    this.negotiated = true;
    await this.refreshSafety();
  }

  async onCandidate(candidate) {
    if (!candidate || !this.pc) return;
    // Kandidaten können vor der Beschreibung eintreffen - dann sammeln.
    if (!this.pc.remoteDescription) {
      if (this.earlyCandidates.length < 100) this.earlyCandidates.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(candidate).catch(() => {
      if (!this.ignoreOffer) { /* Ein verirrter Kandidat ist kein Grund aufzulegen. */ }
    });
  }

  /** Prüfzeichen neu rechnen, sobald beide Beschreibungen vorliegen. */
  async refreshSafety() {
    const local = this.pc?.localDescription?.sdp;
    const remote = this.pc?.remoteDescription?.sdp;
    if (!local || !remote) return;
    const next = await safetyCode(local, remote, this.salt);
    if (next && next !== this.safety) {
      this.safety = next;
      this.emit();
    }
  }

  /** Läuft es direkt oder über den Relaisdienst? Ehrliche Auskunft statt Vermutung. */
  async describeRoute() {
    try {
      const stats = await this.pc.getStats();
      let pair = null;
      const candidates = new Map();
      for (const report of stats.values()) {
        if (report.type === 'local-candidate' || report.type === 'remote-candidate') candidates.set(report.id, report);
        if (report.type === 'candidate-pair' && (report.selected || (report.state === 'succeeded' && report.nominated))) pair = report;
      }
      if (!pair) return;
      const local = candidates.get(pair.localCandidateId);
      const remote = candidates.get(pair.remoteCandidateId);
      const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
      if (relayed !== this.relayed) {
        this.relayed = relayed;
        this.emit();
      }
    } catch {
      /* Ohne Auskunft sagen wir lieber nichts, als etwas Falsches. */
    }
  }

  signal(body) {
    if (!this.callId) return;
    this.sendSignal({ v: SIGNAL_VERSION, c: this.callId, ...body });
  }

  // ----------------------------------------------------------- Bedienknöpfe

  toggleMute() {
    this.muted = !this.muted;
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !this.muted;
    this.emit();
    return this.muted;
  }

  toggleCamera() {
    const tracks = this.localStream?.getVideoTracks() ?? [];
    if (!tracks.length) return this.cameraOff;
    this.cameraOff = !this.cameraOff;
    for (const track of tracks) track.enabled = !this.cameraOff;
    this.emit();
    return this.cameraOff;
  }

  /** Kamera zuschalten - auch mitten in einem Sprachanruf. */
  async addCamera() {
    if (!this.pc || this.localStream?.getVideoTracks().length) return false;
    const extra = await this.capture('video');
    const [track] = extra.getVideoTracks();
    if (!track) return false;
    this.localStream.addTrack(track);
    // Beim Sprachanruf wurde ein Bildplatz freigehalten - den benutzen wir
    // jetzt, statt einen zweiten aufzumachen.
    const spare = this.pc.getTransceivers().find(
      (tr) => tr.sender.track === null && (tr.receiver.track?.kind === 'video' || tr.direction === 'recvonly'),
    );
    if (spare) {
      // Der Platz hängt schon in der Verschlüsselung - hier nur die Spur einsetzen.
      await spare.sender.replaceTrack(track);
      spare.direction = 'sendrecv';
    } else {
      this.protect(this.pc.addTrack(track, this.localStream));
    }
    this.kind = 'video';
    this.cameraOff = false;
    this.emit();
    return true;
  }

  /** Vorne oder hinten - am Handy der wichtigste Knopf. */
  async flipCamera() {
    const current = this.localStream?.getVideoTracks()[0];
    if (!current || !this.pc) return false;
    const facing = current.getSettings?.().facingMode === 'user' ? 'environment' : 'user';
    let replacement;
    try {
      const next = await this.media.getUserMedia({ video: { ...VIDEO_CONSTRAINTS, facingMode: { ideal: facing } } });
      [replacement] = next.getVideoTracks();
    } catch {
      return false;
    }
    if (!replacement) return false;
    const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) await sender.replaceTrack(replacement);
    current.stop();
    this.localStream.removeTrack(current);
    this.localStream.addTrack(replacement);
    replacement.enabled = !this.cameraOff;
    this.emit();
    return true;
  }

  // ------------------------------------------------------------- Aufräumen

  /**
   * Setzt eine Frist für den aktuellen Abschnitt. Steht der Anruf danach
   * immer noch dort, wo er stand, ist er gescheitert - und das sagen wir,
   * statt eine Anzeige stehen zu lassen, die sich nie mehr ändert.
   */
  guard(ms, state, reason, { still = false } = {}) {
    this.clearRing();
    this.ringTimer = this.timers.setTimeout(() => {
      if (this.state !== state) return;
      if (still) this.finish(reason);
      else this.hangUp(reason);
    }, ms);
  }

  clearRing() {
    if (this.ringTimer) this.timers.clearTimeout(this.ringTimer);
    this.ringTimer = null;
  }

  stopLocal() {
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.localStream = null;
  }

  /** Beendet den Anruf, ohne noch einmal zu senden. */
  finish(reason) {
    this.clearRing();
    this.endReason = reason;
    this.stopWorker();
    this.stopLocal();
    this.remoteStream = null;
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.onnegotiationneeded = null;
      this.pc.onconnectionstatechange = null;
      try { this.pc.close(); } catch { /* schon zu */ }
      this.pc = null;
    }
    this.callId = null;
    this.state = 'ended';
    this.emit();
  }

  stopWorker() {
    this.worker?.terminate();
    this.worker = null;
  }

  reset() {
    this.clearRing();
    this.stopWorker();
    this.stopLocal();
    this.remoteStream = null;
    if (this.pc) {
      try { this.pc.close(); } catch { /* schon zu */ }
      this.pc = null;
    }
    this.callId = null;
    this.endReason = '';
    this.startedAt = 0;
    this.safety = '';
    this.muted = false;
    this.cameraOff = false;
    this.relayed = null;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.negotiated = false;
    this.doubleEncrypted = false;
    this.peerCanDouble = false;
    this.earlyCandidates = [];
    this.state = 'idle';
  }

  /** Beim Verlassen des Chats: alles zu, ohne Zustandsmeldung. */
  dispose() {
    if (this.busy) this.signal({ k: 'bye', why: 'hangup' });
    this.reset();
  }
}

function randomCallId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
