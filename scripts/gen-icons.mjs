// Generates simple PNG icons (rounded gradient square) without dependencies.
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const outDir = path.resolve(process.argv[2] ?? "public/icons");
fs.mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** Rounded-rect gradient icon with a subtle ">" chevron hint (agent). */
function render(size, maskable = false) {
  const r = maskable ? size * 0.5 : size * 0.22; // maskable: full-bleed square
  const cx = size / 2;
  const c1 = [16, 16, 20], c2 = [58, 92, 255];
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      let R = c1[0] + (c2[0] - c1[0]) * t;
      let G = c1[1] + (c2[1] - c1[1]) * t;
      let B = c1[2] + (c2[2] - c1[2]) * t;
      // rounded-rect alpha (antialiased)
      const rx = Math.min(x + 0.5, size - 0.5 - x), ry = Math.min(y + 0.5, size - 0.5 - y);
      const dx = Math.max(r - rx, 0), dy = Math.max(r - ry, 0);
      const dist = Math.hypot(dx, dy);
      const a = dist > 1.5 ? 0 : dist < 0.5 ? 255 : Math.round(255 * (1.5 - dist));
      // chevron ">" (polyline in 512-space, stroked white)
      if (a > 0 && !maskable) {
        const s = size / 512;
        const bx = (x - (cx - 256 * s)) / s, by = (y - (cx - 256 * s)) / s;
        const pts = [[300, 180], [380, 256], [300, 332]];
        const w = 34 * 34; // squared stroke half-width
        for (let i = 0; i < 2; i++) {
          const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
          const vx = x2 - x1, vy = y2 - y1;
          const tseg = Math.max(0, Math.min(1, ((bx - x1) * vx + (by - y1) * vy) / (vx * vx + vy * vy)));
          const ddx = bx - (x1 + vx * tseg), ddy = by - (y1 + vy * tseg);
          if (ddx * ddx + ddy * ddy < w) { R = 255; G = 255; B = 255; break; }
        }
      }
      raw[o++] = R; raw[o++] = G; raw[o++] = B; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), render(size));
}
fs.writeFileSync(path.join(outDir, "icon-512-maskable.png"), render(512, true));
fs.writeFileSync(path.join(outDir, "icon-180.png"), render(180));
console.log(`icons written to ${outDir}`);