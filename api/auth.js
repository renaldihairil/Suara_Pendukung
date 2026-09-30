'use strict';
/* ============================================================
 * /api/auth
 *   GET  → info sesi aktif (untuk auto-login saat buka app)
 *   POST { op: 'login' | 'logout' }
 * Bootstrap: saat request pertama, pastikan sheet Users ada dan
 * buat admin awal dari env ADMIN_USERNAME/ADMIN_PASSWORD.
 * ============================================================ */
const store = require('../lib/store');
const auth = require('../lib/auth');


/* --- Rate limit login sederhana (per proses/serverless instance) --- */
const fails = new Map(); // ip → { count, until }
const MAX_FAILS = 10;
const BLOCK_MS = 10 * 60 * 1000;

function ipOf(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function isBlocked(ip) {
  const f = fails.get(ip);
  return !!(f && f.until > Date.now());
}
function recordFail(ip) {
  const f = fails.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= MAX_FAILS) { f.until = Date.now() + BLOCK_MS; f.count = 0; }
  fails.set(ip, f);
}
function clearFails(ip) { fails.delete(ip); }

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}


async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.end();
  }

  /* ---------- GET: cek sesi ---------- */
  if (req.method === 'GET') {
    const session = auth.getSessionFromReq(req);
    if (!session) return json(res, 200, { ok: false });
    // Validasi ulang ke sheet: user masih ada & aktif?
    try {
      const users = await auth.listUsers(false);
      const u = users.find(x => x.id === session.userId);
      if (!u || !u.aktif) {
        res.setHeader('Set-Cookie', auth.clearSessionCookie());
        return json(res, 200, { ok: false, reason: 'deactivated' });
      }
      return json(res, 200, { ok: true, user: { username: u.username, nama: u.nama, role: u.role } });
    } catch (e) {
      // Sheet tidak terbaca → jangan anggap logout total; tetap izinkan dari JWT
      return json(res, 200, { ok: true, user: { username: session.username, nama: session.nama, role: session.role } });
    }
  }

  /* ---------- POST: login / logout ---------- */
  if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'Method tidak didukung' });

  let body = {};
  await new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { body = {}; }
      resolve();
    });
  });

  const op = String(body.op || 'login');

  if (op === 'logout') {
    const session = auth.getSessionFromReq(req);
    if (session) {
      try { await store.logAksi('LOGOUT', session.username, 'Logout'); } catch (e) { /* abaikan */ }
    }
    res.setHeader('Set-Cookie', auth.clearSessionCookie());
    return json(res, 200, { ok: true });
  }

  if (op !== 'login') return json(res, 400, { ok: false, message: 'Op tidak dikenal' });

  const ip = ipOf(req);
  if (isBlocked(ip)) {
    return json(res, 429, { ok: false, message: 'Terlalu banyak percobaan gagal. Coba lagi dalam 10 menit.' });
  }

  try {
    // Satu bacaan sheet Users (ter-cache); pembuatan sheet/admin awal hanya bila Users masih kosong
    const result = await auth.authenticate(body.username, body.password);
    if (!result.ok) {
      recordFail(ip);
      try { await store.logAksi('LOGIN_GAGAL', '-', String(body.username || '')); } catch (e) { /* abaikan */ }
      return json(res, 200, { ok: false, message: result.message });
    }
    clearFails(ip);
    // dua tulisan kecil dijalankan BERSAMAAN (tidak berurutan) agar login cepat
    await Promise.all([
      auth.touchLastLogin(result.user),
      store.logAksi('LOGIN', result.user.username, 'Login berhasil')
    ]);
    res.setHeader('Set-Cookie', auth.sessionCookie(auth.signSession(result.user)));
    return json(res, 200, {
      ok: true,
      user: { username: result.user.username, nama: result.user.nama, role: result.user.role }
    });
  } catch (err) {
    return json(res, 500, { ok: false, message: 'Error: ' + (err && err.message ? err.message : 'unknown') });
  }
}

// Pengaman: apa pun yang terjadi, balas JSON (bukan halaman error Vercel) agar aplikasi bisa menampilkan pesan jelas
module.exports = async (req, res) => {
  try {
    return await handler(req, res);
  } catch (err) {
    console.error('[auth]', err);
    if (!res.headersSent) return json(res, 500, { ok: false, message: 'Error server: ' + (err && err.message ? err.message : 'unknown') });
  }
};
