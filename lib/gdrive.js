'use strict';
/* ============================================================
 * Google Drive — upload foto (base64 → file), trash, read base64.
 * Foto TIDAK dibagikan publik lagi; akses hanya via proxy API
 * yang terautentikasi (/api/photo).
 * ============================================================ */
const { Readable } = require('stream');
const { getGoogle, withRetry } = require('./gauth');

const FOLDER_KTP = 'FOTO_KTP_PENDUKUNG_2026';
const FOLDER_TTD = 'FOTO_BUKTI_TTD_2026';

/* ---------- Jembatan Apps Script (opsional, prioritas tertinggi) ----------
 * Bila APPSCRIPT_PHOTO_URL + APPSCRIPT_PHOTO_KEY diisi, semua operasi foto lewat
 * Web App Apps Script milik pemilik Drive (tanpa token kedaluwarsa). */
function gwCfg() {
  const url = String(process.env.APPSCRIPT_PHOTO_URL || '').trim();
  const key = String(process.env.APPSCRIPT_PHOTO_KEY || '').trim();
  return url && key ? { url, key } : null;
}

async function gwCall(payload) {
  const c = gwCfg();
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(c.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ key: c.key }, payload)),
        redirect: 'follow'
      });
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch (e) { /* bukan JSON */ }
      if (!j) throw new Error('Jembatan Apps Script tidak membalas JSON — cek deploy Web App (Akses: Siapa saja) dan versi terbaru');
      if (!j.ok) throw new Error(j.message || 'Jembatan Apps Script gagal');
      return j;
    } catch (e) {
      last = e;
      if (/Kunci salah|PGW_KEY|tidak membalas JSON|Layanan lanjutan|op tidak dikenal/.test(String(e.message))) break;   // bukan error sementara
      await new Promise(res => setTimeout(res, 500));
    }
  }
  throw last;
}

const folderCache = {};

async function getOrCreateFolder(name) {
  if (folderCache[name]) return folderCache[name];
  const { drive } = getGoogle();
  const q = `mimeType='application/vnd.google-apps.folder' and name=${JSON.stringify(name)} and trashed=false`;
  const found = await withRetry(() => drive.files.list({ q, fields: 'files(id,name)', pageSize: 1 }));
  if (found.data.files && found.data.files.length) {
    folderCache[name] = found.data.files[0].id;
    return folderCache[name];
  }
  const created = await withRetry(() => drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  }));
  folderCache[name] = created.data.id;
  return created.data.id;
}

/**
 * Upload blob base64 ke folder Drive.
 * Return { ok, fileId } — URL publik tidak lagi dipakai (proxy foto).
 */
async function uploadBase64(base64Data, mimeType, fileName, folderName) {
  if (!base64Data) return { ok: false, msg: 'Data foto kosong' };
  if (!mimeType) mimeType = 'image/jpeg';
  let clean = String(base64Data);
  const comma = clean.indexOf(',');
  if (comma !== -1 && clean.substring(0, comma).indexOf('base64') !== -1) {
    clean = clean.substring(comma + 1);
  }
  const buf = Buffer.from(clean, 'base64');
  if (!buf.length) return { ok: false, msg: 'Data foto kosong' };

  try {
    if (gwCfg()) {
      const j = await gwCall({
        op: 'upload', base64: clean, mime: mimeType,
        name: fileName || ('FOTO_' + Date.now() + '.jpg'),
        folder: (folderName === FOLDER_TTD) ? 'ttd' : 'ktp'
      });
      return { ok: true, fileId: j.fileId };
    }
    return await doUpload(buf, mimeType, fileName, folderName);
  } catch (e) {
    const raw = String((e && e.message) || 'unknown');
    let msg = raw.slice(0, 200);
    if (/invalid_grant|invalid_client|unauthorized_client/i.test(raw)) msg = 'izin OAuth Google Drive kedaluwarsa/dicabut — buat ulang GOOGLE_OAUTH_REFRESH_TOKEN';
    else if (/storage ?quota|do not have storage/i.test(raw)) {
      msg = getGoogle().driveMode === 'oauth'
        ? 'penyimpanan Google Drive akun Anda penuh'
        : 'Service Account tidak punya kuota Drive — hubungkan akun Google lewat OAuth (lihat README 5d)';
    }
    else if (/has not been used|SERVICE_DISABLED|Drive API/i.test(raw)) msg = 'Google Drive API belum diaktifkan di project Google Cloud';
    console.error('[drive] upload gagal:', raw);
    return { ok: false, msg };
  }
}

async function doUpload(buf, mimeType, fileName, folderName) {
  const { drive } = getGoogle();
  const folderId = await getOrCreateFolder(folderName || FOLDER_KTP);
  // googleapis mewajibkan media.body berupa STREAM (Buffer → "part.body.pipe is not a function").
  // Stream dibuat ulang di tiap percobaan karena sekali dibaca habis (withRetry bisa mengulang).
  const res = await withRetry(() => drive.files.create({
    requestBody: { name: fileName || ('FOTO_' + Date.now() + '.jpg'), parents: [folderId] },
    media: { mimeType, body: Readable.from([buf]) },
    fields: 'id'
  }));
  return { ok: true, fileId: res.data.id };
}

async function trashFile(fileId) {
  if (!fileId) return;
  try {
    if (gwCfg()) { await gwCall({ op: 'trash', fileId: String(fileId) }); return; }
    const { drive } = getGoogle();
    await withRetry(() => drive.files.update({ fileId: String(fileId), requestBody: { trashed: true } }));
  } catch (e) { /* file mungkin sudah tidak ada — abaikan */ }
}

/** Baca file sebagai data URL (dipakai proxy foto & client) */
async function getFileBase64(fileId) {
  if (gwCfg()) {
    const j = await gwCall({ op: 'get', fileId: String(fileId) });
    return { mime: j.mime || 'image/jpeg', base64: j.base64 };
  }
  const { drive } = getGoogle();
  const res = await withRetry(() => drive.files.get(
    { fileId: String(fileId), alt: 'media' },
    { responseType: 'arraybuffer' }
  ));
  const buf = Buffer.from(res.data);
  const mime = (res.headers && res.headers['content-type']) || 'image/jpeg';
  return { mime, base64: buf.toString('base64') };
}

module.exports = { gwCfg, gwCall, FOLDER_KTP, FOLDER_TTD, getOrCreateFolder, uploadBase64, trashFile, getFileBase64 };
