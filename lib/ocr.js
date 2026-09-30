'use strict';
/* ============================================================
 * Baca otomatis teks KTP (OCR) — semua penyedia GRATIS:
 *  1. Apps Script (OCR bawaan Google Drive) lewat Jembatan — utama, tanpa billing.
 *  2. OCR.space (opsional; isi env OCRSPACE_API_KEY) — cadangan.
 * Hasil teks diurai & divalidasi di lib/ktp.js. OCR_PROVIDER=appscript|ocrspace memaksa satu penyedia.
 * ============================================================ */

/** OCR bawaan Google Drive lewat jembatan (berjalan atas nama pemilik akun) */
async function recognizeAppsScript(base64) {
  const gd = require('./gdrive');
  try {
    // total fungsi Vercel dibatasi 60 dtk: Apps Script maks 38 dtk (OCR Drive bisa lambat), OCR.space maks 14 dtk
    const j = await gd.gwCall({ op: 'ocr', base64, mime: 'image/jpeg' },
      { timeoutMs: Number(process.env.OCR_APPSCRIPT_TIMEOUT_MS) || 38000, retries: 0 });
    return { text: j.text || '', provider: 'appscript', ms: j._ms };
  } catch (e) {
    const m = String(e.message || '');
    e.code = /do not have permission to call|Required permissions/i.test(m) ? 'OCR_DENIED'
      : /Drive API|NO_DRIVE_SERVICE|Layanan lanjutan/i.test(m) ? 'OCR_DISABLED' : 'OCR_FAILED';
    e.detail = m;
    throw e;
  }
}

/** OCR.space (gratis, API key via env OCRSPACE_API_KEY) */
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
    body: form.toString(),
    signal: AbortSignal.timeout(Number(process.env.OCR_OCRSPACE_TIMEOUT_MS) || 14000)
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
 * @returns {Promise<{text:string, provider:string}>}
 * Lempar Error dengan .code = OCR_DISABLED (belum dikonfigurasi/diaktifkan) | OCR_DENIED (izin) | OCR_FAILED;
 * bila beberapa penyedia gagal: .multi = true dan .detail berisi alasan SEMUA penyedia.
 */
async function recognize(base64) {
  const forced = String(process.env.OCR_PROVIDER || '').toLowerCase();
  const hasGw = !!require('./gdrive').gwCfg();
  const hasSpace = !!String(process.env.OCRSPACE_API_KEY || '').trim();

  const chain = [];
  if (hasGw && forced !== 'ocrspace') chain.push(['appscript', recognizeAppsScript]);
  if (hasSpace && forced !== 'appscript') chain.push(['ocrspace', recognizeOcrSpace]);
  if (!chain.length) {
    const e = new Error('Baca otomatis belum dikonfigurasi — isi APPSCRIPT_PHOTO_URL/KEY (OCR bawaan Drive, gratis) atau OCRSPACE_API_KEY (lihat README)');
    e.code = 'OCR_DISABLED';
    throw e;
  }

  const errors = [];
  for (let i = 0; i < chain.length; i++) {
    const [name, fn] = chain[i];
    const t0 = Date.now();
    try {
      const out = await fn(base64);
      out.ms = out.ms || (Date.now() - t0);
      return out;
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        e.message = name + ' tidak merespons tepat waktu'; e.detail = e.message; e.code = 'OCR_FAILED';
      }
      errors.push({ name, e });
      console.warn('[ocr] ' + name + ' gagal (' + (e.code || e.message) + ')' + (i < chain.length - 1 ? ' → coba penyedia berikutnya' : ''));
    }
  }
  if (errors.length === 1) throw errors[0].e;
  const err = new Error(errors.map(x => x.name + ': ' + String(x.e.detail || x.e.message).slice(0, 200)).join(' | '));
  err.detail = err.message;
  err.code = 'OCR_FAILED';
  err.multi = true;
  throw err;
}

module.exports = { recognize };
