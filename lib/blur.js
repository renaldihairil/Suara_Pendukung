'use strict';
/* ============================================================
 * Foto KTP/TTD versi DISAMARKAN untuk akun peran User.
 * Gambar diperkecil di SERVER menjadi ±28 px (rata-rata kotak)
 * sehingga tulisan/NIK/wajah tidak terbaca; versi tajam tidak
 * pernah dikirim ke perangkat User. Tampilan dibesarkan & diburamkan di perangkat.
 * ============================================================ */
const jpeg = require('jpeg-js');

const SMALL_W = 28;

function placeholder() {
  const w = SMALL_W, h = 18, data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 203; data[i + 1] = 213; data[i + 2] = 225; data[i + 3] = 255; }
  return jpeg.encode({ data, width: w, height: h }, 70).data;
}

/** buf (JPEG) → JPEG mungil yang sudah kabur. Format lain → kotak abu-abu */
function blurJpeg(buf, mime) {
  if (!/jpe?g/i.test(String(mime || '')) && !(buf[0] === 0xff && buf[1] === 0xd8)) return placeholder();
  let img;
  try { img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256, formatAsRGBA: true }); }
  catch (e) { return placeholder(); }
  const W = img.width, H = img.height;
  const w = Math.min(SMALL_W, W), h = Math.max(1, Math.round(H * w / W));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * H / h), y1 = Math.max(y0 + 1, Math.floor((y + 1) * H / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * W / w), x1 = Math.max(x0 + 1, Math.floor((x + 1) * W / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy += 2) {            // sampel setiap 2 px: cukup & cepat
        let p = (yy * W + x0) * 4;
        for (let xx = x0; xx < x1; xx += 2, p += 8) { r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2]; n++; }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return jpeg.encode({ data: out, width: w, height: h }, 75).data;
}

module.exports = { blurJpeg };
