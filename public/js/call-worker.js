/**
 * Der Faden, durch den Ton und Bild eines Anrufs laufen.
 *
 * Der Browser reicht hier jedes fertig kodierte Paket durch, bevor es auf die
 * Leitung geht - und jedes empfangene, bevor es dekodiert wird. Genau dort
 * legen wir die zweite Verschlüsselung darüber (siehe framecrypto.js).
 *
 * Das läuft bewusst in einem eigenen Faden: die Oberfläche soll nicht ins
 * Stocken geraten, weil dreissigmal pro Sekunde ein Bild verschlüsselt wird.
 *
 * Der Schlüssel kommt einmal per Nachricht herein und verlässt diesen Faden
 * nie wieder.
 */
import { deriveMediaKey, headerLength, open, seal } from './framecrypto.js';

let key = null;

/**
 * Der Schlüssel kommt herein, bevor irgendetwas eingehängt wird - und sobald
 * er steht, sagt dieser Faden Bescheid. Die andere Seite wartet darauf: nur
 * ein Faden, der wirklich läuft, darf mit der Gegenstelle vereinbart werden.
 * Sonst schickte einer verschlüsselt und der andere verstünde nichts.
 */
self.onmessage = (event) => {
  const data = event.data ?? {};
  if (data.type !== 'key') return;
  deriveMediaKey(new Uint8Array(data.room), String(data.callId))
    .then((derived) => {
      key = derived;
      self.postMessage({ type: 'ready' });
    })
    .catch(() => {
      key = null;
      self.postMessage({ type: 'failed' });
    });
};

async function encode(frame, controller) {
  if (!key) return;
  const kind = frame instanceof RTCEncodedAudioFrame ? 'audio' : 'video';
  const clear = headerLength(kind, frame.type);
  const sealed = await seal(key, frame.data, clear);
  frame.data = sealed;
  controller.enqueue(frame);
}

async function decode(frame, controller) {
  if (!key) return;
  const opened = await open(key, frame.data);
  // Was sich nicht öffnen lässt, wird verworfen: lieber ein fehlendes Bild
  // als Rauschen im Decoder.
  if (!opened) return;
  frame.data = opened;
  controller.enqueue(frame);
}

self.onrtctransform = (event) => {
  const transformer = event.transformer;
  const arbeit = transformer.options?.operation === 'encode' ? encode : decode;
  transformer.readable
    .pipeThrough(new TransformStream({ transform: arbeit }))
    .pipeTo(transformer.writable)
    .catch(() => { /* Beim Auflegen bricht der Strom ab - das ist kein Fehler. */ });
};
