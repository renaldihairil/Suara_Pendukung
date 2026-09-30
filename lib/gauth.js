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
  const { google } = require('googleapis');
  const auth = new google.auth.JWT({
    email: env.credentials.client_email,
    key: env.credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  cached = { env, auth, sheets: google.sheets({ version: 'v4', auth }) };
  return cached;
}

/** Panggil API Google dengan retry sederhana utk rate limit / error sementara */
async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e && (e.code || (e.response && e.response.status));
      const retryable = status === 429 || status === 500 || status === 502 || status === 503;
      if (!retryable || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, 400 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

module.exports = { getGoogle, withRetry };
