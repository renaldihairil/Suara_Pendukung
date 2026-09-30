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

/** OCR.space (gratis, API key via env OCRSPACE_API_KEY) — cadangan bila Google Vision belum bisa dipakai */
async function recognizeOcrSpace(base64) {
  const key = String(process.env.OCRSPACE_API_KEY || '').trim();
  const form = new URLSearchParams();
  form.set('apikey', key);
  form.set('base64Image', 'data:image/jpeg;base64,' + base64);
  form.set('language', 'eng');
  form.set('OCREngine', '2');           // engine 2: lebih baik untuk angka & teks berlatar ramai
  form.set('scale', 'true');
  form.set('detectOrientation', 'true');
  form.set('isOverlayRequired', 'false');
  const r = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* abaikan */ }
  if (!r.ok || !data) {
    const e = new Error('OCR.space HTTP ' + r.status); e.code = 'OCR_FAILED'; e.detail = e.message; throw e;
  }
  if (data.IsErroredOnProcessing) {
    const msg = [].concat(data.ErrorMessage || 'OCR.space gagal').join('; ');
    const e = new Error(msg); e.detail = msg;
    e.code = /apikey|api key|invalid/i.test(msg) ? 'OCR_DENIED' : 'OCR_FAILED';
    throw e;
  }
  const text = (data.ParsedResults || []).map(x => x.ParsedText || '').join('\n');
  return { text, provider: 'ocrspace' };
}

/**
 * Urutan: Google Vision → (bila gagal karena billing/API/izin ATAU OCR_PROVIDER=ocrspace) OCR.space.
 * @returns {Promise<{text:string, provider:string}>}; lempar Error dengan .code = OCR_DISABLED | OCR_BILLING | OCR_DENIED | OCR_FAILED
 */
async function recognize(base64) {
  const hasSpace = !!String(process.env.OCRSPACE_API_KEY || '').trim();
  if (hasSpace && String(process.env.OCR_PROVIDER || '').toLowerCase() === 'ocrspace') return recognizeOcrSpace(base64);
  try {
    return await recognizeVision(base64);
  } catch (e) {
    if (hasSpace && /^OCR_(BILLING|DISABLED|DENIED)$/.test(e.code || '')) {
      console.warn('[ocr] Vision tidak tersedia (' + e.code + ') → pakai OCR.space');
      return recognizeOcrSpace(base64);
    }
    throw e;
  }
}

async function recognizeVision(base64) {
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
    e.detail = msg;
    if (/billing/i.test(msg)) e.code = 'OCR_BILLING';
    else if (/has not been used|SERVICE_DISABLED|is disabled|not enabled/i.test(msg)) e.code = 'OCR_DISABLED';
    else if (r.status === 403 || r.status === 401 || /PERMISSION_DENIED/i.test(msg)) e.code = 'OCR_DENIED';
    else e.code = 'OCR_FAILED';
    throw e;
  }
  const resp = data && data.responses && data.responses[0];
  if (resp && resp.error) {
    const e = new Error(resp.error.message || 'OCR gagal');
    e.code = 'OCR_FAILED';
    throw e;
  }
  const text = (resp && resp.fullTextAnnotation && resp.fullTextAnnotation.text) || '';
  return { text, provider: 'vision' };
}

module.exports = { recognize };
