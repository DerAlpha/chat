/** Alles, was mit dem Server spricht: REST fuer Raeume und Anhaenge, WebSocket fuer den Rest. */

import { appPath, socketUrl } from './base.js';

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (cause) {
    throw new ApiError('network', 'Netzwerkfehler', 0);
  }
  if (response.status === 204) return null;
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const body = isJson ? await response.json().catch(() => ({})) : null;
  if (!response.ok) {
    throw new ApiError(body?.error ?? 'http_error', body?.message ?? response.statusText, response.status);
  }
  return body;
}

/**
 * Einen Raum anlegen. Fuer eine Gruppe kommen die Einmal-Plaetze gleich mit:
 * je Teilnehmer eine Kennung und der Gruppenschluessel, verpackt fuer genau
 * dessen Code. Der Server kann keines dieser Pakete oeffnen.
 *
 * @param {string} roomId
 * @param {Array<{id: string, wrapped: string}>} [slots]
 */
export const createRoom = (roomId, slots) =>
  request(appPath('api/rooms'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(slots?.length ? { roomId, slots } : { roomId }),
  });

/**
 * Einen Einmal-Platz einloesen. Der Beitretende kennt nur seinen Code; aus
 * dem rechnet sein Browser die Platzkennung, legt sie hier vor und bekommt
 * dafuer das verpackte Paket und einen Platz im Raum.
 */
export const claimSlot = (slotId) =>
  request(appPath(`api/slots/${encodeURIComponent(slotId)}/claim`), { method: 'POST' });

export const roomStatus = (roomId) => request(appPath(`api/rooms/${encodeURIComponent(roomId)}`));

/**
 * Kurzfassung mehrerer Raeume auf einmal - fuer die Liste auf der Startseite.
 *
 * Die App haelt genau eine Verbindung, naemlich zu dem Chat, der offen ist.
 * Was in den anderen liegt, erfaehrt sie nur hier. Eine Anfrage statt einer
 * Verbindung je Chat: das laeuft auch auf einem einfachen Webspace.
 *
 * @param {Array<{roomId: string, token: string, seq: number}>} rooms
 */
export const overview = (rooms) =>
  request(appPath('api/overview'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rooms }),
  });

/**
 * GIF-Suche über das eigene Backend. Giphy sieht den Server, nicht das Gerät -
 * und was zurückkommt, enthält keine einzige Giphy-Adresse, sondern nur
 * signierte, befristete Verweise, die wiederum nur dieser Server einlöst.
 */
export const searchGifs = (query, offset = 0) =>
  request(appPath(`api/gifs?q=${encodeURIComponent(query)}&offset=${offset}`));

/** Adresse eines Vorschaubilds - gleiche Herkunft, deshalb CSP-tauglich. */
export const gifMediaUrl = (ref) => appPath(`api/gifs/media?ref=${encodeURIComponent(ref)}`);

/** Holt die Bytes eines GIFs, damit der Browser sie verschlüsselt weiterschicken kann. */
export async function fetchGif(ref) {
  const response = await fetch(gifMediaUrl(ref));
  if (!response.ok) throw new ApiError('gif_failed', 'Das GIF liess sich nicht laden.', response.status);
  const buffer = await response.arrayBuffer();
  return {
    bytes: new Uint8Array(buffer),
    mime: response.headers.get('content-type') || 'image/gif',
  };
}

/** Laedt bereits verschluesselte Bytes hoch. */
export async function uploadBlob(roomId, token, bytes, onProgress) {
  // XMLHttpRequest, weil fetch keinen Upload-Fortschritt meldet.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', appPath(`api/rooms/${encodeURIComponent(roomId)}/blobs`));
    xhr.setRequestHeader('x-room-token', token);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.responseType = 'json';
    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
    }
    xhr.onload = () => {
      const body = xhr.response ?? {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new ApiError(body.error ?? 'upload_failed', body.message ?? 'Upload fehlgeschlagen', xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('network', 'Netzwerkfehler', 0));
    xhr.onabort = () => reject(new ApiError('aborted', 'Abgebrochen', 0));
    xhr.send(bytes);
  });
}

/** Holt verschluesselte Bytes zurueck. */
export async function downloadBlob(roomId, token, blobId) {
  const response = await fetch(appPath(`api/rooms/${encodeURIComponent(roomId)}/blobs/${encodeURIComponent(blobId)}`), {
    headers: { 'x-room-token': token },
  });
  if (!response.ok) {
    throw new ApiError('download_failed', 'Anhang nicht abrufbar', response.status);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Dienste für die Adresssuche eines Anrufs. Die Zugangsdaten sind kurzlebig
 * und gelten nur für diesen Raum - deshalb wird bei jedem Anruf neu gefragt.
 */
export const iceConfig = (roomId, token) =>
  request(appPath(`api/rooms/${encodeURIComponent(roomId)}/ice`), {
    headers: { 'x-room-token': token },
  });

export const burnRoom = (roomId, token) =>
  request(appPath(`api/rooms/${encodeURIComponent(roomId)}`), {
    method: 'DELETE',
    headers: { 'x-room-token': token },
  });

/** Womit spricht dieser Server? WebSocket oder Abholen per HTTP. */
export async function serverConfig() {
  try {
    return await request(appPath('api/config'));
  } catch {
    // Ältere Auslieferung ohne /api/config: dann eben WebSocket.
    return { realtime: 'ws' };
  }
}

/**
 * Baut die passende Verbindung auf. Beide Varianten sehen von aussen gleich
 * aus, damit der Rest der App nicht wissen muss, worauf sie gerade läuft.
 */
export async function createConnection(options) {
  const config = await serverConfig();
  return config.realtime === 'poll'
    ? new PollingConnection({ ...options, config })
    : new SocketConnection(options);
}

// --------------------------------------------------------------- WebSocket

/** Muss zum Server passen (server/ws.js). */
export const SUBPROTOCOL = 'fluesterchat';

/** Schliess-Codes, nach denen ein neuer Versuch keinen Sinn ergibt. */
const FATAL_CLOSE_CODES = new Set([4000, 4003, 4004, 4010]);
const MIN_BACKOFF = 600;
const MAX_BACKOFF = 15_000;

/**
 * WebSocket-Verbindung, die sich selbst wieder aufbaut und Nachrichten
 * zwischenspeichert, solange sie unterbrochen ist.
 */
export class SocketConnection {
  /** @param {{roomId: string, token?: string|null, onFrame: Function, onStatus: Function, onFatal: Function}} opts */
  constructor({ roomId, token, onFrame, onStatus, onFatal }) {
    this.roomId = roomId;
    this.token = token ?? null;
    this.onFrame = onFrame;
    this.onStatus = onStatus ?? (() => {});
    this.onFatal = onFatal ?? (() => {});
    this.socket = null;
    this.queue = [];
    this.attempt = 0;
    this.timer = null;
    this.stopped = false;
    this.status = 'idle';

    this.handleOnline = () => {
      if (this.status !== 'open') this.connect(true);
    };
    this.handleVisibility = () => {
      if (document.visibilityState === 'visible' && this.status !== 'open') this.connect(true);
    };
    window.addEventListener('online', this.handleOnline);
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }

  connect(immediate = false) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (immediate) this.attempt = 0;
    this.setStatus('connecting');

    const query = new URLSearchParams({ r: this.roomId });
    // Das Token reist im Subprotokoll, nicht im Query-String: Query-Strings landen
    // in Reverse-Proxy-Logs, Header-Werte nicht.
    const protocols = this.token ? [SUBPROTOCOL, `t.${this.token}`] : [SUBPROTOCOL];
    const socket = new WebSocket(socketUrl(query), protocols);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
      const pending = this.queue;
      this.queue = [];
      for (const frame of pending) this.send(frame);
    };

    socket.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      this.onFrame(frame);
    };

    socket.onclose = (event) => {
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;
      if (FATAL_CLOSE_CODES.has(event.code)) {
        this.stopped = true;
        this.setStatus('fatal');
        this.onFatal(event.code, event.reason);
        return;
      }
      this.setStatus('reconnecting');
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose kommt gleich hinterher und uebernimmt das Aufraeumen.
    };
  }

  scheduleReconnect() {
    if (this.stopped || this.timer) return;
    const base = Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** this.attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempt = Math.min(this.attempt + 1, 8);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  /** Schickt ein Frame - oder merkt es sich, bis die Leitung wieder steht. */
  send(frame) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(frame));
        return true;
      } catch { /* faellt unten in die Warteschlange */ }
    }
    // Fluechtige Zustandsmeldungen muessen nicht nachgereicht werden.
    if (frame.t === 'typing' || frame.t === 'ping') return false;
    this.queue.push(frame);
    if (this.queue.length > 200) this.queue.shift();
    return false;
  }

  get isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    window.removeEventListener('online', this.handleOnline);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    try {
      this.socket?.close(1000, 'bye');
    } catch { /* egal */ }
    this.socket = null;
    this.setStatus('closed');
  }
}

// ------------------------------------------------------- Abholen statt Zuruf

/** Schliess-Codes, die zu den WebSocket-Varianten passen. */
const STATUS_TO_CLOSE = { 401: 4004, 403: 4003, 404: 4004, 410: 4010 };
const SEND_DEBOUNCE_MS = 25;

/**
 * Gegenstück zu `SocketConnection` für Server ohne WebSocket (z. B. klassischer
 * PHP-Webspace). Neue Ereignisse werden per Long-Polling abgeholt: die Anfrage
 * bleibt beim Server liegen, bis es etwas gibt - dadurch fühlt es sich fast an
 * wie eine echte Verbindung, ohne dauerhaft laufenden Prozess.
 */
export class PollingConnection {
  constructor({ roomId, token, onFrame, onStatus, onFatal, config }) {
    this.roomId = roomId;
    this.token = token ?? null;
    this.onFrame = onFrame;
    this.onStatus = onStatus ?? (() => {});
    this.onFatal = onFatal ?? (() => {});
    this.config = config ?? {};
    this.waitSeconds = Math.max(2, Math.min(60, this.config.pollWaitSeconds ?? 20));

    this.cursor = 0;
    this.status = 'idle';
    this.stopped = false;
    this.outbox = [];
    this.flushTimer = null;
    this.sending = Promise.resolve();
    this.controller = null;
    this.attempt = 0;
    this.retryTimer = null;
    this.members = new Map();
    this.meId = null;

    this.handleOnline = () => this.wake();
    this.handleVisibility = () => {
      if (document.visibilityState === 'visible') this.wake();
    };
    window.addEventListener('online', this.handleOnline);
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }

  get isOpen() {
    return this.status === 'open';
  }

  /** Nach Aufwachen oder Netzwechsel sofort wieder anklopfen. */
  wake() {
    if (this.stopped || this.status === 'open') return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    void this.connect(true);
  }

  async connect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.setStatus('connecting');
    try {
      const welcome = await this.post(appPath(`api/rooms/${encodeURIComponent(this.roomId)}/join`), {
        token: this.token,
      });
      this.token = welcome.you.token;
      this.meId = welcome.you.id;
      this.cursor = welcome.cursor ?? 0;
      this.rememberMembers(welcome.members ?? []);
      this.setStatus('open');
      this.attempt = 0;
      this.onFrame(welcome);
      void this.loop();
      this.scheduleFlush(0);
    } catch (error) {
      this.handleError(error);
    }
  }

  /** Holt in einer Schleife neue Ereignisse ab, solange die Verbindung steht. */
  async loop() {
    while (!this.stopped) {
      const startedAt = Date.now();
      try {
        this.controller = new AbortController();
        const query = new URLSearchParams({ since: String(this.cursor), wait: String(this.waitSeconds) });
        const path = appPath(`api/rooms/${encodeURIComponent(this.roomId)}/events?${query}`);
        const response = await fetch(path, {
          headers: { 'x-room-token': this.token },
          signal: this.controller.signal,
        });
        if (!response.ok) throw await this.toApiError(response);

        const data = await response.json();
        if (this.stopped) return;
        this.setStatus('open');
        this.attempt = 0;
        // Nie zurückfallen: sonst holt man dieselben Ereignisse endlos erneut.
        this.cursor = Math.max(this.cursor, Number(data.cursor) || 0);
        for (const frame of data.frames ?? []) this.onFrame(frame);
        this.applyPresence(data.members ?? []);

        // Notbremse: kommt eine Antwort sofort und ohne Neues zurück, kurz
        // durchatmen, statt den Server im Kreis zu fragen.
        const tookMs = Date.now() - startedAt;
        if (tookMs < 250 && (data.frames ?? []).length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {
        if (this.stopped) return;
        if (error?.name === 'AbortError') return;
        this.handleError(error);
        return;
      }
    }
  }

  /**
   * Meldet Kommen und Gehen des Gegenübers. Beim Abholen gibt es keine
   * Verbindung, die abreissen könnte - also leiten wir die Anwesenheit aus
   * den Zeitstempeln ab, die der Server mitschickt.
   */
  applyPresence(members) {
    for (const member of members) {
      // Die eigenen Zeitstempel ändern sich bei jedem Abruf - die interessieren nicht.
      if (member.id === this.meId) {
        this.members.set(member.id, member);
        continue;
      }
      const previous = this.members.get(member.id);
      this.members.set(member.id, member);
      // Nur echte Wechsel melden. Der Zeitstempel allein ändert sich bei jedem
      // Abruf - würden wir darauf reagieren, baute die App die Nachrichtenliste
      // im Sekundentakt neu auf und man könnte nicht einmal ein Bild antippen.
      const appeared = !previous;
      const changed = previous
        && (previous.online !== member.online || previous.nickCt !== member.nickCt);
      if (appeared || changed) {
        this.onFrame({
          t: 'presence',
          from: member.id,
          online: member.online,
          lastSeen: member.lastSeen,
        });
      }
    }
  }

  rememberMembers(members) {
    for (const member of members) this.members.set(member.id, member);
  }

  send(frame) {
    if (this.stopped) return false;
    // Flüchtige Zustandsmeldungen sind nicht wichtig genug für einen eigenen Umlauf.
    if ((frame.t === 'typing' || frame.t === 'ping') && this.status !== 'open') return false;
    this.outbox.push(frame);
    if (this.outbox.length > 200) this.outbox.shift();
    this.scheduleFlush(SEND_DEBOUNCE_MS);
    return this.status === 'open';
  }

  /** Sammelt kurz, damit aus fünf schnellen Frames ein Umlauf wird. */
  scheduleFlush(delay) {
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.sending = this.sending.then(() => this.flush()).catch(() => {});
    }, delay);
  }

  async flush() {
    if (this.stopped || this.status !== 'open' || this.outbox.length === 0) return;
    const batch = this.outbox.splice(0, 20);
    try {
      const result = await this.post(appPath(`api/rooms/${encodeURIComponent(this.roomId)}/frames`), {
        frames: batch,
      });
      for (const frame of result.direct ?? []) this.onFrame(frame);
      if (this.outbox.length > 0) this.scheduleFlush(0);
    } catch (error) {
      if (error instanceof ApiError && STATUS_TO_CLOSE[error.status]) {
        this.handleError(error);
        return;
      }
      // Nicht zugestellt: zurück in die Warteschlange, ausser bei Flüchtigem.
      const keep = batch.filter((frame) => frame.t !== 'typing' && frame.t !== 'ping');
      this.outbox.unshift(...keep);
      this.setStatus('reconnecting');
      this.scheduleFlush(1500);
    }
  }

  async post(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { 'x-room-token': this.token } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await this.toApiError(response);
    return response.json();
  }

  async toApiError(response) {
    const body = await response.json().catch(() => ({}));
    return new ApiError(body.error ?? 'http_error', body.message ?? response.statusText, response.status);
  }

  handleError(error) {
    const close = error instanceof ApiError ? STATUS_TO_CLOSE[error.status] : null;
    if (close) {
      this.stopped = true;
      this.setStatus('fatal');
      this.onFatal(close, error.code ?? '');
      return;
    }
    this.setStatus('reconnecting');
    const base = Math.min(15000, 600 * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 8);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, base / 2 + Math.random() * (base / 2));
  }

  close() {
    this.stopped = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.retryTimer);
    this.flushTimer = null;
    this.retryTimer = null;
    window.removeEventListener('online', this.handleOnline);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    try {
      this.controller?.abort();
    } catch { /* egal */ }
    this.setStatus('closed');
  }
}
