/**
 * Kompakter QR-Encoder (Byte-Modus, Fehlerkorrektur-Stufe M, Versionen 1-10).
 *
 * Reicht bequem fuer Einladungslinks (bis 216 Zeichen) und spart uns eine
 * externe Abhaengigkeit. Die Korrektheit wird in test/unit/qr.test.js gegen
 * eine Referenzimplementierung geprueft.
 */

// --- Galois-Feld GF(256), Primitivpolynom 0x11D -----------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generatorpolynom fuer `count` Fehlerkorrektur-Codewoerter. */
function generatorPoly(count) {
  let poly = [1];
  for (let i = 0; i < count; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gmul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon-Rest fuer einen Datenblock. */
function errorCorrection(data, ecCount) {
  const gen = generatorPoly(ecCount);
  const buffer = new Uint8Array(data.length + ecCount);
  buffer.set(data);
  for (let i = 0; i < data.length; i += 1) {
    const factor = buffer[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j += 1) buffer[i + j] ^= gmul(gen[j], factor);
  }
  return buffer.subarray(data.length);
}

// --- Tabellen fuer Fehlerkorrektur-Stufe M ----------------------------------
// [EC-Codewoerter pro Block, Bloecke Gruppe 1, Datencodewoerter Gruppe 1,
//  Bloecke Gruppe 2, Datencodewoerter Gruppe 2]
const RS_BLOCKS_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

/** Mittelpunkte der Ausrichtungsmuster je Version. */
const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/** Ueberzaehlige Fuellbits nach den Codewoertern. */
const REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

const MAX_VERSION = 10;

const dataCapacity = (version) => {
  const [, g1, d1, g2, d2] = RS_BLOCKS_M[version];
  return g1 * d1 + g2 * d2;
};

// --- BCH-Codes fuer Format- und Versionsinformation -------------------------
const G15 = 0b101_0011_0111;
const G18 = 0b1_1111_0010_0101;
const G15_MASK = 0b101_0100_0001_0010;

function bchDigit(value) {
  let digit = 0;
  let rest = value;
  while (rest !== 0) {
    digit += 1;
    rest >>>= 1;
  }
  return digit;
}

function bchFormatInfo(data) {
  let rest = data << 10;
  while (bchDigit(rest) - bchDigit(G15) >= 0) rest ^= G15 << (bchDigit(rest) - bchDigit(G15));
  return ((data << 10) | rest) ^ G15_MASK;
}

function bchVersionInfo(version) {
  let rest = version << 12;
  while (bchDigit(rest) - bchDigit(G18) >= 0) rest ^= G18 << (bchDigit(rest) - bchDigit(G18));
  return (version << 12) | rest;
}

// --- Maskierungsmuster ------------------------------------------------------
const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => ((((i + j) % 2) + ((i * j) % 3)) % 2) === 0,
];

// --- Bitpuffer --------------------------------------------------------------
class BitBuffer {
  constructor() {
    this.bytes = [];
    this.length = 0;
  }

  put(value, bits) {
    for (let i = bits - 1; i >= 0; i -= 1) this.putBit(((value >>> i) & 1) === 1);
  }

  putBit(bit) {
    const index = this.length >>> 3;
    if (this.bytes.length <= index) this.bytes.push(0);
    if (bit) this.bytes[index] |= 0x80 >>> (this.length & 7);
    this.length += 1;
  }
}

/**
 * Kodiert Text als QR-Code.
 * @param {string} text
 * @param {{minVersion?: number, mask?: number}} [options] `mask` erzwingt ein
 *   bestimmtes Maskierungsmuster (0-7); sonst wird das mit der besten Bewertung
 *   gewaehlt. Jede der acht Masken ergibt einen gueltigen, lesbaren Code.
 * @returns {{version: number, size: number, mask: number, modules: Uint8Array}} modules: size*size, 1 = dunkel
 */
export function encodeQr(text, options = {}) {
  const data = new TextEncoder().encode(String(text));
  const minVersion = Math.max(1, Math.min(MAX_VERSION, options.minVersion ?? 1));

  let version = 0;
  for (let candidate = minVersion; candidate <= MAX_VERSION; candidate += 1) {
    const countBits = candidate < 10 ? 8 : 16;
    const needed = 4 + countBits + data.length * 8;
    if (needed <= dataCapacity(candidate) * 8) {
      version = candidate;
      break;
    }
  }
  if (version === 0) {
    throw new Error(`Text zu lang fuer QR-Version ${MAX_VERSION} (${data.length} Bytes).`);
  }

  const codewords = buildCodewords(data, version);
  if (Number.isInteger(options.mask) && options.mask >= 0 && options.mask < 8) {
    return {
      version,
      size: 17 + version * 4,
      mask: options.mask,
      modules: buildMatrix(version, codewords, options.mask),
    };
  }
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = buildMatrix(version, codewords, mask);
    const penalty = penaltyScore(modules, 17 + version * 4);
    if (!best || penalty < best.penalty) best = { modules, penalty, mask };
  }
  return { version, size: 17 + version * 4, modules: best.modules, mask: best.mask };
}

function buildCodewords(data, version) {
  const buffer = new BitBuffer();
  buffer.put(0b0100, 4); // Byte-Modus
  buffer.put(data.length, version < 10 ? 8 : 16);
  for (const byte of data) buffer.put(byte, 8);

  const capacityBits = dataCapacity(version) * 8;
  const terminator = Math.min(4, capacityBits - buffer.length);
  buffer.put(0, terminator);
  while (buffer.length % 8 !== 0) buffer.putBit(false);

  const bytes = Uint8Array.from(buffer.bytes);
  const filled = new Uint8Array(dataCapacity(version));
  filled.set(bytes.subarray(0, filled.length));
  for (let i = bytes.length, toggle = true; i < filled.length; i += 1, toggle = !toggle) {
    filled[i] = toggle ? 0xec : 0x11;
  }

  // In Bloecke aufteilen, Fehlerkorrektur berechnen, verschraenkt ausgeben.
  const [ecCount, g1, d1, g2, d2] = RS_BLOCKS_M[version];
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < g1; i += 1) {
    blocks.push(filled.subarray(offset, offset + d1));
    offset += d1;
  }
  for (let i = 0; i < g2; i += 1) {
    blocks.push(filled.subarray(offset, offset + d2));
    offset += d2;
  }
  const ecBlocks = blocks.map((block) => errorCorrection(block, ecCount));

  const out = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecCount; i += 1) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return Uint8Array.from(out);
}

function buildMatrix(version, codewords, mask) {
  const size = 17 + version * 4;
  // null = noch frei, 0/1 = gesetzt
  const grid = Array.from({ length: size }, () => new Array(size).fill(null));

  const placeFinder = (row, col) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const y = row + r;
        const x = col + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const onBorder = (r >= 0 && r <= 6 && (c === 0 || c === 6))
          || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        grid[y][x] = onBorder || inCore ? 1 : 0;
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Ausrichtungsmuster
  const centers = ALIGNMENT[version];
  for (const row of centers) {
    for (const col of centers) {
      if (grid[row][col] !== null) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const edge = Math.max(Math.abs(r), Math.abs(c));
          grid[row + r][col + c] = edge === 1 ? 0 : 1;
        }
      }
    }
  }

  // Taktmuster
  for (let i = 8; i < size - 8; i += 1) {
    if (grid[6][i] === null) grid[6][i] = i % 2 === 0 ? 1 : 0;
    if (grid[i][6] === null) grid[i][6] = i % 2 === 0 ? 1 : 0;
  }

  // Versionsinformation ab Version 7
  if (version >= 7) {
    const bits = bchVersionInfo(version);
    for (let i = 0; i < 18; i += 1) {
      const bit = (bits >> i) & 1;
      grid[Math.floor(i / 3)][(i % 3) + size - 8 - 3] = bit;
      grid[(i % 3) + size - 8 - 3][Math.floor(i / 3)] = bit;
    }
  }

  // Formatinformation (Stufe M = 0b00)
  const formatBits = bchFormatInfo((0b00 << 3) | mask);
  for (let i = 0; i < 15; i += 1) {
    const bit = (formatBits >> i) & 1;
    if (i < 6) grid[i][8] = bit;
    else if (i < 8) grid[i + 1][8] = bit;
    else grid[size - 15 + i][8] = bit;
  }
  for (let i = 0; i < 15; i += 1) {
    const bit = (formatBits >> i) & 1;
    if (i < 8) grid[8][size - i - 1] = bit;
    else if (i < 9) grid[8][15 - i - 1 + 1] = bit;
    else grid[8][15 - i - 1] = bit;
  }
  grid[size - 8][8] = 1; // immer dunkel

  // Daten im Zickzack einfuellen und dabei maskieren
  const maskFn = MASKS[mask];
  const totalBits = codewords.length * 8 + REMAINDER_BITS[version];
  let bitPos = 0;
  let direction = -1;
  let row = size - 1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (;;) {
      for (let step = 0; step < 2; step += 1) {
        const x = col - step;
        if (grid[row][x] !== null) continue;
        let dark = 0;
        if (bitPos < totalBits) {
          const byte = codewords[bitPos >>> 3];
          dark = byte === undefined ? 0 : (byte >>> (7 - (bitPos & 7))) & 1;
        }
        bitPos += 1;
        grid[row][x] = maskFn(row, x) ? dark ^ 1 : dark;
      }
      row += direction;
      if (row < 0 || row >= size) {
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }

  const modules = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) modules[y * size + x] = grid[y][x] ?? 0;
  }
  return modules;
}

/** Bewertet, wie gut ein Muster lesbar ist - kleiner ist besser. */
function penaltyScore(modules, size) {
  const at = (y, x) => modules[y * size + x];
  let penalty = 0;

  // Regel 1: lange Reihen gleicher Farbe
  for (let axis = 0; axis < 2; axis += 1) {
    for (let a = 0; a < size; a += 1) {
      let run = 1;
      let previous = axis === 0 ? at(a, 0) : at(0, a);
      for (let b = 1; b < size; b += 1) {
        const value = axis === 0 ? at(a, b) : at(b, a);
        if (value === previous) {
          run += 1;
        } else {
          if (run >= 5) penalty += 3 + (run - 5);
          run = 1;
          previous = value;
        }
      }
      if (run >= 5) penalty += 3 + (run - 5);
    }
  }

  // Regel 2: gleichfarbige 2x2-Bloecke
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const value = at(y, x);
      if (value === at(y, x + 1) && value === at(y + 1, x) && value === at(y + 1, x + 1)) penalty += 3;
    }
  }

  // Regel 3: finder-aehnliche Muster
  const PATTERN = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  for (let axis = 0; axis < 2; axis += 1) {
    for (let a = 0; a < size; a += 1) {
      for (let b = 0; b + PATTERN.length <= size; b += 1) {
        let forward = true;
        let backward = true;
        for (let k = 0; k < PATTERN.length; k += 1) {
          const value = axis === 0 ? at(a, b + k) : at(b + k, a);
          if (value !== PATTERN[k]) forward = false;
          if (value !== PATTERN[PATTERN.length - 1 - k]) backward = false;
          if (!forward && !backward) break;
        }
        if (forward) penalty += 40;
        else if (backward) penalty += 40;
      }
    }
  }

  // Regel 4: Verhaeltnis heller zu dunkler Module
  let dark = 0;
  for (let i = 0; i < modules.length; i += 1) dark += modules[i];
  const ratio = Math.abs((dark * 100) / modules.length - 50);
  penalty += Math.floor(ratio / 5) * 10;

  return penalty;
}

/** Liest die Maskennummer aus der Formatinformation einer fertigen Matrix. */
export function readMask(modules, size) {
  let bits = 0;
  for (let i = 0; i < 15; i += 1) {
    let value;
    if (i < 6) value = modules[i * size + 8];
    else if (i < 8) value = modules[(i + 1) * size + 8];
    else value = modules[(size - 15 + i) * size + 8];
    bits |= value << i;
  }
  return ((bits ^ G15_MASK) >> 10) & 0b111;
}

/**
 * Baut ein fertiges, skalierbares SVG. Die Farben kommen aus dem CSS
 * (`currentColor`), damit der Code in hell und dunkel funktioniert.
 */
export function qrSvg(text, { quietZone = 2, className = 'qr' } = {}) {
  const { modules, size } = encodeQr(text);
  const total = size + quietZone * 2;
  let path = '';
  for (let y = 0; y < size; y += 1) {
    let runStart = -1;
    for (let x = 0; x <= size; x += 1) {
      const dark = x < size && modules[y * size + x] === 1;
      if (dark && runStart < 0) runStart = x;
      if (!dark && runStart >= 0) {
        path += `M${runStart + quietZone} ${y + quietZone}h${x - runStart}v1h-${x - runStart}z`;
        runStart = -1;
      }
    }
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  if (className) svg.setAttribute('class', className);

  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  background.setAttribute('width', String(total));
  background.setAttribute('height', String(total));
  background.setAttribute('fill', '#fff');
  svg.appendChild(background);

  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  shape.setAttribute('fill', '#000');
  svg.appendChild(shape);
  return svg;
}
