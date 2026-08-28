/**
 * Ein Geheimnis, das der Server für sich behält.
 *
 * Gebraucht wird es, um kurzlebige Verweise zu signieren (etwa auf ein Bild
 * bei Giphy). Es liegt im Datenordner, damit es einen Neustart übersteht -
 * sonst würden alle offenen Vorschauen mit jedem Neustart ungültig.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let cached = null;

export function serverSecret(dataDir) {
  if (cached) return cached;
  const file = path.join(dataDir, 'server-secret.bin');
  try {
    const existing = fs.readFileSync(file);
    if (existing.length >= 32) {
      cached = existing;
      return cached;
    }
  } catch { /* gibt es noch nicht */ }

  const fresh = crypto.randomBytes(32);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, fresh, { mode: 0o600 });
  } catch {
    // Nicht schreibbar: dann gilt es eben nur bis zum Neustart.
  }
  cached = fresh;
  return cached;
}
