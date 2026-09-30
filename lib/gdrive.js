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
    return await doUpload(buf, mimeType, fileName, folderName);
  } catch (e) {
    const raw = String((e && e.message) || 'unknown');
    let msg = raw.slice(0, 200);
    if (/storage ?quota|do not have storage/i.test(raw)) msg = 'kuota penyimpanan Google Drive Service Account penuh/tidak tersedia';
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
    const { drive } = getGoogle();
    await withRetry(() => drive.files.update({ fileId: String(fileId), requestBody: { trashed: true } }));
  } catch (e) { /* file mungkin sudah tidak ada — abaikan */ }
}

/** Baca file sebagai data URL (dipakai proxy foto & client) */
async function getFileBase64(fileId) {
  const { drive } = getGoogle();
  const res = await withRetry(() => drive.files.get(
    { fileId: String(fileId), alt: 'media' },
    { responseType: 'arraybuffer' }
  ));
  const buf = Buffer.from(res.data);
  const mime = (res.headers && res.headers['content-type']) || 'image/jpeg';
  return { mime, base64: buf.toString('base64') };
}

module.exports = { FOLDER_KTP, FOLDER_TTD, getOrCreateFolder, uploadBase64, trashFile, getFileBase64 };
