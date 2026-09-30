'use strict';
/* ============================================================
 * /api/cron — pemicu pengingat harian (hitung mundur Hari H & agenda).
 * Dipanggil oleh Vercel Cron (harian) dan/atau GitHub Actions (berkala).
 * Wajib header:  Authorization: Bearer <CRON_SECRET>
 * Aman dipanggil berulang: pengingat yang sudah terkirim tidak dikirim lagi.
 * ============================================================ */
const crypto = require('crypto');
const reminder = require('../lib/reminder');

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) return json(res, 503, { ok: false, message: 'CRON_SECRET belum diisi di environment' });
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || !safeEqual(token, secret)) return json(res, 401, { ok: false, message: 'Unauthorized' });
  try {
    const r = await reminder.run();
    return json(res, 200, r);
  } catch (e) {
    return json(res, 500, { ok: false, message: 'Error: ' + (e && e.message ? e.message : 'unknown') });
  }
};
