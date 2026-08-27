/**
 * Die Liste der Aushandlungs- und Relaisdienste für einen Anruf.
 *
 * Der Browser bekommt hier kurzlebige Zugangsdaten für den eigenen
 * Relaisdienst - ausgerechnet aus einem Geheimnis, das nur Backend und Dienst
 * kennen. Der Dienst führt selbst keine Benutzerliste; er rechnet dasselbe
 * nach. Deshalb kann er auf einer anderen Maschine stehen als die Webseite,
 * und deshalb kann ihn ausgerechnet ein PHP-Webspace mit ausstellen, auf dem
 * er selbst nie laufen könnte.
 *
 * Die Zugangsdaten schützen vor Fremdnutzung der Bandbreite, nicht vor
 * Mithören: der Medienstrom ist zweifach verschlüsselt, bevor er den Dienst
 * überhaupt erreicht.
 */
import { makeCredentials } from '../turn/credentials.js';

/**
 * @param {object} config Serverkonfiguration.
 * @param {{label?: string, now?: number}} [opts] Kennung für die Zugangsdaten.
 */
export function iceServers(config, opts = {}) {
  const servers = [];
  for (const urls of config.stunUrls ?? []) {
    servers.push({ urls });
  }
  if ((config.turnUrls ?? []).length && config.turnSecret) {
    const credentials = makeCredentials(config.turnSecret, {
      ttlSeconds: config.turnTtlSeconds,
      label: opts.label ?? '',
      now: opts.now,
    });
    servers.push({
      urls: [...config.turnUrls],
      username: credentials.username,
      credential: credentials.password,
    });
    return { iceServers: servers, expiresAt: credentials.expiresAt };
  }
  return { iceServers: servers, expiresAt: null };
}

/**
 * Kann überhaupt angerufen werden? Ohne jeden Dienst finden sich zwei Geräte
 * nur im selben Netz - das ist ehrlicherweise kein Anruf, den man anbieten
 * sollte, ohne es dazuzusagen.
 */
export function callSupport(config) {
  const hasStun = (config.stunUrls ?? []).length > 0;
  const hasTurn = (config.turnUrls ?? []).length > 0 && Boolean(config.turnSecret);
  return {
    /** Anrufe anbieten? Ohne STUN findet sich draussen niemand. */
    calls: hasStun || hasTurn,
    /** Gibt es einen Weg für Gegenstellen hinter strengen Routern? */
    relay: hasTurn,
  };
}
