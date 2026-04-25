/**
 * Generates icons/icon16.png, icon32.png, icon48.png, icon128.png
 * Green circle with white "HC" text — no external dependencies required.
 *
 * Run once after cloning:
 *   node scripts/create-icon.js
 */

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 ─────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf    = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput  = Buffer.concat([typeBytes, data]);
  const crcBuf    = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

// ── PNG builder ───────────────────────────────────────────────────────────

function buildPNG(size) {
  const cx = size / 2;
  const cy = size / 2;
  const r  = size * 0.46;

  // Build pixel rows (RGBA, 4 bytes per pixel + 1 filter byte per row)
  const raw = Buffer.alloc(size * (size * 4 + 1), 0);

  for (let y = 0; y < size; y++) {
    const rowOffset = y * (size * 4 + 1);
    raw[rowOffset] = 0; // filter: None

    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const px   = rowOffset + 1 + x * 4;

      if (dist <= r) {
        raw[px]     = 34;   // R
        raw[px + 1] = 197;  // G
        raw[px + 2] = 94;   // B
        raw[px + 3] = 255;  // A
      }
      // else: transparent (0, 0, 0, 0) — already zero from Buffer.alloc
    }
  }

  // Render "HC" text pixels at sizes >= 32
  if (size >= 32) drawHC(raw, size, cx, cy, r);

  const compressed = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13, 0);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

// Minimal bitmap font for "HC" (5×7 pixels per glyph)
const GLYPH_H = [
  [1,0,0,0,1],
  [1,0,0,0,1],
  [1,1,1,1,1],
  [1,0,0,0,1],
  [1,0,0,0,1],
  [1,0,0,0,1],
  [1,0,0,0,1],
];
const GLYPH_C = [
  [0,1,1,1,0],
  [1,0,0,0,1],
  [1,0,0,0,0],
  [1,0,0,0,0],
  [1,0,0,0,0],
  [1,0,0,0,1],
  [0,1,1,1,0],
];

function setPixelWhite(raw, size, px, py) {
  if (px < 0 || py < 0 || px >= size || py >= size) return;
  const rowOffset = py * (size * 4 + 1);
  const i = rowOffset + 1 + px * 4;
  raw[i]     = 255;
  raw[i + 1] = 255;
  raw[i + 2] = 255;
  raw[i + 3] = 255;
}

function drawHC(raw, size, cx, cy, r) {
  const scale  = Math.max(1, Math.floor(r / 14));
  const gW     = 5 * scale;
  const gH     = 7 * scale;
  const gap    = scale;
  const totalW = gW + gap + gW;
  const startX = Math.round(cx - totalW / 2);
  const startY = Math.round(cy - gH / 2);

  function drawGlyph(glyph, ox) {
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (!glyph[gy][gx]) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            setPixelWhite(raw, size, ox + gx * scale + dx, startY + gy * scale + dy);
          }
        }
      }
    }
  }

  drawGlyph(GLYPH_H, startX);
  drawGlyph(GLYPH_C, startX + gW + gap);
}

// ── Write files ───────────────────────────────────────────────────────────

const iconsDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const png  = buildPNG(size);
  const dest = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(dest, png);
  console.log(`Created icons/icon${size}.png (${png.length} bytes)`);
}
