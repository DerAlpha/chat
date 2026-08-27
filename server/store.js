import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

/** Raum-IDs sind base64url(SHA-256(code)).slice(0, 22) - der Server sieht den Code nie. */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const BLOB_ID_RE = /^[A-Za-z0-9_-]{22}$/;

const SNAPSHOT_VERSION = 1;

function newId(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export class Store {
  /** @param {{dataDir?: string, now?: () => number}} [opts] */
  constructor(opts = {}) {
    this.dataDir = opts.dataDir ?? config.dataDir;
    this.blobDir = path.join(this.dataDir, 'blobs');
    this.snapshotPath = path.join(this.dataDir, 'rooms.json');
    this.now = opts.now ?? (() => Date.now());
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /**
     * Von der Platzkennung zum Raum. Nur so laesst sich ein Einmal-Code
     * einloesen, ohne dass der Einloesende die Raum-ID schon kennen muesste -
     * er kennt ja nur seinen Code.
     * @type {Map<string, string>}
     */
    this.slotIndex = new Map();
    this.dirty = false;
    this.persistTimer = null;
    this.persistChain = Promise.resolve();
    this.closed = false;
  }

  // ---------------------------------------------------------------- Lifecycle

  async init() {
    await fsp.mkdir(this.blobDir, { recursive: true });
    await this.load();
  }

  async load() {
    let raw;
    try {
      raw = await fsp.readFile(this.snapshotPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('Snapshot nicht lesbar:', err.message);
      return;
    }
    try {
      const data = JSON.parse(raw);
      if (data.version !== SNAPSHOT_VERSION || !Array.isArray(data.rooms)) {
        log.warn('Snapshot hat unbekanntes Format, wird ignoriert.');
        return;
      }
      for (const plain of data.rooms) {
        const room = Room.fromJSON(plain);
        if (room) {
          this.rooms.set(room.id, room);
          for (const slot of room.slots.keys()) this.slotIndex.set(slot, room.id);
        }
      }
      log.info(`Snapshot geladen: ${this.rooms.size} Raum/Raeume.`);
    } catch (err) {
      log.warn('Snapshot beschaedigt, wird ignoriert:', err.message);
    }
  }

  markDirty() {
    if (this.closed) return;
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist().catch((err) => log.error('Persistieren fehlgeschlagen:', err));
    }, config.persistDebounceMs);
    if (typeof this.persistTimer.unref === 'function') this.persistTimer.unref();
  }

  /**
   * Schreibt die Momentaufnahme. Laeufe werden aneinandergereiht, damit sich
   * zwei Schreibvorgaenge nicht ueber dieselbe Datei legen.
   */
  async persist() {
    this.persistChain = this.persistChain
      .catch(() => {})
      .then(() => this.writeSnapshot());
    return this.persistChain;
  }

  async writeSnapshot() {
    if (!this.dirty) return;
    this.dirty = false;
    const payload = JSON.stringify({
      version: SNAPSHOT_VERSION,
      savedAt: this.now(),
      rooms: [...this.rooms.values()].map((room) => room.toJSON()),
    });
    const tmp = `${this.snapshotPath}.${process.pid}.tmp`;
    try {
      await fsp.mkdir(this.dataDir, { recursive: true });
      await fsp.writeFile(tmp, payload, 'utf8');
      await fsp.rename(tmp, this.snapshotPath);
    } catch (err) {
      // Nicht geschrieben heisst weiterhin schmutzig - sonst ginge der Stand verloren.
      this.dirty = true;
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async close() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
    this.closed = true;
  }

  // -------------------------------------------------------------------- Rooms

  getRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    if (this.isExpired(room)) {
      void this.deleteRoom(roomId, 'expired');
      return null;
    }
    return room;
  }

  isExpired(room, now = this.now()) {
    const ttl = room.members.size === 0 ? config.unclaimedRoomTtlMs : config.roomIdleTtlMs;
    return now - room.lastActivity > ttl;
  }

  /**
   * Legt einen Raum an. Gibt `null` zurueck, wenn die ID bereits vergeben ist.
   *
   * Ohne Plaetze entsteht ein Zweierchat wie bisher. Mit Plaetzen eine
   * Gruppe: je Teilnehmer eine Kennung und ein verpacktes Paket, das dieser
   * Server nicht oeffnen kann.
   *
   * @param {string} roomId
   * @param {{slots?: Array<{id: string, wrapped: string}>}} [options]
   */
  createRoom(roomId, { slots = [] } = {}) {
    if (!ROOM_ID_RE.test(roomId)) throw new BadRequest('bad_room_id', 'Ungueltige Raum-ID.');
    if (this.getRoom(roomId)) return null;
    const room = new Room(roomId, this.now());

    if (slots.length) {
      if (slots.length > config.maxRoomCapacity - 1) {
        throw new BadRequest('too_many_slots', 'So gross darf eine Gruppe nicht sein.');
      }
      const gesehen = new Set();
      for (const slot of slots) {
        const id = String(slot?.id ?? '');
        const wrapped = String(slot?.wrapped ?? '');
        if (!ROOM_ID_RE.test(id)) throw new BadRequest('bad_slot_id', 'Ungueltige Platzkennung.');
        if (!wrapped || wrapped.length > config.maxWrappedKeyChars) {
          throw new BadRequest('bad_slot', 'Ungueltiges Platzpaket.');
        }
        // Zwei gleiche Kennungen hiessen: zwei Teilnehmer mit demselben Code.
        if (gesehen.has(id) || this.slotIndex.has(id)) {
          throw new BadRequest('slot_exists', 'Diese Platzkennung ist schon vergeben.');
        }
        gesehen.add(id);
      }
      for (const slot of slots) {
        room.slots.set(slot.id, {
          id: slot.id, wrapped: slot.wrapped, claimedBy: null, claimedAt: null, settled: false,
        });
        this.slotIndex.set(slot.id, roomId);
      }
      // Ein Platz je Teilnehmer, dazu der Platz dessen, der die Gruppe anlegt.
      room.capacity = slots.length + 1;
    }

    this.rooms.set(roomId, room);
    this.markDirty();
    return room;
  }

  /**
   * Loest einen Einmal-Platz ein.
   *
   * Zurueck kommt das verpackte Paket (nur der Code kann es oeffnen) und ein
   * frisches Mitglied samt Token. Danach ist der Platz vergeben.
   *
   * Ein zweiter Versuch mit derselben Kennung ist erlaubt, SOLANGE sich noch
   * niemand damit verbunden hat: reisst die Leitung zwischen Einloesen und
   * Verbinden ab, waere die Person sonst fuer immer ausgesperrt, und der
   * Platz waere fuer immer tot. Sobald die Verbindung einmal stand, ist
   * Schluss - das ist der Moment, ab dem der Code wirklich verbraucht ist.
   */
  claimSlot(slotId) {
    const roomId = this.slotIndex.get(slotId);
    const room = roomId ? this.getRoom(roomId) : null;
    const slot = room?.slots.get(slotId);
    if (!room || !slot) return { error: 'slot_unknown' };

    if (slot.claimedBy) {
      const bekannt = room.members.get(slot.claimedBy);
      if (slot.settled || !bekannt) return { error: 'slot_used' };
      room.touch(this.now());
      this.markDirty();
      return { room, slot, member: bekannt, returning: true };
    }

    const member = {
      id: newId(12),
      token: newId(24),
      joinedAt: this.now(),
      lastSeen: this.now(),
      nickCt: null,
      readSeq: 0,
      slotId,
    };
    room.members.set(member.id, member);
    slot.claimedBy = member.id;
    slot.claimedAt = this.now();
    room.touch(this.now());
    this.markDirty();
    return { room, slot, member, returning: false };
  }

  /**
   * Setzt die Person, die die Gruppe anlegt, auf ihren Platz.
   *
   * Sie hat keinen Code - sie hat die Codes ja gerade erst fuer die anderen
   * erzeugt. Deshalb bekommt sie ihr Token direkt beim Anlegen, und zwar nur
   * dieses eine Mal: danach ist ihr Platz belegt, und der naechste, der es
   * versucht, braucht einen Code.
   */
  seatCreator(room) {
    if (room.slots.size === 0) return null;
    if (room.members.size > 0) return null;
    const member = {
      id: newId(12),
      token: newId(24),
      joinedAt: this.now(),
      lastSeen: this.now(),
      nickCt: null,
      readSeq: 0,
      slotId: null,
    };
    room.members.set(member.id, member);
    room.touch(this.now());
    this.markDirty();
    return member;
  }

  /**
   * Der Platz ist endgueltig verbraucht: jemand hat sich damit verbunden.
   * Ab hier laesst er sich nicht mehr ein zweites Mal einloesen.
   */
  settleSlot(room, memberId) {
    const member = room.members.get(memberId);
    const slot = member?.slotId ? room.slots.get(member.slotId) : null;
    if (!slot || slot.settled) return;
    slot.settled = true;
    this.markDirty();
  }

  /**
   * Beitritt. Mit gueltigem `token` kehrt ein bekanntes Mitglied zurueck,
   * ohne Token wird ein neuer Platz belegt - solange noch einer frei ist.
   */
  joinRoom(room, token) {
    if (token) {
      const member = [...room.members.values()].find((m) => safeEqual(m.token, token));
      if (member) {
        member.lastSeen = this.now();
        room.touch(this.now());
        this.markDirty();
        return { member, returning: true };
      }
      // Unbekanntes Token -> wie ein frischer Beitritt behandeln.
    }
    // In einer Gruppe kommt man nur ueber einen eingeloesten Platz herein.
    // Sonst koennte jeder, der die Raum-ID kennt, sich die freien Plaetze
    // nehmen - bei zwei Personen ein enges Fenster, bei zwoelf eine Tuer.
    if (room.slots.size > 0) {
      return { error: 'need_slot' };
    }
    if (room.members.size >= room.capacity) {
      return { error: 'room_full' };
    }
    const member = {
      id: newId(12),
      token: newId(24),
      joinedAt: this.now(),
      lastSeen: this.now(),
      nickCt: null,
      readSeq: 0,
    };
    room.members.set(member.id, member);
    room.touch(this.now());
    this.markDirty();
    return { member, returning: false };
  }

  async deleteRoom(roomId, reason = 'manual') {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    this.rooms.delete(roomId);
    for (const slot of room.slots.keys()) this.slotIndex.delete(slot);
    this.markDirty();
    await this.removeBlobDir(roomId);
    log.debug(`Raum ${roomId} geloescht (${reason}).`);
    return true;
  }

  /** Entfernt abgelaufene Raeume. @returns {Promise<number>} Anzahl geloeschter Raeume. */
  async cleanup() {
    const now = this.now();
    const doomed = [];
    for (const room of this.rooms.values()) {
      if (this.isExpired(room, now)) doomed.push(room.id);
    }
    for (const id of doomed) await this.deleteRoom(id, 'expired');
    return doomed.length;
  }

  // ----------------------------------------------------------------- Messages

  /**
   * @param {Room} room
   * @param {{id: string}} member
   * @param {string} ct Base64-Chiffrat der kompletten Nachricht.
   * @param {string[]} blobIds Referenzierte Anhaenge (muessen bereits hochgeladen sein).
   */
  appendMessage(room, member, ct, blobIds = []) {
    if (typeof ct !== 'string' || ct.length === 0) {
      throw new BadRequest('empty_message', 'Leere Nachricht.');
    }
    if (Buffer.byteLength(ct, 'utf8') > config.maxCiphertextBytes) {
      throw new BadRequest('message_too_large', 'Nachricht zu gross.');
    }
    const attachments = [];
    for (const blobId of blobIds) {
      const blob = room.blobs.get(blobId);
      if (!blob) throw new BadRequest('unknown_blob', 'Unbekannter Anhang.');
      if (blob.messageId) throw new BadRequest('blob_in_use', 'Anhang bereits verwendet.');
      attachments.push(blobId);
    }
    const message = {
      id: newId(12),
      seq: ++room.seq,
      from: member.id,
      ts: this.now(),
      ct,
      att: attachments,
      deleted: false,
      editedAt: null,
      reactions: {},
    };
    for (const blobId of attachments) room.blobs.get(blobId).messageId = message.id;
    room.messages.push(message);
    if (room.messages.length > config.maxMessagesPerRoom) {
      const dropped = room.messages.splice(0, room.messages.length - config.maxMessagesPerRoom);
      for (const old of dropped) this.releaseAttachments(room, old);
    }
    room.touch(this.now());
    this.markDirty();
    return message;
  }

  editMessage(room, member, messageId, ct) {
    const message = room.messages.find((m) => m.id === messageId);
    if (!message) throw new BadRequest('unknown_message', 'Nachricht nicht gefunden.');
    if (message.from !== member.id) throw new BadRequest('not_owner', 'Fremde Nachricht.');
    if (message.deleted) throw new BadRequest('message_deleted', 'Nachricht ist geloescht.');
    if (Buffer.byteLength(ct, 'utf8') > config.maxCiphertextBytes) {
      throw new BadRequest('message_too_large', 'Nachricht zu gross.');
    }
    message.ct = ct;
    message.editedAt = this.now();
    room.touch(this.now());
    this.markDirty();
    return message;
  }

  /** Loeschen fuer alle: Chiffrat und Anhaenge verschwinden auch auf dem Server. */
  deleteMessage(room, member, messageId) {
    const message = room.messages.find((m) => m.id === messageId);
    if (!message) throw new BadRequest('unknown_message', 'Nachricht nicht gefunden.');
    if (message.from !== member.id) throw new BadRequest('not_owner', 'Fremde Nachricht.');
    if (message.deleted) return message;
    message.deleted = true;
    message.ct = '';
    message.reactions = {};
    this.releaseAttachments(room, message);
    message.att = [];
    room.touch(this.now());
    this.markDirty();
    return message;
  }

  setReaction(room, member, messageId, ct) {
    const message = room.messages.find((m) => m.id === messageId);
    if (!message) throw new BadRequest('unknown_message', 'Nachricht nicht gefunden.');
    if (message.deleted) throw new BadRequest('message_deleted', 'Nachricht ist geloescht.');
    if (ct == null) {
      delete message.reactions[member.id];
    } else {
      if (typeof ct !== 'string' || Buffer.byteLength(ct, 'utf8') > 512) {
        throw new BadRequest('reaction_too_large', 'Reaktion zu gross.');
      }
      message.reactions[member.id] = ct;
    }
    room.touch(this.now());
    this.markDirty();
    return message;
  }

  markRead(room, member, seq) {
    const value = Number(seq);
    if (!Number.isFinite(value) || value < 0) return member.readSeq;
    member.readSeq = Math.max(member.readSeq, Math.min(value, room.seq));
    room.touch(this.now());
    this.markDirty();
    return member.readSeq;
  }

  // -------------------------------------------------------------------- Blobs

  blobPath(roomId, blobId) {
    return path.join(this.blobDir, roomId, `${blobId}.bin`);
  }

  /** @param {Room} room @param {Buffer} data */
  async putBlob(room, data) {
    if (!Buffer.isBuffer(data) || data.length === 0) {
      throw new BadRequest('empty_blob', 'Leerer Anhang.');
    }
    if (data.length > config.maxBlobBytes) {
      throw new BadRequest('blob_too_large', 'Anhang zu gross.');
    }
    if (room.blobBytes + data.length > config.maxRoomBlobBytes) {
      throw new BadRequest('room_quota', 'Speicherplatz des Chats erschoepft.');
    }
    const id = newId(16);
    const target = this.blobPath(room.id, id);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
    room.blobs.set(id, { id, size: data.length, createdAt: this.now(), messageId: null });
    room.blobBytes += data.length;
    room.touch(this.now());
    this.markDirty();
    return { id, size: data.length };
  }

  async readBlob(room, blobId) {
    if (!BLOB_ID_RE.test(blobId) || !room.blobs.has(blobId)) return null;
    try {
      return await fsp.readFile(this.blobPath(room.id, blobId));
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Datei weg, Buchhaltung nachziehen - sonst bleibt das Kontingent belegt.
        const stale = room.blobs.get(blobId);
        room.blobs.delete(blobId);
        if (stale) room.blobBytes = Math.max(0, room.blobBytes - stale.size);
        this.markDirty();
        return null;
      }
      throw err;
    }
  }

  releaseAttachments(room, message) {
    for (const blobId of message.att || []) {
      const blob = room.blobs.get(blobId);
      if (!blob) continue;
      room.blobs.delete(blobId);
      room.blobBytes = Math.max(0, room.blobBytes - blob.size);
      fsp.rm(this.blobPath(room.id, blobId), { force: true }).catch(() => {});
    }
  }

  /** Loescht verwaiste Uploads, die nie an eine Nachricht gebunden wurden. */
  sweepOrphanBlobs(room, maxAgeMs = 30 * 60 * 1000) {
    const now = this.now();
    for (const blob of [...room.blobs.values()]) {
      if (blob.messageId) continue;
      if (now - blob.createdAt < maxAgeMs) continue;
      room.blobs.delete(blob.id);
      room.blobBytes = Math.max(0, room.blobBytes - blob.size);
      fsp.rm(this.blobPath(room.id, blob.id), { force: true }).catch(() => {});
      this.markDirty();
    }
  }

  async removeBlobDir(roomId) {
    await fsp.rm(path.join(this.blobDir, roomId), { recursive: true, force: true }).catch(() => {});
  }

  stats() {
    let messages = 0;
    let bytes = 0;
    for (const room of this.rooms.values()) {
      messages += room.messages.length;
      bytes += room.blobBytes;
    }
    return { rooms: this.rooms.size, messages, blobBytes: bytes };
  }
}

export class Room {
  constructor(id, now) {
    this.id = id;
    this.createdAt = now;
    this.lastActivity = now;
    this.seq = 0;
    /**
     * Wie viele Leute hier hineinpassen. Ein Zweierchat hat zwei Plaetze,
     * eine Gruppe so viele, wie beim Anlegen Codes erzeugt wurden.
     */
    this.capacity = config.maxMembersPerRoom;
    /**
     * Die Einmal-Plaetze einer Gruppe.
     *
     * Je Teilnehmer einer: Kennung (aus seinem Code gerechnet, der Server
     * kennt den Code nie) und der Gruppenschluessel, verpackt fuer genau
     * diesen Code. Der Server kann das Paket nicht oeffnen - er reicht es
     * dem durch, der die passende Kennung vorlegt, und streicht den Platz
     * danach. Ein Zweierchat hat keine Plaetze; dort ist der Code selbst
     * schon der Raum.
     *
     * @type {Map<string, {id:string, wrapped:string, claimedBy:string|null, claimedAt:number|null, settled:boolean}>}
     */
    this.slots = new Map();
    /** @type {Map<string, {id:string, token:string, joinedAt:number, lastSeen:number, nickCt:string|null, readSeq:number}>} */
    this.members = new Map();
    /** @type {Array<object>} */
    this.messages = [];
    /** @type {Map<string, {id:string,size:number,createdAt:number,messageId:string|null}>} */
    this.blobs = new Map();
    this.blobBytes = 0;
  }

  touch(now) {
    this.lastActivity = now;
  }

  /** Oeffentliche Sicht auf ein Mitglied - das Token bleibt geheim. */
  publicMember(member, onlineIds = new Set()) {
    return {
      id: member.id,
      joinedAt: member.joinedAt,
      lastSeen: member.lastSeen,
      nickCt: member.nickCt,
      readSeq: member.readSeq,
      online: onlineIds.has(member.id),
    };
  }

  toJSON() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      seq: this.seq,
      capacity: this.capacity,
      slots: [...this.slots.values()],
      blobBytes: this.blobBytes,
      members: [...this.members.values()],
      messages: this.messages,
      blobs: [...this.blobs.values()],
    };
  }

  static fromJSON(plain) {
    if (!plain || !ROOM_ID_RE.test(plain.id ?? '')) return null;
    const room = new Room(plain.id, plain.createdAt ?? Date.now());
    room.lastActivity = plain.lastActivity ?? room.createdAt;
    room.seq = plain.seq ?? 0;
    // Aeltere Momentaufnahmen kennen weder Kapazitaet noch Plaetze - dann
    // ist es ein Zweierchat, so wie frueher.
    room.capacity = Number.isInteger(plain.capacity) ? plain.capacity : config.maxMembersPerRoom;
    for (const slot of plain.slots ?? []) {
      if (!slot?.id || typeof slot.wrapped !== 'string') continue;
      room.slots.set(slot.id, {
        id: slot.id,
        wrapped: slot.wrapped,
        claimedBy: slot.claimedBy ?? null,
        claimedAt: slot.claimedAt ?? null,
        settled: slot.settled === true,
      });
    }
    room.blobBytes = plain.blobBytes ?? 0;
    for (const member of plain.members ?? []) {
      if (!member?.id || !member?.token) continue;
      room.members.set(member.id, {
        id: member.id,
        token: member.token,
        joinedAt: member.joinedAt ?? room.createdAt,
        lastSeen: member.lastSeen ?? room.createdAt,
        nickCt: member.nickCt ?? null,
        readSeq: member.readSeq ?? 0,
        slotId: member.slotId ?? null,
      });
    }
    room.messages = Array.isArray(plain.messages) ? plain.messages : [];
    for (const blob of plain.blobs ?? []) {
      if (blob?.id) room.blobs.set(blob.id, blob);
    }
    return room;
  }
}

export class BadRequest extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BadRequest';
    this.code = code;
  }
}

/** Zeitkonstanter Vergleich, damit Tokens nicht erraten werden koennen. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
