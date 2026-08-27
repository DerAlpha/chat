/**
 * Ein eigener STUN- und TURN-Dienst für Flüsterchat.
 *
 * Wozu das gut ist: bei einem Anruf versuchen beide Geräte zuerst, sich
 * direkt zu finden. In den meisten Heimnetzen klappt das. Hinter strengeren
 * Routern - Mobilfunk, Firmennetze, doppeltes NAT - klappt es nicht, und dann
 * braucht es jemanden in der Mitte, der die Pakete weiterreicht. Genau das
 * tut dieser Dienst.
 *
 * Was er dabei zu sehen bekommt: verschlüsselte Pakete und die IP-Adressen
 * der beiden Seiten. Den Ton oder das Bild sieht er nicht - der Medienstrom
 * ist zweifach verschlüsselt (DTLS-SRTP von WebRTC, darunter noch einmal mit
 * dem Chatschlüssel). Deshalb ist es auch vertretbar, ihn auf einer fremden
 * Maschine laufen zu lassen; nötig ist es nicht.
 *
 * Umgesetzt ist der Teil von RFC 5389 und RFC 5766, den WebRTC benutzt:
 * Binding, Allocate, Refresh, CreatePermission, ChannelBind, Send und Data.
 * Bewusst ohne Fremdbibliothek - ein Dienst, durch den fremde Gespräche
 * laufen, sollte vollständig nachlesbar sein.
 *
 * Er braucht einen eigenen Port und einen dauerhaft laufenden Prozess. Auf
 * klassischem PHP-Webspace (lima-city und Ähnliche) kann er deshalb nicht
 * laufen - dort läuft nur die Aushandlung, und der Rest geht direkt.
 */
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import {
  ATTR, CLASS, ERROR, METHOD, MessageBuilder, checkIntegrity, decode,
  decodeChannelData, encodeChannelData, isChannelData, longTermKey,
} from './stun.js';
import { resolvePassword } from './credentials.js';

const SOFTWARE = 'Fluesterchat TURN';
const TRANSPORT_UDP = 17;

/** Vorgaben, die sich alle über die Umgebung ändern lassen. */
export const DEFAULTS = {
  listenPort: 3478,
  listenAddress: '0.0.0.0',
  /** Die von aussen erreichbare Adresse - hinter NAT nicht dieselbe wie oben. */
  publicAddress: null,
  realm: 'fluesterchat',
  /** Aus diesem Bereich werden die Relais-Ports vergeben. */
  minPort: 49152,
  maxPort: 65535,
  /** Wie lange eine Zuteilung ohne Auffrischen gilt (Sekunden). */
  allocationLifetime: 600,
  maxLifetime: 3600,
  /** Erlaubnis für eine Gegenstelle, in Sekunden (RFC 5766 nennt 300). */
  permissionLifetime: 300,
  channelLifetime: 600,
  /** Obergrenzen, damit niemand den Dienst als Datenschleuder missbraucht. */
  maxAllocations: 500,
  maxAllocationsPerAddress: 10,
  maxPermissionsPerAllocation: 32,
  /** Wie lange eine ausgegebene Nonce gilt (Sekunden). */
  nonceLifetime: 3600,
};

class Allocation {
  constructor({ key, client, socket, username, relayPort }) {
    this.key = key;
    this.client = client;
    this.socket = socket;
    this.username = username;
    this.relayPort = relayPort;
    this.expiresAt = 0;
    /** Gegenstelle "ip" -> Ablaufzeitpunkt. Erlaubnisse gelten je Adresse, nicht je Port. */
    this.permissions = new Map();
    /** Kanalnummer -> { peer: "ip:port", expiresAt } */
    this.channels = new Map();
    /** "ip:port" -> Kanalnummer, für den Rückweg. */
    this.channelByPeer = new Map();
    this.bytesIn = 0;
    this.bytesOut = 0;
  }

  allows(address) {
    const until = this.permissions.get(address);
    return typeof until === 'number' && until > Date.now();
  }
}

export function createTurnServer(options = {}) {
  const config = { ...DEFAULTS, ...options };
  if (!config.secret) throw new Error('Ohne gemeinsames Geheimnis kann der Dienst niemanden prüfen.');
  const log = config.log ?? (() => {});
  const now = config.now ?? (() => Date.now());
  const nonceSecret = crypto.randomBytes(32);

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  /** "ip:port" der Gegenstelle -> Allocation */
  const allocations = new Map();
  /** Wie viele Zuteilungen hat eine IP gerade? */
  const perAddress = new Map();
  /** Läuft nur nach oben - für die Betriebsanzeige und für Tests, die nach
      dem Auflegen noch wissen wollen, ob überhaupt etwas zugeteilt wurde. */
  let allocationsTotal = 0;
  let bytesRelayed = 0;
  let sweeper = null;

  // ------------------------------------------------------------------ Hilfen

  const addressKey = (rinfo) => `${rinfo.address}:${rinfo.port}`;

  function reply(rinfo, buffer) {
    socket.send(buffer, rinfo.port, rinfo.address, (err) => {
      if (err) log('warn', `Antwort an ${addressKey(rinfo)} fehlgeschlagen: ${err.message}`);
    });
  }

  /**
   * Nonce ohne Buchführung: Zeitstempel plus HMAC darüber. So lässt sich das
   * Alter prüfen, ohne für jeden Anfragenden etwas im Speicher zu halten -
   * das wäre sonst ein bequemer Weg, den Dienst vollaufen zu lassen.
   */
  function makeNonce(rinfo) {
    const stamp = Math.floor(now() / 1000).toString(16).padStart(8, '0');
    const mac = crypto.createHmac('sha256', nonceSecret)
      .update(`${stamp}:${rinfo.address}`)
      .digest('hex')
      .slice(0, 24);
    return stamp + mac;
  }

  function nonceValid(nonce, rinfo) {
    if (typeof nonce !== 'string' || nonce.length !== 32) return false;
    const stamp = nonce.slice(0, 8);
    const age = Math.floor(now() / 1000) - parseInt(stamp, 16);
    if (!Number.isFinite(age) || age < -60 || age > config.nonceLifetime) return false;
    const mac = crypto.createHmac('sha256', nonceSecret)
      .update(`${stamp}:${rinfo.address}`)
      .digest('hex')
      .slice(0, 24);
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(nonce.slice(8)));
  }

  function sendError(message, rinfo, [code, reason], { key = null, withNonce = false } = {}) {
    const builder = new MessageBuilder(message.method, CLASS.ERROR, message.transactionId)
      .addError(code, reason)
      .addText(ATTR.SOFTWARE, SOFTWARE);
    if (withNonce) {
      builder.addText(ATTR.REALM, config.realm).addText(ATTR.NONCE, makeNonce(rinfo));
    }
    if (key) builder.sign(key);
    reply(rinfo, builder.addFingerprint().build());
  }

  /**
   * Langzeit-Zugangsdaten prüfen. Ohne Signatur bekommt der Anfragende erst
   * einmal Bereich und Nonce genannt und versucht es damit noch einmal - so
   * sieht RFC 5389 es vor.
   */
  function authenticate(message, rinfo) {
    const username = message.text(ATTR.USERNAME);
    const nonce = message.text(ATTR.NONCE);
    const hasIntegrity = message.attributes.some((a) => a.type === ATTR.MESSAGE_INTEGRITY);
    if (!hasIntegrity || !username || !nonce) {
      sendError(message, rinfo, ERROR.UNAUTHORIZED, { withNonce: true });
      return null;
    }
    if (!nonceValid(nonce, rinfo)) {
      sendError(message, rinfo, ERROR.STALE_NONCE, { withNonce: true });
      return null;
    }
    const password = resolvePassword(config.secret, username, now());
    if (!password) {
      sendError(message, rinfo, ERROR.UNAUTHORIZED, { withNonce: true });
      return null;
    }
    const key = longTermKey(username, config.realm, password);
    if (!checkIntegrity(message, key)) {
      sendError(message, rinfo, ERROR.UNAUTHORIZED, { withNonce: true });
      return null;
    }
    return { username, key };
  }

  // ------------------------------------------------------------- Zuteilungen

  function relayPortInUse(port) {
    for (const allocation of allocations.values()) {
      if (allocation.relayPort === port) return true;
    }
    return false;
  }

  /**
   * Sucht einen freien Port im eingestellten Bereich. Zufällig statt der Reihe
   * nach: sonst wäre von aussen ablesbar, wie viele Gespräche gerade laufen.
   */
  async function bindRelaySocket() {
    const span = config.maxPort - config.minPort + 1;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const port = config.minPort + crypto.randomInt(span);
      if (relayPortInUse(port)) continue;
      const relay = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      const bound = await new Promise((resolve) => {
        relay.once('error', () => resolve(false));
        relay.bind(port, config.listenAddress, () => resolve(true));
      });
      if (bound) return { relay, port };
      relay.close();
    }
    return null;
  }

  function dropAllocation(allocation, reason) {
    if (!allocations.has(allocation.key)) return;
    allocations.delete(allocation.key);
    const address = allocation.client.address;
    const count = (perAddress.get(address) ?? 1) - 1;
    if (count <= 0) perAddress.delete(address);
    else perAddress.set(address, count);
    bytesRelayed += allocation.bytesIn + allocation.bytesOut;
    try { allocation.socket.close(); } catch { /* schon zu */ }
    log('debug', `Zuteilung ${allocation.key} beendet (${reason}), ${allocation.bytesIn}/${allocation.bytesOut} Byte`);
  }

  async function handleAllocate(message, rinfo, auth) {
    const key = addressKey(rinfo);
    const existing = allocations.get(key);
    if (existing) {
      // Wiederholung derselben Anfrage: dieselbe Antwort. Eine andere
      // Vorgangsnummer heisst dagegen, dass jemand doppelt zuteilen will.
      if (existing.transactionId && existing.transactionId.equals(message.transactionId)) {
        return sendAllocateSuccess(existing, message, rinfo, auth.key);
      }
      return sendError(message, rinfo, ERROR.ALLOCATION_MISMATCH, { key: auth.key });
    }

    const transport = message.get(ATTR.REQUESTED_TRANSPORT);
    if (!transport || transport[0] !== TRANSPORT_UDP) {
      return sendError(message, rinfo, ERROR.UNSUPPORTED_TRANSPORT, { key: auth.key });
    }
    if (allocations.size >= config.maxAllocations) {
      return sendError(message, rinfo, ERROR.INSUFFICIENT_CAPACITY, { key: auth.key });
    }
    if ((perAddress.get(rinfo.address) ?? 0) >= config.maxAllocationsPerAddress) {
      return sendError(message, rinfo, ERROR.ALLOCATION_QUOTA, { key: auth.key });
    }

    const bound = await bindRelaySocket();
    if (!bound) return sendError(message, rinfo, ERROR.INSUFFICIENT_CAPACITY, { key: auth.key });

    const allocation = new Allocation({
      key,
      client: { address: rinfo.address, port: rinfo.port },
      socket: bound.relay,
      username: auth.username,
      relayPort: bound.port,
    });
    allocation.transactionId = Buffer.from(message.transactionId);
    allocation.expiresAt = now() + requestedLifetime(message) * 1000;
    allocations.set(key, allocation);
    allocationsTotal += 1;
    perAddress.set(rinfo.address, (perAddress.get(rinfo.address) ?? 0) + 1);

    bound.relay.on('message', (data, peer) => onRelayMessage(allocation, data, peer));
    bound.relay.on('error', (err) => {
      log('warn', `Relais-Port ${bound.port}: ${err.message}`);
      dropAllocation(allocation, 'socket-error');
    });

    log('info', `Zuteilung für ${key} auf Port ${bound.port}`);
    sendAllocateSuccess(allocation, message, rinfo, auth.key);
  }

  function requestedLifetime(message) {
    const raw = message.get(ATTR.LIFETIME);
    if (!raw || raw.length < 4) return config.allocationLifetime;
    const wanted = raw.readUInt32BE(0);
    return Math.min(Math.max(wanted, 60), config.maxLifetime);
  }

  function sendAllocateSuccess(allocation, message, rinfo, key) {
    const lifetime = Math.max(1, Math.round((allocation.expiresAt - now()) / 1000));
    const builder = new MessageBuilder(METHOD.ALLOCATE, CLASS.SUCCESS, message.transactionId)
      .addXorAddress(ATTR.XOR_RELAYED_ADDRESS, config.publicAddress ?? config.listenAddress, allocation.relayPort)
      .addXorAddress(ATTR.XOR_MAPPED_ADDRESS, rinfo.address, rinfo.port)
      .addUInt32(ATTR.LIFETIME, lifetime)
      .addText(ATTR.SOFTWARE, SOFTWARE)
      .sign(key);
    reply(rinfo, builder.addFingerprint().build());
  }

  function handleRefresh(message, rinfo, auth) {
    const allocation = allocations.get(addressKey(rinfo));
    if (!allocation) return sendError(message, rinfo, ERROR.ALLOCATION_MISMATCH, { key: auth.key });

    const raw = message.get(ATTR.LIFETIME);
    const wanted = raw && raw.length >= 4 ? raw.readUInt32BE(0) : config.allocationLifetime;
    if (wanted === 0) {
      dropAllocation(allocation, 'refresh-0');
      const builder = new MessageBuilder(METHOD.REFRESH, CLASS.SUCCESS, message.transactionId)
        .addUInt32(ATTR.LIFETIME, 0)
        .addText(ATTR.SOFTWARE, SOFTWARE)
        .sign(auth.key);
      return reply(rinfo, builder.addFingerprint().build());
    }
    const lifetime = Math.min(Math.max(wanted, 60), config.maxLifetime);
    allocation.expiresAt = now() + lifetime * 1000;
    const builder = new MessageBuilder(METHOD.REFRESH, CLASS.SUCCESS, message.transactionId)
      .addUInt32(ATTR.LIFETIME, lifetime)
      .addText(ATTR.SOFTWARE, SOFTWARE)
      .sign(auth.key);
    reply(rinfo, builder.addFingerprint().build());
  }

  function handleCreatePermission(message, rinfo, auth) {
    const allocation = allocations.get(addressKey(rinfo));
    if (!allocation) return sendError(message, rinfo, ERROR.ALLOCATION_MISMATCH, { key: auth.key });

    // Eine Anfrage darf mehrere Gegenstellen auf einmal nennen.
    const list = readPeerAddresses(message);
    if (!list.length) return sendError(message, rinfo, ERROR.BAD_REQUEST, { key: auth.key });
    for (const peer of list) {
      if (allocation.permissions.size >= config.maxPermissionsPerAllocation
        && !allocation.permissions.has(peer.address)) {
        return sendError(message, rinfo, ERROR.INSUFFICIENT_CAPACITY, { key: auth.key });
      }
      allocation.permissions.set(peer.address, now() + config.permissionLifetime * 1000);
    }
    const builder = new MessageBuilder(METHOD.CREATE_PERMISSION, CLASS.SUCCESS, message.transactionId)
      .addText(ATTR.SOFTWARE, SOFTWARE)
      .sign(auth.key);
    reply(rinfo, builder.addFingerprint().build());
  }

  function handleChannelBind(message, rinfo, auth) {
    const allocation = allocations.get(addressKey(rinfo));
    if (!allocation) return sendError(message, rinfo, ERROR.ALLOCATION_MISMATCH, { key: auth.key });

    const channelRaw = message.get(ATTR.CHANNEL_NUMBER);
    const peer = readPeerAddresses(message)[0];
    if (!channelRaw || channelRaw.length < 2 || !peer) {
      return sendError(message, rinfo, ERROR.BAD_REQUEST, { key: auth.key });
    }
    const channel = channelRaw.readUInt16BE(0);
    // Nur 0x4000-0x7FFF sind gültige Kanalnummern.
    if (channel < 0x4000 || channel > 0x7fff) {
      return sendError(message, rinfo, ERROR.BAD_REQUEST, { key: auth.key });
    }
    const peerKey = `${peer.address}:${peer.port}`;
    const existing = allocation.channels.get(channel);
    if (existing && existing.peer !== peerKey) {
      return sendError(message, rinfo, ERROR.BAD_REQUEST, { key: auth.key });
    }
    const other = allocation.channelByPeer.get(peerKey);
    if (other != null && other !== channel) {
      return sendError(message, rinfo, ERROR.BAD_REQUEST, { key: auth.key });
    }
    allocation.channels.set(channel, { peer: peerKey, expiresAt: now() + config.channelLifetime * 1000 });
    allocation.channelByPeer.set(peerKey, channel);
    // Ein gebundener Kanal bringt die Erlaubnis gleich mit.
    allocation.permissions.set(peer.address, now() + config.permissionLifetime * 1000);

    const builder = new MessageBuilder(METHOD.CHANNEL_BIND, CLASS.SUCCESS, message.transactionId)
      .addText(ATTR.SOFTWARE, SOFTWARE)
      .sign(auth.key);
    reply(rinfo, builder.addFingerprint().build());
  }

  /** Send-Indication: Nutzdaten an eine Gegenstelle, ohne Antwort. */
  function handleSend(message, rinfo) {
    const allocation = allocations.get(addressKey(rinfo));
    if (!allocation) return;
    const peer = readPeerAddresses(message)[0];
    const data = message.get(ATTR.DATA);
    if (!peer || !data) return;
    if (!allocation.allows(peer.address)) return;
    allocation.bytesOut += data.length;
    allocation.socket.send(data, peer.port, peer.address, (err) => {
      if (err) log('debug', `Weiterleiten an ${peer.address}:${peer.port}: ${err.message}`);
    });
  }

  /** Antwort der Gegenstelle: entweder als Kanal-Daten oder als Data-Indication. */
  function onRelayMessage(allocation, data, peer) {
    if (!allocations.has(allocation.key)) return;
    if (!allocation.allows(peer.address)) return;
    allocation.bytesIn += data.length;
    const peerKey = `${peer.address}:${peer.port}`;
    const channel = allocation.channelByPeer.get(peerKey);
    if (channel != null) {
      reply(allocation.client, encodeChannelData(channel, data));
      return;
    }
    const builder = new MessageBuilder(METHOD.DATA, CLASS.INDICATION)
      .addXorAddress(ATTR.XOR_PEER_ADDRESS, peer.address, peer.port)
      .add(ATTR.DATA, data);
    reply(allocation.client, builder.build());
  }

  function onChannelData(buffer, rinfo) {
    const allocation = allocations.get(addressKey(rinfo));
    if (!allocation) return;
    const parsed = decodeChannelData(buffer);
    if (!parsed) return;
    const bound = allocation.channels.get(parsed.channel);
    if (!bound || bound.expiresAt <= now()) return;
    const [address, port] = splitPeer(bound.peer);
    if (!allocation.allows(address)) return;
    allocation.bytesOut += parsed.data.length;
    allocation.socket.send(parsed.data, port, address, (err) => {
      if (err) log('debug', `Kanal ${parsed.channel}: ${err.message}`);
    });
  }

  // ------------------------------------------------------------------ Eingang

  socket.on('message', (buffer, rinfo) => {
    if (isChannelData(buffer)) return onChannelData(buffer, rinfo);
    const message = decode(buffer);
    if (!message) return;

    // Binding braucht keine Anmeldung - das ist der reine STUN-Dienst, mit
    // dem ein Gerät seine eigene öffentliche Adresse erfährt.
    if (message.method === METHOD.BINDING && message.class === CLASS.REQUEST) {
      const builder = new MessageBuilder(METHOD.BINDING, CLASS.SUCCESS, message.transactionId)
        .addXorAddress(ATTR.XOR_MAPPED_ADDRESS, rinfo.address, rinfo.port)
        .addAddress(ATTR.MAPPED_ADDRESS, rinfo.address, rinfo.port)
        .addText(ATTR.SOFTWARE, SOFTWARE);
      return reply(rinfo, builder.addFingerprint().build());
    }

    if (message.class === CLASS.INDICATION) {
      // Indications tragen keine Signatur - sie gelten nur innerhalb einer
      // bestehenden Zuteilung, und die ist an die Absenderadresse gebunden.
      if (message.method === METHOD.SEND) handleSend(message, rinfo);
      return;
    }

    if (message.class !== CLASS.REQUEST) return;

    const auth = authenticate(message, rinfo);
    if (!auth) return;

    switch (message.method) {
      case METHOD.ALLOCATE:
        return void handleAllocate(message, rinfo, auth).catch((err) => {
          log('error', `Allocate fehlgeschlagen: ${err.message}`);
          sendError(message, rinfo, ERROR.SERVER_ERROR, { key: auth.key });
        });
      case METHOD.REFRESH:
        return handleRefresh(message, rinfo, auth);
      case METHOD.CREATE_PERMISSION:
        return handleCreatePermission(message, rinfo, auth);
      case METHOD.CHANNEL_BIND:
        return handleChannelBind(message, rinfo, auth);
      default:
        return sendError(message, rinfo, ERROR.BAD_REQUEST, { key: auth.key });
    }
  });

  socket.on('error', (err) => log('error', `Hauptport: ${err.message}`));

  // --------------------------------------------------------------- Aufräumen

  function sweep() {
    const stamp = now();
    for (const allocation of [...allocations.values()]) {
      if (allocation.expiresAt <= stamp) {
        dropAllocation(allocation, 'abgelaufen');
        continue;
      }
      for (const [address, until] of allocation.permissions) {
        if (until <= stamp) allocation.permissions.delete(address);
      }
      for (const [channel, bound] of allocation.channels) {
        if (bound.expiresAt > stamp) continue;
        allocation.channels.delete(channel);
        allocation.channelByPeer.delete(bound.peer);
      }
    }
  }

  return {
    config,
    get allocationCount() { return allocations.size; },
    get allocationsTotal() { return allocationsTotal; },
    /** Byte, die seit dem Start durch den Dienst gelaufen sind. */
    get bytesRelayed() {
      let laufend = 0;
      for (const allocation of allocations.values()) laufend += allocation.bytesIn + allocation.bytesOut;
      return bytesRelayed + laufend;
    },
    /** Nur für Tests und die Betriebsanzeige. */
    _allocations: allocations,
    async listen() {
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(config.listenPort, config.listenAddress, resolve);
      });
      sweeper = setInterval(sweep, 5000);
      if (typeof sweeper.unref === 'function') sweeper.unref();
      return socket.address();
    },
    async close() {
      if (sweeper) clearInterval(sweeper);
      sweeper = null;
      for (const allocation of [...allocations.values()]) dropAllocation(allocation, 'shutdown');
      await new Promise((resolve) => socket.close(resolve));
    },
  };
}

// ------------------------------------------------------------------- Hilfen

/** Liest alle XOR-PEER-ADDRESS-Attribute, nicht nur das erste. */
function readPeerAddresses(message) {
  const out = [];
  for (const attr of message.attributes) {
    if (attr.type !== ATTR.XOR_PEER_ADDRESS) continue;
    const peer = xorPeer(attr.value, message.transactionId);
    if (peer) out.push(peer);
  }
  return out;
}

function xorPeer(value, transactionId) {
  if (!value || value.length < 8) return null;
  const cookie = Buffer.alloc(4);
  cookie.writeUInt32BE(0x2112a442);
  const port = value.readUInt16BE(2) ^ 0x2112;
  if (value[1] === 0x01) {
    const out = Buffer.alloc(4);
    for (let i = 0; i < 4; i += 1) out[i] = value[4 + i] ^ cookie[i];
    return { family: 'IPv4', address: [...out].join('.'), port };
  }
  if (value[1] === 0x02 && value.length >= 20) {
    const mask = Buffer.concat([cookie, transactionId]);
    const out = Buffer.alloc(16);
    for (let i = 0; i < 16; i += 1) out[i] = value[4 + i] ^ mask[i];
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(out.readUInt16BE(i).toString(16));
    return { family: 'IPv6', address: parts.join(':'), port };
  }
  return null;
}

function splitPeer(key) {
  const index = key.lastIndexOf(':');
  return [key.slice(0, index), Number(key.slice(index + 1))];
}
