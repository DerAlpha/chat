/**
 * Kurzlebige Zugangsdaten für den Relaisdienst.
 *
 * Der Relaisdienst führt keine Benutzerliste. Stattdessen teilen er und das
 * Webbackend ein Geheimnis; aus dem rechnet jede Seite dieselben Zugangsdaten
 * aus. Das Backend gibt sie beim Anruf heraus, der Relaisdienst prüft sie
 * nach - ohne dass die beiden je miteinander reden müssten.
 *
 *   Benutzername = <ablaufzeitpunkt>:<kennung>
 *   Passwort     = base64(HMAC-SHA1(geheimnis, benutzername))
 *
 * Das ist genau das Verfahren, das coturn "TURN REST API" nennt. Es ist hier
 * nicht aus Bequemlichkeit gewählt, sondern weil es die einzige Form ist, die
 * auch ein PHP-Webspace ausstellen kann: eine HMAC-Berechnung, mehr nicht.
 *
 * Wichtig: diese Zugangsdaten schützen den Relaisdienst vor Fremdnutzung.
 * Sie schützen NICHT den Gesprächsinhalt - dafür sorgen die beiden
 * Verschlüsselungsschichten darüber. Wer die Zugangsdaten erbeutet, kann
 * fremde Bandbreite verbrauchen, aber nichts mithören.
 */
import crypto from 'node:crypto';

/** So lange gelten frisch ausgestellte Zugangsdaten. */
export const DEFAULT_TTL_SECONDS = 2 * 60 * 60;

/**
 * @param {string|Buffer} secret Gemeinsames Geheimnis mit dem Webbackend.
 * @param {{ttlSeconds?: number, label?: string, now?: number}} [opts]
 */
export function makeCredentials(secret, opts = {}) {
  const ttl = Number(opts.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const now = opts.now ?? Date.now();
  const label = sanitizeLabel(opts.label ?? '');
  const expiry = Math.floor(now / 1000) + Math.max(60, ttl);
  const username = label ? `${expiry}:${label}` : String(expiry);
  return {
    username,
    password: passwordFor(secret, username),
    expiresAt: expiry * 1000,
  };
}

export function passwordFor(secret, username) {
  return crypto.createHmac('sha1', secret).update(username, 'utf8').digest('base64');
}

/**
 * Prüft einen Benutzernamen und liefert das dazugehörige Passwort - oder
 * `null`, wenn er abgelaufen oder unbrauchbar ist. Der Relaisdienst leitet
 * daraus den Schlüssel für die Signaturprüfung ab.
 */
export function resolvePassword(secret, username, now = Date.now()) {
  if (typeof username !== 'string' || username.length === 0 || username.length > 128) return null;
  const expiry = Number(username.split(':')[0]);
  if (!Number.isFinite(expiry) || expiry <= 0) return null;
  if (expiry * 1000 <= now) return null;
  return passwordFor(secret, username);
}

/** Im Benutzernamen darf kein Doppelpunkt stehen - der trennt schon das Ablaufdatum. */
function sanitizeLabel(label) {
  return String(label).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
}
