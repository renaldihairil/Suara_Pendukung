/* Generator ikon PWA tanpa dependensi — menghasilkan PNG via zlib.
 * Jalankan: node icons/make-icons.js
 */
'use strict';
const zlib = require('zlib');
const fs = require('fs');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** PNG RGBA dari fungsi piksel (x,y) → [r,g,b,a] */
function encodePNG(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// Gambar: rounded-square hijau gradasi + orang (kepala & bahu putih) + tanda centang
function drawIcon(size) {
  const s = size;
  const cx = s / 2, cy = s / 2;
  const headR = s * 0.16, headY = s * 0.36;
  const bodyTop = s * 0.56, bodyW = s * 0.46, bodyH = s * 0.30;
  const chk = [ // polyline centang (2 segmen)
    { x1: s * 0.66, y1: s * 0.70, x2: s * 0.74, y2: s * 0.79, w: s * 0.035 },
    { x1: s * 0.74, y1: s * 0.79, x2: s * 0.90, y2: s * 0.60, w: s * 0.035 }
  ];
  const segDist = (px, py, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  };
  const roundedR = s * 0.18;
  return (x, y) => {
    // rounded square mask
    const rx = Math.min(x, s - 1 - x), ry = Math.min(y, s - 1 - y);
    let inside;
    if (rx >= roundedR || ry >= roundedR) inside = true;
    else inside = Math.hypot(rx - roundedR, ry - roundedR) <= roundedR;
    if (!inside) return [0, 0, 0, 0];

    // gradasi hijau diagonal
    const t = (x + y) / (2 * s);
    const r = Math.round(13 + t * -6), g = Math.round(110 + t * -58), b = Math.round(63 + t * -34);

    // kepala & bahu
    const inHead = Math.hypot(x - cx, y - headY) <= headR;
    const inBody = y >= bodyTop && y <= bodyTop + bodyH &&
      Math.abs(x - cx) <= bodyW / 2 * (0.55 + 0.45 * ((y - bodyTop) / bodyH));
    if (inHead || inBody) return [255, 255, 255, 255];

    // centang hijau muda di badge
    for (const c of chk) {
      if (segDist(x, y, { x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }) <= c.w) return [134, 239, 172, 255];
    }
    return [r, g, b, 255];
  };
}

fs.writeFileSync(__dirname + '/icon-192.png', encodePNG(192, drawIcon(192)));
fs.writeFileSync(__dirname + '/icon-512.png', encodePNG(512, drawIcon(512)));
console.log('Ikon dibuat: icon-192.png, icon-512.png');
