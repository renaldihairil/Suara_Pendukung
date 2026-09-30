'use strict';
/* ============================================================
 * Konfigurasi environment — dipakai semua module server.
 * GOOGLE_CREDENTIALS bisa: string JSON mentah ATAU base64 JSON.
 * ============================================================ */

function parseCredentials(raw) {
  if (!raw) throw new Error('Env GOOGLE_CREDENTIALS belum diisi');
  let txt = String(raw).trim();
  // Support base64 (lebih aman ditempel di beberapa UI env)
  if (!txt.startsWith('{')) {
    try { txt = Buffer.from(txt, 'base64').toString('utf8'); } catch (e) { /* biarkan JSON parser yang protes */ }
  }
  const obj = JSON.parse(txt);
  if (!obj.client_email || !obj.private_key) {
    throw new Error('GOOGLE_CREDENTIALS tidak valid (butuh client_email & private_key)');
  }
  // Normalisasi newline private key yang sering rusak saat di-paste
  if (obj.private_key.indexOf('\\n') !== -1) {
    obj.private_key = obj.private_key.replace(/\\n/g, '\n');
  }
  return obj;
}

function getEnv() {
  const credentials = parseCredentials(process.env.GOOGLE_CREDENTIALS);
  const spreadsheetId = String(process.env.SPREADSHEET_ID || '').trim();
  if (!spreadsheetId) throw new Error('Env SPREADSHEET_ID belum diisi');
  const jwtSecret = String(process.env.JWT_SECRET || '').trim();
  if (!jwtSecret || jwtSecret.length < 16) throw new Error('Env JWT_SECRET belum diisi (min. 16 karakter)');
  return {
    credentials,
    spreadsheetId,
    jwtSecret,
    adminUsername: String(process.env.ADMIN_USERNAME || 'admin').trim(),
    adminPassword: String(process.env.ADMIN_PASSWORD || '').trim()
  };
}

module.exports = { getEnv, parseCredentials };
