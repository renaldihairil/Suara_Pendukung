'use strict';
/* ============================================================
 * /api/health — cek cepat deploy: Google Sheets + Jembatan Foto (Apps Script).
 * Dipakai saat setup/diagnosis; tidak membuka data pribadi.
 * ============================================================ */
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const out = { ok: true, time: new Date().toISOString() };
  try {
    const sheets = require('../lib/gsheets');
    const rows = await sheets.readSheet(sheets.SHEET_CONFIG, { fresh: true });
    out.spreadsheet = true;
    out.configRows = Math.max(0, rows.length - 1);
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, spreadsheet: false, message: e && e.message ? e.message : 'unknown', time: out.time }));
  }

  // Foto & baca KTP lewat Jembatan Apps Script
  const gd = require('../lib/gdrive');
  const foto = { mode: 'appscript', ok: false };
  if (!gd.gwCfg()) {
    foto.catatan = 'APPSCRIPT_PHOTO_URL / APPSCRIPT_PHOTO_KEY belum diisi di Vercel (lihat README)';
  } else {
    try {
      const pong = await gd.gwCall({ op: 'ping' });
      const cap = pong.cap || {};
      foto.akun = pong.user || undefined;
      foto.izin = cap;
      // upload/baca foto butuh: drive. OCR butuh: drive + dokumen + driveApi.
      foto.ok = cap.drive !== false;
      const kurang = [];
      if (cap.drive === false) kurang.push('izin Drive');
      if (cap.dokumen === false && cap.driveApi === false) kurang.push('izin Dokumen atau layanan Drive API (untuk OCR)');
      else if (cap.driveApi === false) kurang.push('layanan Drive API (OCR)');
      if (cap.email === false) kurang.push('izin email (opsional)');
      if (kurang.length) foto.catatan = 'Belum lengkap: ' + kurang.join(', ') + ' — lihat README "Izin Apps Script"';
    } catch (e) {
      foto.catatan = String(e && e.message || e).slice(0, 240);
    }
  }
  out.foto = foto;
  out.ocr = { penyedia: [gd.gwCfg() ? 'appscript' : null, process.env.OCRSPACE_API_KEY ? 'ocrspace' : null].filter(Boolean) };
  res.statusCode = 200;
  res.end(JSON.stringify(out));
};
