/** Alles, was mit dem Server spricht: REST fuer Raeume und Anhaenge, WebSocket fuer den Rest. */

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

export const createRoom = (roomId) =>
  request('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId }),
  });

export const roomStatus = (roomId) => request(`/api/rooms/${encodeURIComponent(roomId)}`);

/** Laedt bereits verschluesselte Bytes hoch. */
export async function uploadBlob(roomId, token, bytes, onProgress) {
  // XMLHttpRequest, weil fetch keinen Upload-Fortschritt meldet.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/rooms/${encodeURIComponent(roomId)}/blobs`);
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
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/blobs/${encodeURIComponent(blobId)}`, {
    headers: { 'x-room-token': token },
  });
  if (!response.ok) {
    throw new ApiError('download_failed', 'Anhang nicht abrufbar', response.status);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export const burnRoom = (roomId, token) =>
  request(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: 'DELETE',
    headers: { 'x-room-token': token },
  });

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
export class Connection {
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

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = new URLSearchParams({ r: this.roomId });
    // Das Token reist im Subprotokoll, nicht im Query-String: Query-Strings landen
    // in Reverse-Proxy-Logs, Header-Werte nicht.
    const protocols = this.token ? [SUBPROTOCOL, `t.${this.token}`] : [SUBPROTOCOL];
    const socket = new WebSocket(`${scheme}://${location.host}/ws?${query}`, protocols);
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
