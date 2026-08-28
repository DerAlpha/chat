import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { SUBPROTOCOL } from '../server/ws.js';

export async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluesterchat-test-'));
  const app = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  const ctx = {
    ...app,
    base: `http://127.0.0.1:${app.port}`,
    wsBase: `ws://127.0.0.1:${app.port}`,
    dataDir,
  };
  try {
    return await fn(ctx);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Eine WebSocket-Verbindung, die alle empfangenen Frames mitschreibt. */
export class TestClient {
  /** @param {Record<string, string>} [headers] Zusaetzliche Kopfzeilen - fuer Tests, die einen Proxy nachstellen. */
  constructor(ctx, roomId, token, headers) {
    this.frames = [];
    this.consumed = 0;
    // Das Token reist wie im Browser im Subprotokoll, nicht im Query-String.
    const protocols = token ? [SUBPROTOCOL, `t.${token}`] : [SUBPROTOCOL];
    this.ws = new WebSocket(`${ctx.wsBase}/ws?r=${encodeURIComponent(roomId)}`, protocols,
      headers ? { headers } : undefined);
    this.closed = null;
    this.ws.on('message', (data) => this.frames.push(JSON.parse(data.toString('utf8'))));
    this.ws.on('close', (code, reason) => { this.closed = { code, reason: reason.toString() }; });
  }

  opened() {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve(this));
      this.ws.once('error', reject);
      this.ws.once('close', (code, reason) => reject(new Error(`closed ${code} ${reason}`)));
    });
  }

  /** Wartet auf das naechste noch nicht gelesene Frame eines Typs. */
  next(type, timeoutMs = 3000) {
    const fromIndex = this.consumed;
    return new Promise((resolve, reject) => {
      const scan = () => {
        for (let i = fromIndex; i < this.frames.length; i += 1) {
          if (this.frames[i].t === type) {
            this.consumed = i + 1;
            return this.frames[i];
          }
        }
        return null;
      };
      const immediate = scan();
      if (immediate) return resolve(immediate);
      const timer = setTimeout(() => {
        this.ws.off('message', onMessage);
        reject(new Error(`Timeout beim Warten auf "${type}". Gesehen: ${this.frames.map((f) => f.t).join(', ')}`));
      }, timeoutMs);
      const onMessage = () => {
        const found = scan();
        if (!found) return;
        clearTimeout(timer);
        this.ws.off('message', onMessage);
        resolve(found);
      };
      this.ws.on('message', onMessage);
    });
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame));
    return this;
  }

  /** Wartet, bis die Verbindung geschlossen wurde, und liefert Code + Grund. */
  waitClose(timeoutMs = 3000) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout beim Warten auf close')), timeoutMs);
      this.ws.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

/** Legt einen Raum an und verbindet die gewuenschte Zahl von Mitgliedern. */
export async function makeRoom(ctx, roomId = randomRoomId()) {
  const res = await fetch(`${ctx.base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId }),
  });
  if (res.status !== 201) throw new Error(`Raum anlegen fehlgeschlagen: ${res.status}`);
  return roomId;
}

export function randomRoomId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < 22; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
