/**
 * GIF-Suche, ohne die Privatsphäre aufzugeben.
 *
 * Der naheliegende Weg wäre, den Browser direkt mit Giphy reden zu lassen.
 * Dann wüsste Giphy: diese IP-Adresse, dieses Gerät, dieser Suchbegriff, zu
 * dieser Uhrzeit. Und beim Betrachten im Chat noch einmal - bei jedem, dem
 * das GIF geschickt wurde. Das ist genau die Spur, die diese Anwendung sonst
 * überall vermeidet.
 *
 * Deshalb läuft alles über das eigene Backend:
 *
 *   1. Die Suche geht von hier aus zu Giphy. Giphy sieht den Server, nicht
 *      den Nutzer.
 *   2. Die Vorschaubilder holt ebenfalls der Server. Der Browser lädt sie
 *      von der eigenen Adresse - die strenge CSP bleibt unangetastet.
 *   3. Beim Verschicken holt der Server das GIF, der Browser verschlüsselt
 *      es und lädt es als ganz normalen Anhang hoch. Wer es empfängt,
 *      spricht nie mit Giphy.
 *
 * Der Schlüssel bleibt auf dem Server und erreicht den Browser nie.
 */
import crypto from 'node:crypto';

const GIPHY_HOST = 'api.giphy.com';
/** Nur von dort holen wir Bilder - sonst wäre das hier ein offener Proxy. */
const MEDIA_HOST_RE = /(^|\.)giphy\.com$/;

/** Höchstens so viele Treffer je Seite - jede Vorschau kostet Bandbreite. */
export const PAGE_SIZE = 12;
/** Grösser holen wir kein GIF zum Verschicken. */
const MAX_SEND_BYTES = 8 * 1024 * 1024;
/**
 * So lange gilt ein ausgegebener Verweis auf ein Bild.
 *
 * Gerechnet wird in Sekunden, nicht in Millisekunden - genau wie im
 * PHP-Backend. Beide Fassungen erzeugen damit für dasselbe Geheimnis,
 * dieselbe Adresse und denselben Zeitpunkt buchstäblich denselben Verweis.
 * Das ist keine Spielerei: ein Test rechnet das gegeneinander nach und
 * würde merken, wenn die beiden Backends auseinanderlaufen.
 */
const TOKEN_TTL_SECONDS = 30 * 60;

/**
 * Ein Verweis auf ein Bild bei Giphy, signiert und befristet.
 *
 * Der Browser bekommt nie eine Giphy-Adresse zu sehen, und niemand kann
 * diesen Server benutzen, um sich beliebige fremde Adressen holen zu lassen:
 * ohne gültige Signatur wird nichts abgerufen.
 */
export function signRef(secret, url, now = Date.now()) {
  const expiry = Math.floor(now / 1000) + TOKEN_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ u: url, e: expiry }), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 32);
  return `${payload}.${mac}`;
}

export function verifyRef(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 32);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.u !== 'string' || typeof parsed.e !== 'number') return null;
  if (parsed.e <= Math.floor(now / 1000)) return null;
  if (!allowedMedia(parsed.u)) return null;
  return parsed.u;
}

export function allowedMedia(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && MEDIA_HOST_RE.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Wählt aus den vielen Grössen, die Giphy anbietet, die passende aus.
 * Für die Übersicht das kleinste bewegte Bild - 26 KB statt 200 KB machen
 * bei zwölf Treffern den Unterschied zwischen flott und zäh.
 */
function pickPreview(images) {
  const bevorzugt = [
    'preview_webp',              // ~26 KB, bewegt
    'preview_gif',               // ~47 KB, bewegt
    'fixed_width_small_still',   // ~5 KB, steht still
    'fixed_height_small_still',
    'fixed_width_downsampled',   // ~83 KB - Notnagel
    'fixed_width_small',
  ];
  for (const name of bevorzugt) {
    const entry = images?.[name];
    if (entry?.url) return entry;
  }
  return null;
}

/** Zum Verschicken das kleinste, das noch ordentlich aussieht. */
function pickFull(images) {
  const candidates = ['downsized_medium', 'downsized', 'fixed_width', 'original'];
  let fallback = null;
  for (const name of candidates) {
    const entry = images?.[name];
    if (!entry?.url) continue;
    const size = Number(entry.size ?? 0);
    if (size > 0 && size <= MAX_SEND_BYTES) return entry;
    fallback ??= entry;
  }
  return fallback;
}

/**
 * Sucht bei Giphy und gibt nur das zurück, was der Browser wirklich braucht.
 * Titel und Grösse für die Darstellung, zwei signierte Verweise - sonst
 * nichts. Keine Giphy-Adressen, keine Kennungen, nichts zum Nachverfolgen.
 */
export async function searchGifs({ key, query, offset = 0, rating = 'pg-13', lang = 'de', secret, fetchImpl = fetch, now = Date.now() }) {
  const url = new URL(`https://${GIPHY_HOST}/v1/gifs/${query ? 'search' : 'trending'}`);
  url.searchParams.set('api_key', key);
  if (query) url.searchParams.set('q', query);
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('offset', String(Math.max(0, Math.min(offset, 500))));
  url.searchParams.set('rating', rating);
  // Bewusst ohne "bundle": die schlanken Bundles enthalten ausgerechnet die
  // kleinen Vorschaugrössen nicht, und dann kämen statt 26 KB je Bild
  // 200 KB über den eigenen Server. Bei zwölf Treffern ist das der
  // Unterschied zwischen flott und zäh.
  if (query) url.searchParams.set('lang', lang);

  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error = new Error(`Giphy antwortete mit ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const body = await response.json();
  const items = [];
  for (const entry of body?.data ?? []) {
    const preview = pickPreview(entry.images);
    const full = pickFull(entry.images);
    if (!preview || !full || !allowedMedia(preview.url) || !allowedMedia(full.url)) continue;
    items.push({
      id: String(entry.id ?? ''),
      title: String(entry.title ?? '').slice(0, 120),
      width: Number(preview.width) || 100,
      height: Number(preview.height) || 100,
      preview: signRef(secret, preview.url, now),
      full: signRef(secret, full.url, now),
      bytes: Number(full.size) || 0,
    });
  }
  const pagination = body?.pagination ?? {};
  const nextOffset = Number(pagination.offset ?? 0) + Number(pagination.count ?? items.length);
  return {
    items,
    next: items.length === PAGE_SIZE && nextOffset < Number(pagination.total_count ?? 0) ? nextOffset : null,
  };
}

/** Holt ein Bild bei Giphy und reicht es unverändert weiter. */
export async function fetchMedia(url, { fetchImpl = fetch, maxBytes = MAX_SEND_BYTES } = {}) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    const error = new Error(`Giphy antwortete mit ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    const error = new Error('Das GIF ist zu gross.');
    error.status = 413;
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    const error = new Error('Das GIF ist zu gross.');
    error.status = 413;
    throw error;
  }
  const type = response.headers.get('content-type') ?? '';
  // Nur Bilder weiterreichen - was sonst käme, wollen wir nicht ausliefern.
  const mime = /^image\/(gif|webp|png|jpeg)$/.test(type) ? type : 'application/octet-stream';
  return { bytes: buffer, mime };
}
