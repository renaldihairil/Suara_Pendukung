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
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, spreadsheet: true, configRows: Math.max(0, rows.length - 1), time: new Date().toISOString() }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, message: e && e.message ? e.message : 'unknown', time: new Date().toISOString() }));
  }
};
