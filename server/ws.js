import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { log } from './logger.js';
import { BadRequest, ROOM_ID_RE } from './store.js';
import { perMinute } from './ratelimit.js';

const WELCOME_HISTORY = config.welcomeHistory;
export const SUBPROTOCOL = 'fluesterchat';
const TOKEN_PREFIX = 't.';
/** Leichte Frames sollen echte Nachrichten nicht aus dem Budget draengen. */
const FRAME_COST = { ping: 0, typing: 0.1, read: 0.1, history: 0.5 };
const MAX_HISTORY_PAGE = 300;

/** Schliess-Codes im privaten Bereich (4000-4999). */
export const CLOSE = {
  ROOM_UNKNOWN: 4004,
  ROOM_FULL: 4003,
  BAD_REQUEST: 4000,
  TOO_MANY_SOCKETS: 4029,
  BURNED: 4010,
};

export class Hub {
  /** @param {import('./store.js').Store} store */
  constructor(store) {
    this.store = store;
    /** @type {Map<string, Map<string, Set<import('ws').WebSocket>>>} roomId -> memberId -> sockets */
    this.presence = new Map();
    this.messageLimiter = perMinute(config.messagesPerMinute);
    // Etwas Luft ueber dem fachlichen Limit: leichte Ueberschreitungen sollen eine
    // saubere Fehlermeldung bekommen, wirklich absurde Frames trennt die Transportebene.
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: Math.ceil(config.maxCiphertextBytes * 1.5) + 8192,
      // Der Client bietet ['fluesterchat', 't.<token>'] an; bestaetigt wird nur
      // der Protokollname, das Token ist nur ein Transportmittel.
      handleProtocols: () => SUBPROTOCOL,
    });
    this.heartbeat = setInterval(() => this.pingAll(), config.heartbeatIntervalMs);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
  }

  close() {
    clearInterval(this.heartbeat);
    for (const socket of this.wss.clients) {
      try {
        socket.close(1001, 'server shutdown');
      } catch { /* egal */ }
    }
    this.wss.close();
  }

  // ------------------------------------------------------------------ Upgrade

  handleUpgrade(request, socket, head) {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      return destroy(socket, 400);
    }
    if (url.pathname !== `${config.basePath}/ws`) return destroy(socket, 404);

    const roomId = url.searchParams.get('r') ?? '';
    // Das Token kommt im Subprotokoll-Header statt im Query-String: Query-Strings
    // stehen in fast jedem Reverse-Proxy-Log, Header-Werte nicht.
    const token = readToken(request.headers['sec-websocket-protocol']);
    if (!ROOM_ID_RE.test(roomId)) return destroy(socket, 400);

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
      this.onConnection(ws, roomId, token);
    });
  }

  onConnection(ws, roomId, token) {
    // Muss ganz oben stehen: ein 'error'-Ereignis ohne Listener beendet den
    // Prozess, und die Abbruchpfade unten schliessen den Socket sofort.
    ws.on('error', (err) => log.debug('WS-Fehler:', err.message));

    const room = this.store.getRoom(roomId);
    if (!room) return ws.close(CLOSE.ROOM_UNKNOWN, 'room_unknown');

    const result = this.store.joinRoom(room, token || null);
    if (result.error) return ws.close(CLOSE.ROOM_FULL, result.error);
    const member = result.member;

    const sockets = this.socketsFor(roomId, member.id);
    if (sockets.size >= config.maxSocketsPerMember) {
      ws.close(CLOSE.TOO_MANY_SOCKETS, 'too_many_sockets');
      this.pruneEmpty(roomId, member.id);
      return;
    }
    const wasOffline = sockets.size === 0;
    sockets.add(ws);

    ws.isAlive = true;
    ws.roomId = roomId;
    ws.memberId = member.id;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => this.onMessage(ws, data, isBinary));
    ws.on('close', () => this.onClose(ws));

    const history = room.messages.slice(-WELCOME_HISTORY);
    send(ws, {
      t: 'welcome',
      now: Date.now(),
      you: { id: member.id, token: member.token, returning: result.returning },
      room: {
        id: room.id,
        createdAt: room.createdAt,
        seq: room.seq,
        capacity: config.maxMembersPerRoom,
        limits: {
          maxBlobBytes: config.maxBlobBytes,
          maxCiphertextBytes: config.maxCiphertextBytes,
        },
      },
      members: [...room.members.values()].map((m) => room.publicMember(m, this.onlineIds(roomId))),
      messages: history,
      hasMore: room.messages.length > history.length,
    });

    if (wasOffline) {
      this.broadcast(roomId, { t: 'presence', from: member.id, online: true, lastSeen: member.lastSeen }, ws);
    }
    log.debug(`Beitritt ${roomId}/${member.id} (returning=${result.returning}).`);
  }

  onClose(ws) {
    const { roomId, memberId } = ws;
    if (!roomId || !memberId) return;
    const byMember = this.presence.get(roomId);
    const sockets = byMember?.get(memberId);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size > 0) return;
    byMember.delete(memberId);
    if (byMember.size === 0) this.presence.delete(roomId);

    const room = this.store.rooms.get(roomId);
    const member = room?.members.get(memberId);
    if (member) {
      member.lastSeen = Date.now();
      this.store.markDirty();
      this.broadcast(roomId, { t: 'presence', from: memberId, online: false, lastSeen: member.lastSeen });
    }
  }

  // ------------------------------------------------------------------ Frames

  onMessage(ws, data, isBinary) {
    if (isBinary) return sendError(ws, 'binary_not_allowed', 'Binaerdaten sind hier nicht erlaubt.');
    let frame;
    try {
      frame = JSON.parse(data.toString('utf8'));
    } catch {
      return sendError(ws, 'bad_json', 'Ungueltiges JSON.');
    }
    if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string') {
      return sendError(ws, 'bad_frame', 'Ungueltiges Format.');
    }

    const room = this.store.getRoom(ws.roomId);
    if (!room) {
      ws.close(CLOSE.ROOM_UNKNOWN, 'room_unknown');
      return;
    }
    const member = room.members.get(ws.memberId);
    if (!member) {
      ws.close(CLOSE.ROOM_UNKNOWN, 'member_unknown');
      return;
    }
    member.lastSeen = Date.now();

    const cost = FRAME_COST[frame.t] ?? 1;
    if (cost > 0 && !this.messageLimiter.take(`${ws.roomId}:${ws.memberId}`, cost)) {
      return sendError(ws, 'rate_limited', 'Zu viele Nachrichten. Kurz durchatmen.', frame.cid);
    }

    try {
      this.dispatch(ws, room, member, frame);
    } catch (err) {
      if (err instanceof BadRequest) {
        sendError(ws, err.code, err.message, frame.cid);
      } else {
        log.error('Frame-Verarbeitung fehlgeschlagen:', err);
        sendError(ws, 'server_error', 'Interner Fehler.', frame.cid);
      }
    }
  }

  dispatch(ws, room, member, frame) {
    switch (frame.t) {
      case 'ping':
        return send(ws, { t: 'pong', now: Date.now() });

      case 'msg': {
        const blobs = Array.isArray(frame.blobs) ? frame.blobs.slice(0, 4) : [];
        const message = this.store.appendMessage(room, member, frame.ct, blobs);
        send(ws, { t: 'ack', cid: frame.cid ?? null, id: message.id, seq: message.seq, ts: message.ts });
        // Alle anderen Sockets im Raum - also der Gegenueber und eigene Zweitgeraete.
        this.broadcast(room.id, { t: 'msg', message }, ws);
        return;
      }

      case 'edit': {
        const message = this.store.editMessage(room, member, String(frame.id ?? ''), String(frame.ct ?? ''));
        return this.broadcast(room.id, { t: 'edit', id: message.id, ct: message.ct, editedAt: message.editedAt });
      }

      case 'del': {
        const message = this.store.deleteMessage(room, member, String(frame.id ?? ''));
        return this.broadcast(room.id, { t: 'del', id: message.id });
      }

      case 'react': {
        const ct = frame.ct == null ? null : String(frame.ct);
        const message = this.store.setReaction(room, member, String(frame.id ?? ''), ct);
        return this.broadcast(room.id, { t: 'react', id: message.id, from: member.id, ct });
      }

      case 'read': {
        const seq = this.store.markRead(room, member, frame.seq);
        return this.broadcast(room.id, { t: 'read', from: member.id, seq }, ws);
      }

      case 'typing': {
        const on = frame.on === true;
        return this.broadcast(room.id, { t: 'typing', from: member.id, on }, ws);
      }

      case 'nick': {
        const ct = frame.ct == null ? null : String(frame.ct);
        if (ct && Buffer.byteLength(ct, 'utf8') > 1024) {
          throw new BadRequest('nick_too_large', 'Name zu lang.');
        }
        member.nickCt = ct;
        this.store.markDirty();
        return this.broadcast(room.id, { t: 'nick', from: member.id, ct }, ws);
      }

      case 'history': {
        const before = Number(frame.before);
        const limit = Math.min(MAX_HISTORY_PAGE, Math.max(1, Number(frame.limit) || 100));
        const older = room.messages.filter((m) => m.seq < before);
        const page = older.slice(-limit);
        return send(ws, {
          t: 'history',
          messages: page,
          hasMore: older.length > page.length,
        });
      }

      case 'burn': {
        this.broadcast(room.id, { t: 'burned' });
        const roomId = room.id;
        void this.store.deleteRoom(roomId, 'burn').then(() => {
          for (const socket of this.socketsInRoom(roomId)) {
            try {
              socket.close(CLOSE.BURNED, 'burned');
            } catch { /* egal */ }
          }
        });
        return;
      }

      default:
        return sendError(ws, 'unknown_frame', `Unbekannter Typ: ${frame.t}`, frame.cid);
    }
  }

  // ------------------------------------------------------------------ Helpers

  socketsFor(roomId, memberId) {
    let byMember = this.presence.get(roomId);
    if (!byMember) {
      byMember = new Map();
      this.presence.set(roomId, byMember);
    }
    let sockets = byMember.get(memberId);
    if (!sockets) {
      sockets = new Set();
      byMember.set(memberId, sockets);
    }
    return sockets;
  }

  /** Entfernt leere Praesenz-Eintraege, damit die Map nicht waechst. */
  pruneEmpty(roomId, memberId) {
    const byMember = this.presence.get(roomId);
    if (!byMember) return;
    if (byMember.get(memberId)?.size === 0) byMember.delete(memberId);
    if (byMember.size === 0) this.presence.delete(roomId);
  }

  onlineIds(roomId) {
    return new Set(this.presence.get(roomId)?.keys() ?? []);
  }

  *socketsInRoom(roomId) {
    const byMember = this.presence.get(roomId);
    if (!byMember) return;
    for (const sockets of byMember.values()) yield* sockets;
  }

  /** An alle im Raum, optional ohne den Absender-Socket. */
  broadcast(roomId, payload, exclude = null) {
    const text = JSON.stringify(payload);
    for (const socket of this.socketsInRoom(roomId)) {
      if (socket === exclude) continue;
      sendRaw(socket, text);
    }
  }

  pingAll() {
    for (const socket of this.wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch { /* egal */ }
    }
    this.messageLimiter.sweep();
  }
}

function send(ws, payload) {
  sendRaw(ws, JSON.stringify(payload));
}

function sendRaw(ws, text) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(text);
  } catch (err) {
    log.debug('Senden fehlgeschlagen:', err.message);
  }
}

function sendError(ws, code, msg, cid) {
  send(ws, { t: 'err', code, msg, cid: cid ?? null });
}

/** Liest `t.<token>` aus der angebotenen Subprotokoll-Liste. */
function readToken(header) {
  if (!header) return '';
  for (const raw of String(header).split(',')) {
    const value = raw.trim();
    if (value.startsWith(TOKEN_PREFIX)) return value.slice(TOKEN_PREFIX.length);
  }
  return '';
}

function destroy(socket, status) {
  const reason = status === 404 ? 'Not Found' : 'Bad Request';
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
