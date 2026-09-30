'use strict';
/* ============================================================
 * Foto KTP/TTD — disimpan di Google Drive PEMILIK lewat "Jembatan Apps Script"
 * (apps-script/PhotoGateway.gs, Web App yang berjalan atas nama pemilik akun).
 * Alasan: Service Account Google tidak punya kuota Drive, dan OAuth mode "Testing"
 * kedaluwarsa tiap 7 hari. Jembatan tidak kedaluwarsa dan memakai folder lama.
 *
 * Env wajib: APPSCRIPT_PHOTO_URL (URL Web App /exec) + APPSCRIPT_PHOTO_KEY (= PGW_KEY di skrip).
 * Foto tidak dibagikan publik; akses hanya lewat proxy /api/photo yang wajib login.
 * ============================================================ */

const FOLDER_KTP = 'FOTO_KTP_PENDUKUNG_2026';
const FOLDER_TTD = 'FOTO_BUKTI_TTD_2026';

const NOT_CONFIGURED = 'Jembatan foto belum dikonfigurasi — isi APPSCRIPT_PHOTO_URL & APPSCRIPT_PHOTO_KEY di Vercel (lihat README)';

function gwCfg() {
  const url = String(process.env.APPSCRIPT_PHOTO_URL || '').trim();
  const key = String(process.env.APPSCRIPT_PHOTO_KEY || '').trim();
  return url && key ? { url, key } : null;
}

/**
 * Panggil jembatan. opts.timeoutMs: batas waktu (default 25 dtk) — tanpa ini panggilan yang menggantung
 * membuat fungsi Vercel kena timeout (HTTP 504) tanpa pesan yang jelas. opts.retries: ulangan untuk gangguan jaringan.
 */
async function gwCall(payload, opts) {
  const c = gwCfg();
  if (!c) throw new Error(NOT_CONFIGURED);
  const timeoutMs = (opts && opts.timeoutMs) || 25000;
  const retries = opts && opts.retries !== undefined ? opts.retries : 1;
  let last;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const r = await fetch(c.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ key: c.key }, payload)),
        redirect: 'follow',
        signal: ctl.signal
      });
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch (e) { /* bukan JSON */ }
      if (!j) throw new Error('Jembatan Apps Script tidak membalas JSON — cek deploy Web App (Akses: Siapa saja) dan versi terbaru');
      if (!j.ok) throw new Error(j.message || 'Jembatan Apps Script gagal');
      j._ms = Date.now() - t0;
      return j;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        const te = new Error('Apps Script tidak merespons dalam ' + Math.round(timeoutMs / 1000) + ' dtk (op: ' + (payload && payload.op) + ') — Apps Script terlalu lambat; lihat menu Eksekusi di Apps Script');
        te.timeout = true;
        throw te;                                   // timeout tidak diulang (akan melewati batas waktu fungsi)
      }
      last = e;
      // error konfigurasi/izin tidak diulang; hanya gangguan jaringan sementara
      if (/Kunci salah|PGW_KEY|tidak membalas JSON|Layanan lanjutan|op tidak dikenal|permission|izin/i.test(String(e.message))) break;
      await new Promise(res => setTimeout(res, 500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

/** Upload base64 → { ok, fileId } atau { ok:false, msg } (tidak melempar) */
async function uploadBase64(base64Data, mimeType, fileName, folderName) {
  if (!base64Data) return { ok: false, msg: 'Data foto kosong' };
  if (!mimeType) mimeType = 'image/jpeg';
  let clean = String(base64Data);
  const comma = clean.indexOf(',');
  if (comma !== -1 && clean.substring(0, comma).indexOf('base64') !== -1) clean = clean.substring(comma + 1);
  if (!clean.length) return { ok: false, msg: 'Data foto kosong' };
  try {
    const j = await gwCall({
      op: 'upload', base64: clean, mime: mimeType,
      name: fileName || ('FOTO_' + Date.now() + '.jpg'),
      folder: folderName === FOLDER_TTD ? 'ttd' : 'ktp'
    });
    return { ok: true, fileId: j.fileId };
  } catch (e) {
    console.error('[foto] upload gagal:', e && e.message);
    return { ok: false, msg: String((e && e.message) || 'unknown').slice(0, 200) };
  }
}

async function trashFile(fileId) {
  if (!fileId || !gwCfg()) return;
  try { await gwCall({ op: 'trash', fileId: String(fileId) }); } catch (e) { /* file mungkin sudah tidak ada */ }
}

/** Baca foto sebagai base64 (dipakai proxy /api/photo & unduh PDF) */
async function getFileBase64(fileId) {
  const j = await gwCall({ op: 'get', fileId: String(fileId) });
  return { mime: j.mime || 'image/jpeg', base64: j.base64 };
}

module.exports = { gwCfg, gwCall, FOLDER_KTP, FOLDER_TTD, uploadBase64, trashFile, getFileBase64 };
