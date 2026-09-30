'use strict';
/* ============================================================
 * OCR via Google Cloud Vision (DOCUMENT_TEXT_DETECTION).
 * Memakai Service Account yang SAMA dengan Google Sheets — cukup
 * mengaktifkan "Cloud Vision API" di project Google Cloud tsb.
 * (Gratis 1.000 gambar/bulan; selebihnya berbayar per 1.000.)
 * Foto hanya diproses untuk dibaca, tidak disimpan oleh Vision.
 * ============================================================ */
const { getEnv } = require('./env');

let authClient = null;
function getAuth() {
  if (authClient) return authClient;
  const env = getEnv();
  const { google } = require('googleapis');
  authClient = new google.auth.JWT({
    email: env.credentials.client_email,
    key: env.credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/cloud-vision', 'https://www.googleapis.com/auth/cloud-platform']
  });
  return authClient;
}

/** @returns {Promise<{text:string}>}; lempar Error dengan .code = 'OCR_DISABLED' | 'OCR_FAILED' */
async function recognize(base64) {
  const auth = getAuth();
  const token = (await auth.getAccessToken()).token || (await auth.authorize()).access_token;
  const r = await fetch('https://vision.googleapis.com/v1/images:annotate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      requests: [{
        image: { content: base64 },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: { languageHints: ['id', 'en'] }
      }]
    })
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* abaikan */ }
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || ('HTTP ' + r.status);
    const e = new Error(msg);
    e.code = (r.status === 403 || r.status === 401 || /has not been used|disabled|PERMISSION_DENIED|billing/i.test(msg)) ? 'OCR_DISABLED' : 'OCR_FAILED';
    throw e;
  }
  const resp = data && data.responses && data.responses[0];
  if (resp && resp.error) {
    const e = new Error(resp.error.message || 'OCR gagal');
    e.code = 'OCR_FAILED';
    throw e;
  }
  const text = (resp && resp.fullTextAnnotation && resp.fullTextAnnotation.text) || '';
  return { text };
}

module.exports = { recognize };
