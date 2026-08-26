/**
 * Bilder verkleinern und Sprachnachrichten aufnehmen - alles im Browser,
 * bevor irgendetwas verschluesselt und hochgeladen wird.
 */

const MAX_EDGE = 1600;
const THUMB_EDGE = 24;
const JPEG_QUALITY = 0.82;

/** Menschenlesbare Dateigroesse. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** mm:ss */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Bild konnte nicht kodiert werden.'))),
      type,
      quality,
    );
  });
}

async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      // imageOrientation sorgt dafuer, dass hochkant fotografierte Bilder richtig herum landen.
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Aeltere Browser kennen die Option nicht - dann eben ohne.
      try {
        return await createImageBitmap(file);
      } catch { /* faellt unten auf <img> zurueck */ }
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Bild konnte nicht geladen werden.'));
      image.src = url;
    });
    return image;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function drawScaled(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Welches Format kann dieser Browser gut? WebP spart deutlich Daten. */
function pickImageType() {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  return canvas.toDataURL('image/webp').startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg';
}

let preferredType = null;

/**
 * Verkleinert ein Bild auf hoechstens 1600 px Kantenlaenge und erzeugt
 * zusaetzlich eine winzige Vorschau, die verschluesselt mitgeschickt wird.
 * @returns {Promise<{bytes: Uint8Array, mime: string, width: number, height: number, thumb: string}>}
 */
export async function prepareImage(file) {
  preferredType ??= pickImageType();
  const source = await loadBitmap(file);
  const naturalWidth = source.width || source.naturalWidth;
  const naturalHeight = source.height || source.naturalHeight;
  if (!naturalWidth || !naturalHeight) throw new Error('Bild ohne Abmessungen.');

  const scale = Math.min(1, MAX_EDGE / Math.max(naturalWidth, naturalHeight));
  const width = Math.round(naturalWidth * scale);
  const height = Math.round(naturalHeight * scale);

  const canvas = drawScaled(source, width, height);
  let blob = await canvasToBlob(canvas, preferredType, JPEG_QUALITY);
  // Bei sehr kleinen Bildern kann das Original kleiner sein als unser Re-Encode.
  let mime = preferredType;
  if (scale === 1 && file.size < blob.size && /^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
    blob = file;
    mime = file.type;
  }

  const thumbScale = Math.min(1, THUMB_EDGE / Math.max(naturalWidth, naturalHeight));
  const thumbCanvas = drawScaled(source, naturalWidth * thumbScale, naturalHeight * thumbScale);
  const thumb = thumbCanvas.toDataURL('image/jpeg', 0.5);

  if (typeof source.close === 'function') source.close();
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mime,
    width,
    height,
    thumb: thumb.length < 3000 ? thumb : '',
  };
}

/** Liest eine beliebige Datei roh ein. */
export async function readFileBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

export const canRecordAudio = () =>
  typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

const AUDIO_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

/** Nimmt eine Sprachnachricht auf. Rueckgabe steuert Stopp und Abbruch. */
export async function startRecording({ onLevel, onTick } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const mimeType = AUDIO_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type)) ?? '';
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  const startedAt = Date.now();
  let audioContext = null;
  let analyser = null;
  let frame = 0;
  if (onLevel && typeof AudioContext !== 'undefined') {
    try {
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(buffer);
        let peak = 0;
        for (const value of buffer) peak = Math.max(peak, Math.abs(value - 128));
        onLevel(Math.min(1, peak / 90));
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    } catch { /* Pegelanzeige ist optional */ }
  }
  const ticker = onTick ? setInterval(() => onTick((Date.now() - startedAt) / 1000), 200) : null;

  const cleanup = () => {
    if (frame) cancelAnimationFrame(frame);
    if (ticker) clearInterval(ticker);
    audioContext?.close().catch(() => {});
    for (const track of stream.getTracks()) track.stop();
  };

  recorder.start(250);

  return {
    get duration() {
      return (Date.now() - startedAt) / 1000;
    },
    async stop() {
      const duration = (Date.now() - startedAt) / 1000;
      const blob = await new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
        if (recorder.state !== 'inactive') recorder.stop();
        else resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      });
      cleanup();
      return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mime: blob.type || 'audio/webm',
        duration,
      };
    },
    cancel() {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch { /* egal */ }
      cleanup();
    },
  };
}

/** Kurzer, dezenter Hinweiston - ohne Audiodatei im Repo. */
export function playPing() {
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(1320, context.currentTime + 0.08);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.09, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.25);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.26);
    oscillator.onended = () => context.close().catch(() => {});
  } catch { /* Ton ist Beiwerk */ }
}
