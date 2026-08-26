/**
 * Sehr einfacher Token-Bucket ohne externe Abhaengigkeiten.
 * Ein Bucket pro Schluessel (z. B. IP-Adresse oder Mitglieds-ID).
 */
export class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.capacity  Maximale Anzahl Tokens im Eimer.
   * @param {number} opts.refillPerMs Nachfuellrate in Tokens pro Millisekunde.
   * @param {number} [opts.idleMs] Nach dieser Ruhezeit wird ein Bucket vergessen.
   */
  constructor({ capacity, refillPerMs, idleMs = 60 * 60 * 1000 }) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMs;
    this.idleMs = idleMs;
    this.buckets = new Map();
  }

  /** @returns {boolean} true, wenn die Aktion erlaubt ist. */
  take(key, cost = 1, now = Date.now()) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, updated: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, now - bucket.updated);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updated = now;
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  /** Sekunden, bis wieder `cost` Tokens zur Verfuegung stehen. */
  retryAfter(key, cost = 1, now = Date.now()) {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const elapsed = Math.max(0, now - bucket.updated);
    const tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    if (tokens >= cost) return 0;
    return Math.ceil((cost - tokens) / this.refillPerMs / 1000);
  }

  sweep(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updated > this.idleMs) this.buckets.delete(key);
    }
  }
}

/** Hilfsfunktion: `perHour` Aktionen pro Stunde. */
export function perHour(count) {
  return new RateLimiter({ capacity: count, refillPerMs: count / (60 * 60 * 1000) });
}

/** Hilfsfunktion: `perMinute` Aktionen pro Minute. */
export function perMinute(count) {
  return new RateLimiter({ capacity: count, refillPerMs: count / (60 * 1000) });
}
