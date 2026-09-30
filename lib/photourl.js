'use strict';
/* ============================================================
 * URL foto bertanda tangan (signed URL) untuk /api/photo.
 * Tujuan: foto bisa di-cache di CDN Vercel (tampil instan untuk semua pengguna)
 * tanpa membuat foto publik. Tanda tangan = HMAC(JWT_SECRET, id + minggu) sehingga
 * tidak bisa ditebak; URL hanya diberikan kepada pengguna yang sudah login dan
 * BERGANTI tiap minggu (berlaku minggu ini + minggu lalu, maks. ±14 hari).
 * ============================================================ */
const crypto = require('crypto');

const WEEK_MS = 7 * 24 * 3600 * 1000;

function secret() {
  return String(process.env.JWT_SECRET || '').trim() || 'dev-secret';
}

function weekNow() { return Math.floor(Date.now() / WEEK_MS); }

function sigOf(id, w) {
  return crypto.createHmac('sha256', secret()).update('foto:' + id + ':' + w).digest('base64url').slice(0, 22);
}

/** URL foto bertanda tangan untuk id file, atau '' bila tanpa id */
function photoUrl(id) {
  id = String(id || '').trim();
  if (!id) return '';
  const w = weekNow();
  return '/api/photo?id=' + encodeURIComponent(id) + '&w=' + w + '&s=' + sigOf(id, w);
}

/** Valid bila tanda tangan cocok dan minggu = minggu ini / minggu lalu */
function verify(id, w, s) {
  const wn = Number(w);
  if (!id || !s || !Number.isInteger(wn)) return false;
  const now = weekNow();
  if (wn !== now && wn !== now - 1) return false;
  const expect = sigOf(id, wn);
  const a = Buffer.from(String(s)), b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { photoUrl, verify, _sigOf: sigOf, _weekNow: weekNow };
