'use strict';
/* ============================================================
 * /api/photo?id=<driveFileId> — proxy gambar dari Google Drive.
 * Wajib login (cookie JWT) sehingga foto KTP/TTD tidak lagi
 * bisa diakses siapa pun lewat link publik.
 * ============================================================ */
const auth = require('../lib/auth');
const drive = require('../lib/gdrive');

module.exports = async (req, res) => {
  const session = auth.getSessionFromReq(req);
  if (!session) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Unauthorized');
  }

  const u = new URL(req.url, 'http://localhost');
  const id = (u.searchParams.get('id') || '').trim();
  const download = u.searchParams.get('download') === '1';
  if (!id) {
    res.statusCode = 400;
    return res.end('Parameter id wajib');
  }

  try {
    const f = await drive.getFileBase64(id);
    const buf = Buffer.from(f.base64, 'base64');
    res.statusCode = 200;
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Cache-Control', 'no-store');
    if (download) res.setHeader('Content-Disposition', 'attachment; filename="foto-' + id + '.jpg"');
    res.end(buf);
  } catch (e) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Foto tidak ditemukan');
  }
};
