'use strict';
/* ============================================================
 * /api/health — cek cepat deploy & koneksi Google Sheets.
 * Dipakai saat setup untuk memastikan Service Account valid.
 * ============================================================ */
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sheets = require('../lib/gsheets');
    // Baca 1 baris pertama sheet Config sebagai uji koneksi
    const rows = await sheets.readSheet(sheets.SHEET_CONFIG);
    // Cek Drive (foto): mode & apakah akun bisa dipakai
    const g = require('../lib/gauth').getGoogle();
    let drive = { mode: g.driveMode, ok: false };
    try {
      const about = await g.drive.about.get({ fields: 'user(emailAddress),storageQuota(limit,usage)' });
      drive.ok = true;
      drive.akun = about.data && about.data.user && about.data.user.emailAddress;
      const q = about.data && about.data.storageQuota;
      if (q) { drive.limitGB = q.limit ? +(q.limit / 1e9).toFixed(1) : null; drive.usedGB = q.usage ? +(q.usage / 1e9).toFixed(2) : 0; }
      if (g.driveMode !== 'oauth' && q && q.limit !== undefined && Number(q.limit) === 0) { drive.ok = false; drive.catatan = 'Service Account tanpa kuota Drive — foto tak bisa diunggah. Isi GOOGLE_OAUTH_* (README 5d).'; }
    } catch (e) { drive.catatan = String(e && e.message || e).slice(0, 200); }
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, spreadsheet: true, drive, configRows: Math.max(0, rows.length - 1), time: new Date().toISOString() }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, message: e && e.message ? e.message : 'unknown', time: new Date().toISOString() }));
  }
};
