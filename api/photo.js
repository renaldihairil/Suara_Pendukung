'use strict';
/* ============================================================
 * /api/photo?id=<fileId>[&w=<minggu>&s=<tanda tangan>][&download=1]
 * Proxy foto KTP/TTD (Drive pemilik lewat Jembatan Apps Script).
 *
 * Kecepatan:
 *  - URL bertanda tangan (lib/photourl.js) → boleh di-cache CDN Vercel & browser
 *    (id file tidak pernah berubah; foto baru = id baru). Kunjungan berikutnya instan.
 *  - Cache memori per instance (LRU ±30 MB) untuk permintaan yang belum ter-cache CDN.
 * Keamanan: tanpa tanda tangan valid → wajib login (cookie JWT) dan hanya cache privat.
 * ============================================================ */
const auth = require('../lib/auth');
const drive = require('../lib/gdrive');
const photourl = require('../lib/photourl');
const { blurJpeg } = require('../lib/blur');

const MEM_MAX = 30 * 1024 * 1024;
const mem = new Map();          // id -> { mime, buf }
let memBytes = 0;
const inflight = new Map();     // id -> Promise (gabungkan permintaan bersamaan)

function memGet(id) {
  const v = mem.get(id);
  if (v) { mem.delete(id); mem.set(id, v); }       // LRU: pindah ke belakang
  return v;
}
function memPut(id, v) {
  if (v.buf.length > 5 * 1024 * 1024) return;
  mem.set(id, v); memBytes += v.buf.length;
  for (const [k, old] of mem) {
    if (memBytes <= MEM_MAX) break;
    mem.delete(k); memBytes -= old.buf.length;
  }
}

async function loadPhoto(id) {
  const hit = memGet(id);
  if (hit) return hit;
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    const f = await drive.getFileBase64(id);
    const v = { mime: f.mime || 'image/jpeg', buf: Buffer.from(f.base64, 'base64') };
    memPut(id, v);
    return v;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/** Versi disamarkan (untuk peran User) — dibuat dari foto asli lalu disimpan di cache memori */
async function loadBlurred(id) {
  const key = id + ':b';
  const hit = memGet(key);
  if (hit) return hit;
  const f = await loadPhoto(id);
  const v = { mime: 'image/jpeg', buf: Buffer.from(blurJpeg(f.buf, f.mime)) };
  memPut(key, v);
  return v;
}

module.exports = async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const id = (u.searchParams.get('id') || '').trim();
  const download = u.searchParams.get('download') === '1';
  if (!id) {
    res.statusCode = 400;
    return res.end('Parameter id wajib');
  }
  let blur = u.searchParams.get('b') === '1';
  const signed = photourl.verify(id, u.searchParams.get('w'), u.searchParams.get('s'), blur);
  if (!signed) {
    // tanpa tanda tangan: wajib login; akun peran User SELALU mendapat versi disamarkan
    const session = await auth.resolveSession(auth.getSessionFromReq(req));
    if (!session) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end('Unauthorized');
    }
    if (session.role !== 'admin' && session.role !== 'operator') blur = true;
  }
  if (blur && download) {
    res.statusCode = 403;
    res.setHeader('Cache-Control', 'no-store');
    return res.end('Tidak diizinkan');
  }

  try {
    const f = blur ? await loadBlurred(id) : await loadPhoto(id);
    res.statusCode = 200;
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Length', f.buf.length);
    if (download) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', 'attachment; filename="foto-' + id + '.jpg"');
    } else if (signed) {
      // URL bertanda tangan berlaku ≤ 14 hari → cache CDN + browser selama itu
      res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=1209600, immutable');
    } else {
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('Vary', 'Cookie');
    }
    res.end(f.buf);
  } catch (e) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end('Foto tidak ditemukan');
  }
};
