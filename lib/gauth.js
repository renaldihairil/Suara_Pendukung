'use strict';
/* ============================================================
 * Klien Google Sheets API + Drive API via Service Account.
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
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ]
  });
  // Drive: Service Account TIDAK punya kuota penyimpanan (tak bisa memiliki file). Bila OAuth akun Google
  // pemilik diisi (GOOGLE_OAUTH_CLIENT_ID/SECRET + GOOGLE_OAUTH_REFRESH_TOKEN), foto disimpan di Drive
  // akun itu (kuota 15 GB gratis, dan foto lama buatan akun itu ikut terbaca). Sheets tetap Service Account.
  const oc = {
    id: String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim(),
    secret: String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim(),
    refresh: String(process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '').trim()
  };
  let driveAuth = auth, driveMode = 'service-account';
  if (oc.id && oc.secret && oc.refresh) {
    driveAuth = new google.auth.OAuth2(oc.id, oc.secret);
    driveAuth.setCredentials({ refresh_token: oc.refresh });
    driveMode = 'oauth';
  }
  cached = {
    env,
    auth,
    driveMode,
    sheets: google.sheets({ version: 'v4', auth }),
    drive: google.drive({ version: 'v3', auth: driveAuth })
  };
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
