// Generates resources/icon.png (256x256): violet rounded square with a white "live" play mark.
// Pure Node (zlib), so no image tooling is needed. Run: node scripts/gen-icon.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
const SS = 4; // supersampling for smooth edges

function insideRoundedRect(x, y, r) {
  const m = 8;
  const lo = m + r;
  const hi = SIZE - m - r;
  const cx = Math.min(Math.max(x, lo), hi);
  const cy = Math.min(Math.max(y, lo), hi);
  return x >= m && y >= m && x <= SIZE - m && y <= SIZE - m && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function insideTriangle(x, y) {
  // Rounded-ish play triangle, slightly right of center for optical balance.
  const [ax, ay, bx, by, cx, cy] = [100, 76, 100, 180, 186, 128];
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by);
  const d2 = s(x, y, bx, by, cx, cy);
  const d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function insideDot(x, y) {
  return (x - 70) ** 2 + (y - 128) ** 2 <= 14 ** 2;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    let bg = 0;
    let fg = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (insideRoundedRect(px, py, 56)) {
          bg++;
          if (insideTriangle(px, py) || insideDot(px, py)) fg++;
        }
      }
    }
    const n = SS * SS;
    const t = (x + y) / (2 * SIZE);
    // gradient #b18cff -> #6f3cff
    const gr = 177 + (111 - 177) * t;
    const gg = 140 + (60 - 140) * t;
    const gb = 255;
    const f = fg / Math.max(bg, 1);
    const i = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[i] = Math.round(gr + (255 - gr) * f);
    raw[i + 1] = Math.round(gg + (255 - gg) * f);
    raw[i + 2] = Math.round(gb);
    raw[i + 3] = Math.round((bg / n) * 255);
  }
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../resources/icon.png', import.meta.url), png);
console.log('resources/icon.png written', png.length, 'bytes');
