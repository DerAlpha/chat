/**
 * Welche Fassung dieser Server ausliefert.
 *
 * Gelesen wird sie aus derselben Datei, die auch der Browser bekommt
 * (public/js/version.js). Damit können Server und Browser gar nicht
 * auseinanderlaufen: hat der Browser eine andere Fassung im Speicher, als
 * hier ausliegt, dann ist seine Kopie alt - und genau das soll die App
 * merken und den Nutzer zum Aktualisieren auffordern.
 */
import fs from 'node:fs';
import path from 'node:path';

const STEMPEL = /const APP_VERSION = '([^']*)'/;

let zwischengespeichert = null;

/**
 * @param {string} publicDir Verzeichnis der ausgelieferten Dateien.
 * @returns {string} Die Fassung, oder '' wenn sie sich nicht lesen lässt.
 */
export function appVersion(publicDir) {
  if (zwischengespeichert !== null) return zwischengespeichert;
  try {
    const roh = fs.readFileSync(path.join(publicDir, 'js', 'version.js'), 'utf8');
    zwischengespeichert = STEMPEL.exec(roh)?.[1] ?? '';
  } catch {
    // Keine Datei, keine Auskunft. Dann sagt die App lieber nichts, als den
    // Nutzer mit einer erfundenen Fassung auszusperren.
    zwischengespeichert = '';
  }
  return zwischengespeichert;
}

/** Nur für Tests: die gemerkte Antwort wieder vergessen. */
export function forgetVersion() {
  zwischengespeichert = null;
}
