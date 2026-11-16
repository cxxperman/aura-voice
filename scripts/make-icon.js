// Draws the Aura fish and writes every icon the app needs. Run: node scripts/make-icon.js
//
// Same language as the Kapsula critter: a chunky pixel sprite, one flat orange,
// dark upright eye, transparent background.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SPRITE = [
  '....##......',
  '...####....#',
  '..######..##',
  '.###########',
  '##E########.',
  '##E########.',
  '.###########',
  '..######..##',
  '...####....#',
  '....##......',
];
const ORANGE = [0xf0, 0x8a, 0x4b];
const EYE = [0x1a, 0x1a, 0x1e];
const GREY = [0x8e, 0x8e, 0x93]; // tray icon while the processing is off

const COLS = SPRITE[0].length;
const ROWS = SPRITE.length;

// Supersampled, so the sprite stays crisp at 256 px and readable at 16 px.
function render(size, body = ORANGE) {
  const cell = (size * 0.94) / COLS;
  const ox = (size - cell * COLS) / 2;
  const oy = (size - cell * ROWS) / 2;
  const S = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const gx = Math.floor((x + (sx + 0.5) / S - ox) / cell);
          const gy = Math.floor((y + (sy + 0.5) / S - oy) / cell);
          const c = gx >= 0 && gx < COLS && gy >= 0 && gy < ROWS ? SPRITE[gy][gx] : '.';
          if (c === '.') continue;
          const col = c === 'E' ? EYE : body;
          r += col[0]; g += col[1]; b += col[2]; a++;
        }
      }
      const i = (y * size + x) * 4;
      if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; px[i + 3] = (a * 255) / (S * S); }
    }
  }
  return px;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
function png(size, body) {
  const px = render(size, body);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function ico(sizes) {
  const images = sizes.map((s) => png(s));
  const dir = Buffer.alloc(6 + 16 * sizes.length);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(sizes.length, 4);
  let offset = dir.length;
  sizes.forEach((s, i) => {
    const o = 6 + i * 16;
    dir[o] = dir[o + 1] = s >= 256 ? 0 : s;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(images[i].length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += images[i].length;
  });
  return Buffer.concat([dir, ...images]);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(out, name), data);
write('icon.ico', ico([16, 24, 32, 48, 64, 128, 256]));
write('icon.png', png(256));
write('tray.png', png(16));
write('tray@2x.png', png(32));
write('tray-off.png', png(16, GREY));
write('tray-off@2x.png', png(32, GREY));
console.log('icons written to', out);
