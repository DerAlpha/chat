import zlib from 'node:zlib';
import { expect } from '@playwright/test';

/** CRC32, wie PNG es braucht. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Baut ein echtes, farbiges PNG - damit der Browser es auch wirklich dekodieren kann. */
export function makePng(width = 240, height = 160) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // Filtertyp "None"
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      raw[offset] = (x * 255) / width;
      raw[offset + 1] = (y * 255) / height;
      raw[offset + 2] = 160;
      offset += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // Bittiefe
  ihdr[9] = 2;  // Farbtyp: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Startet einen neuen Chat und liefert Code und Einladungslink. */
export async function createChat(page) {
  await page.goto('./');
  await page.getByRole('button', { name: /Neuen Chat starten/i }).click();
  const codeNode = page.locator('#code-display');
  await expect(codeNode).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/, { timeout: 20_000 });
  const code = (await codeNode.textContent()).trim();
  // Relativ, damit derselbe Test unter "/" und unter "/chats/" funktioniert.
  return { code, link: `./#${encodeURIComponent(code)}` };
}

/** Tritt einem Chat ueber den Einladungslink bei. */
export async function joinChat(page, link) {
  await page.goto(link);
  await expect(page.locator('#screen-chat')).toBeVisible({ timeout: 20_000 });
}

export async function sendText(page, text) {
  const input = page.locator('#message-input');
  await input.fill(text);
  await page.locator('#btn-send').click();
}

export const bubbles = (page) => page.locator('#messages .msg');

/** Liefert die Rohdaten, die der Server gespeichert hat. */
export async function serverMessages(request, baseURL, code, page) {
  const roomId = await page.evaluate(async (value) => {
    const module = await import('./js/crypto.js');
    return module.deriveRoomId(value);
  }, code);
  return { roomId, statusUrl: `${baseURL}/api/rooms/${roomId}` };
}
