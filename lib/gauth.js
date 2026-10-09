'use strict';
/* ============================================================
 * Klien Google Sheets API via Service Account.
 * (Foto TIDAK lewat sini — foto disimpan lewat Jembatan Apps Script, lihat lib/gdrive.js.)
 * Instance di-cache per proses (serverless warm instance reuse).
 * ============================================================ */
const { getEnv } = require('./env');

let cached = null;

function getGoogle() {
  if (cached) return cached;
  const env = getEnv();
  // @googleapis/sheets: paket ringan khusus Sheets (±3 MB, dimuat ±60 ms) — jauh lebih cepat saat
  // cold start dibanding paket lengkap `googleapis` (±112 MB, dimuat ±1 dtk).
  const gs = require('@googleapis/sheets');
  const auth = new gs.auth.JWT({
    email: env.credentials.client_email,
    key: env.credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  cached = { env, auth, sheets: gs.sheets({ version: 'v4', auth }) };
  return cached;
}

/** Panggil API Google dengan retry sederhana utk error sementara.
 *  PENTING: error 429 (kuota baca habis) BUTUH WAKTU untuk pulih (sampai ±1 menit).
 *  Menundanya dengan 3x retry di sini hanya memperpanjang waktu tunggu & menahan
 *  slot serverless, sehingga semua pengguna bisa gagal total. Jadi 429 langsung
 *  dilempar (frontend mencoba lagi dengan jeda jauh lebih baik), sedangkan 5xx
 *  tetap dicoba. */
async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e && (e.code || (e.response && e.response.status));
      // 429 = kuota baca habis: jangan menunggu di sini, lempar agar server bebas
      if (status === 429) throw e;
      const retryable = status === 500 || status === 502 || status === 503;
      if (!retryable || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, 300 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

module.exports = { getGoogle, withRetry };
