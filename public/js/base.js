/**
 * Wo liegt die App? Wird aus dem eigenen Modulpfad abgeleitet.
 *
 * Damit laeuft dieselbe Auslieferung unter `/` genauso wie unter `/chats/`,
 * ohne Bauschritt und ohne eingebettetes Skript (die CSP verbietet inline).
 *
 *   .../js/base.js        -> Basis "/"
 *   .../chats/js/base.js  -> Basis "/chats/"
 */

/** Absolute Basis-URL der App, immer mit Schrägstrich am Ende. */
export const baseUrl = new URL('../', import.meta.url);

/** Nur der Pfadteil, z. B. "/" oder "/chats/". */
export const basePath = baseUrl.pathname;

/** Baut eine absolute URL relativ zur App-Basis. */
export const appUrl = (path) => new URL(String(path).replace(/^\//, ''), baseUrl).toString();

/**
 * Pfad relativ zur App-Basis, z. B. "/chats/api/rooms".
 * Ein angehängter Query-String bleibt erhalten - ohne ihn ginge etwa das
 * "since" beim Abholen verloren, und der Client fragte endlos dasselbe ab.
 */
export function appPath(path) {
  const url = new URL(String(path).replace(/^\//, ''), baseUrl);
  return url.pathname + url.search;
}

/** WebSocket-Adresse der App. */
export function socketUrl(query) {
  const url = new URL('ws', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (query) url.search = String(query);
  return url.toString();
}
