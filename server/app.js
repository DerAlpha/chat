import express from 'express';
import { config } from './config.js';
import { callSupport, iceServers } from './ice.js';
import { appVersion } from './version.js';
import { PAGE_SIZE, fetchMedia, searchGifs, verifyRef } from './gifs.js';
import { serverSecret } from './secrets.js';
import { log } from './logger.js';
import { BadRequest, BLOB_ID_RE, ROOM_ID_RE, safeEqual } from './store.js';
import { perHour } from './ratelimit.js';

const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join('; ');

/**
 * @param {import('./store.js').Store} store
 * @param {import('./ws.js').Hub} hub
 */
export function createApp(store, hub) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);
  const base = config.basePath;

  const limits = {
    create: perHour(config.createRoomPerHour),
    join: perHour(config.joinAttemptsPerHour),
    upload: perHour(config.uploadsPerHour),
    gifs: perHour(config.gifSearchesPerHour),
  };
  const sweeper = setInterval(() => {
    for (const limiter of Object.values(limits)) limiter.sweep();
  }, 10 * 60 * 1000);
  if (typeof sweeper.unref === 'function') sweeper.unref();
  app.locals.limits = limits;

  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    // Kamera und Mikrofon ausdruecklich nur fuer die eigene Seite: Anrufe
    // brauchen beides, eingebettete Fremdinhalte gibt es hier ohnehin nicht.
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(), geolocation=(), payment=(), interest-cohort=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });

  // Alles haengt unter `site`, damit die App per BASE_PATH auch in einem
  // Unterordner einer fremden Domain leben kann (z. B. /chats).
  const site = express.Router();

  // Der Client fragt hier, wie er mit diesem Server sprechen soll.
  site.get('/api/config', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      realtime: 'ws',
      backend: 'node',
      // Woran der Browser merkt, dass seine Kopie alt ist.
      version: appVersion(config.publicDir),
      capacity: config.maxMembersPerRoom,
      // Wie gross eine Gruppe hoechstens werden darf. Steht hier, weil es
      // der Server entscheidet - die Oberflaeche soll keine Zahl anbieten,
      // die beim Anlegen dann abgewiesen wird.
      maxGroup: config.maxRoomCapacity,
      limits: {
        maxBlobBytes: config.maxBlobBytes,
        maxCiphertextBytes: config.maxCiphertextBytes,
      },
      // Anrufe laufen zwischen den Browsern und werden immer angeboten;
      // was an Diensten fehlt, sagt die App als Hinweis dazu.
      call: callSupport(config),
      // Ohne Giphy-Schlüssel bleibt die GIF-Suche unsichtbar statt kaputt.
      gifs: Boolean(config.giphyKey),
    });
  });

  site.get('/healthz', (req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()), basePath: base, ...store.stats() });
  });

  const api = express.Router();
  api.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // --- Raum anlegen. Der Client schickt nur den Hash des Codes. ---------------
  // Fuer eine Gruppe kommen die Einmal-Plaetze gleich mit: je Teilnehmer eine
  // Kennung und der Gruppenschluessel, verpackt fuer genau dessen Code. Dieser
  // Server kann keines dieser Pakete oeffnen.
  api.post('/rooms', express.json({ limit: `${8 + config.maxRoomCapacity * 2}kb` }), (req, res) => {
    if (!limits.create.take(clientKey(req))) return tooMany(res, limits.create, clientKey(req));
    const roomId = String(req.body?.roomId ?? '');
    if (!ROOM_ID_RE.test(roomId)) {
      return res.status(400).json({ error: 'bad_room_id', message: 'Ungueltige Raum-ID.' });
    }
    const slots = Array.isArray(req.body?.slots) ? req.body.slots : [];
    let room;
    try {
      room = store.createRoom(roomId, { slots });
    } catch (error) {
      if (error instanceof BadRequest) {
        return res.status(400).json({ error: error.code, message: error.message });
      }
      throw error;
    }
    if (!room) {
      return res.status(409).json({ error: 'room_exists', message: 'Dieser Code ist bereits vergeben.' });
    }
    // Wer eine Gruppe anlegt, hat selbst keinen Code - die hat er gerade fuer
    // die anderen erzeugt. Sein Platz wird deshalb hier gleich besetzt.
    const creator = store.seatCreator(room);
    log.debug(`Raum ${roomId} angelegt (${room.capacity} Plaetze).`);
    res.status(201).json({
      roomId: room.id,
      createdAt: room.createdAt,
      capacity: room.capacity,
      expiresInMs: config.unclaimedRoomTtlMs,
      ...(creator ? { you: { id: creator.id, token: creator.token } } : {}),
    });
  });

  // --- Einen Einmal-Platz einloesen. -----------------------------------------
  // Der Beitretende kennt nur seinen Code, nicht den Raum. Aus dem Code
  // rechnet sein Browser die Platzkennung; die legt er hier vor und bekommt
  // dafuer das verpackte Paket und einen Platz im Raum. Danach ist der Code
  // verbraucht.
  api.post('/slots/:slotId/claim', (req, res) => {
    if (!limits.join.take(clientKey(req))) return tooMany(res, limits.join, clientKey(req));
    const { slotId } = req.params;
    if (!ROOM_ID_RE.test(slotId)) {
      return res.status(400).json({ error: 'bad_slot_id', message: 'Ungueltige Platzkennung.' });
    }
    const ergebnis = store.claimSlot(slotId);
    if (ergebnis.error === 'slot_unknown') {
      // Bewusst dieselbe Antwort wie fuer einen verbrauchten Platz: sonst
      // liesse sich daran ablesen, welche Codes es einmal gegeben hat.
      return res.status(404).json({ error: 'slot_unknown', message: 'Dieser Code gilt nicht (mehr).' });
    }
    if (ergebnis.error === 'slot_used') {
      return res.status(410).json({ error: 'slot_used', message: 'Dieser Code wurde schon eingeloest.' });
    }
    const { room, slot, member } = ergebnis;
    res.json({
      roomId: room.id,
      wrapped: slot.wrapped,
      capacity: room.capacity,
      you: { id: member.id, token: member.token },
    });
  });

  // --- Existenz pruefen, bevor der Client die WebSocket oeffnet. --------------
  api.get('/rooms/:roomId', (req, res) => {
    if (!limits.join.take(clientKey(req))) return tooMany(res, limits.join, clientKey(req));
    const { roomId } = req.params;
    if (!ROOM_ID_RE.test(roomId)) {
      return res.status(400).json({ error: 'bad_room_id', message: 'Ungueltige Raum-ID.' });
    }
    const room = store.getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'room_unknown', message: 'Diesen Chat gibt es nicht (mehr).' });
    res.json({
      roomId: room.id,
      createdAt: room.createdAt,
      members: room.members.size,
      // Die Kapazitaet steht am Raum, nicht in der Konfiguration: ein
      // Zweierchat hat zwei Plaetze, eine Gruppe so viele wie Codes.
      capacity: room.capacity,
      group: room.slots.size > 0,
      full: room.members.size >= room.capacity,
    });
  });

  // --- GIF-Suche ueber das eigene Backend. -----------------------------------
  // Giphy sieht diesen Server, nicht die Nutzer. Der Browser bekommt nur
  // signierte, befristete Verweise - keine einzige Giphy-Adresse.
  api.get('/gifs', async (req, res, next) => {
    try {
      if (!config.giphyKey) {
        return res.status(503).json({ error: 'no_gif_service', message: 'Keine GIF-Suche eingerichtet.' });
      }
      if (!limits.gifs.take(clientKey(req))) return tooMany(res, limits.gifs, clientKey(req));
      const query = String(req.query.q ?? '').slice(0, 80);
      const offset = Number.parseInt(String(req.query.offset ?? '0'), 10) || 0;
      const result = await searchGifs({
        key: config.giphyKey,
        query,
        offset,
        rating: config.giphyRating,
        secret: serverSecret(config.dataDir),
      });
      res.json(result);
    } catch (err) {
      log.warn('GIF-Suche fehlgeschlagen:', err.message);
      res.status(502).json({ error: 'gif_upstream', message: 'Die GIF-Suche antwortet gerade nicht.' });
    }
  });

  // Ein Bild holen. Der Verweis ist signiert - dieser Server holt nichts,
  // was er nicht selbst kurz zuvor ausgegeben hat.
  api.get('/gifs/media', async (req, res) => {
    try {
      if (!config.giphyKey) return res.status(404).end();
      const url = verifyRef(serverSecret(config.dataDir), String(req.query.ref ?? ''));
      if (!url) return res.status(400).json({ error: 'bad_ref', message: 'Verweis ungueltig oder abgelaufen.' });
      const { bytes, mime } = await fetchMedia(url);
      res.setHeader('Content-Type', mime);
      // Der Browser darf das Vorschaubild behalten - es aendert sich nicht.
      res.setHeader('Cache-Control', 'private, max-age=900');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.send(bytes);
    } catch (err) {
      res.status(err.status === 413 ? 413 : 502).json({ error: 'gif_upstream', message: err.message });
    }
  });

  // --- Dienste fuer einen Anruf, mit kurzlebigen Zugangsdaten. ---------------
  // Nur fuer Mitglieder des Raums: sonst waere der Relaisdienst fuer jeden,
  // der die Adresse kennt, eine kostenlose Datenschleuder.
  api.get('/rooms/:roomId/ice', (req, res) => {
    const { room } = authenticate(req, res, store);
    if (!room) return;
    const support = callSupport(config);
    // Die Kennung landet im Benutzernamen und taucht im Protokoll des
    // Relaisdienstes auf - deshalb der Raum nur gekuerzt und gehasht.
    res.json({ ...iceServers(config, { label: room.id.slice(0, 8) }), ...support });
  });

  // --- Verschluesselten Anhang hochladen. ------------------------------------
  api.post(
    '/rooms/:roomId/blobs',
    express.raw({ type: () => true, limit: config.maxBlobBytes + 1024 }),
    async (req, res, next) => {
      try {
        if (!limits.upload.take(clientKey(req))) return tooMany(res, limits.upload, clientKey(req));
        const { room } = authenticate(req, res, store);
        if (!room) return;
        store.sweepOrphanBlobs(room);
        const blob = await store.putBlob(room, req.body);
        res.status(201).json(blob);
      } catch (err) {
        next(err);
      }
    },
  );

  // --- Verschluesselten Anhang holen. ----------------------------------------
  api.get('/rooms/:roomId/blobs/:blobId', async (req, res, next) => {
    try {
      const { room } = authenticate(req, res, store);
      if (!room) return;
      const { blobId } = req.params;
      if (!BLOB_ID_RE.test(blobId)) {
        return res.status(400).json({ error: 'bad_blob_id', message: 'Ungueltige Anhang-ID.' });
      }
      const data = await store.readBlob(room, blobId);
      if (!data) return res.status(404).json({ error: 'blob_unknown', message: 'Anhang nicht gefunden.' });
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(data.length));
      res.send(data);
    } catch (err) {
      next(err);
    }
  });

  // --- Chat komplett loeschen. ----------------------------------------------
  api.delete('/rooms/:roomId', async (req, res, next) => {
    try {
      const { room } = authenticate(req, res, store);
      if (!room) return;
      hub.broadcast(room.id, { t: 'burned' });
      await store.deleteRoom(room.id, 'api-burn');
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  site.use('/api', api);

  // --- Statische Dateien -----------------------------------------------------
  site.use(
    express.static(config.publicDir, {
      index: 'index.html',
      etag: true,
      lastModified: true,
      maxAge: 0,
      setHeaders(res, filePath) {
        if (/[\\/]img[\\/]/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=604800');
        } else if (filePath.endsWith('sw.js')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  // Unbekannte Unterpfade landen auf der Startseite. Wichtig: umleiten statt
  // index.html auszuliefern - die Seite laedt ihre Dateien relativ, und von
  // "/chats/irgendwas" aus zeigten die Verweise ins Leere.
  site.get(/^\/(?!api\/|ws$).*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.redirect(302, `${base}/`);
  });

  if (base) {
    // "/chats" ohne Schraegstrich auf "/chats/" ziehen - sonst loesen die
    // relativen Verweise der Seite gegen "/" statt gegen "/chats/" auf.
    // Genauer Vergleich auf req.path: eine Route "/chats" wuerde in Express 5
    // auch "/chats/" treffen und damit im Kreis umleiten.
    app.use((req, res, next) => {
      if (req.method === 'GET' && req.path === base) return res.redirect(302, `${base}/`);
      return next();
    });
    app.use(base, site);
  } else {
    app.use(site);
  }

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Nicht gefunden.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof BadRequest) {
      return res.status(400).json({ error: err.code, message: err.message });
    }
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      return res.status(413).json({ error: 'too_large', message: 'Datei zu gross.' });
    }
    if (err?.type === 'entity.parse.failed' || err?.status === 400) {
      return res.status(400).json({ error: 'bad_request', message: 'Ungueltige Anfrage.' });
    }
    log.error('Unerwarteter Fehler:', err);
    res.status(500).json({ error: 'server_error', message: 'Interner Fehler.' });
  });

  return app;
}

/** Prueft Raum + Mitglieds-Token. Antwortet selbst im Fehlerfall. */
function authenticate(req, res, store) {
  const { roomId } = req.params;
  if (!ROOM_ID_RE.test(roomId)) {
    res.status(400).json({ error: 'bad_room_id', message: 'Ungueltige Raum-ID.' });
    return {};
  }
  const room = store.getRoom(roomId);
  if (!room) {
    res.status(404).json({ error: 'room_unknown', message: 'Diesen Chat gibt es nicht (mehr).' });
    return {};
  }
  const token = req.get('x-room-token') ?? '';
  const member = [...room.members.values()].find((m) => safeEqual(m.token, token));
  if (!member) {
    res.status(401).json({ error: 'unauthorized', message: 'Kein Zugriff auf diesen Chat.' });
    return {};
  }
  return { room, member };
}

function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function tooMany(res, limiter, key) {
  const retry = Math.max(1, limiter.retryAfter(key));
  res.setHeader('Retry-After', String(retry));
  return res.status(429).json({ error: 'rate_limited', message: 'Zu viele Anfragen.', retryAfter: retry });
}
