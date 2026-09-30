'use strict';
/* ============================================================
 * Google Drive — upload foto (base64 → file), trash, read base64.
 * Foto TIDAK dibagikan publik lagi; akses hanya via proxy API
 * yang terautentikasi (/api/photo).
 * ============================================================ */
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

  const { drive } = getGoogle();
  const folderId = await getOrCreateFolder(folderName || FOLDER_KTP);
  const res = await withRetry(() => drive.files.create({
    requestBody: { name: fileName || ('FOTO_' + Date.now() + '.jpg'), parents: [folderId] },
    media: { mimeType, body: Buffer.isBuffer(buf) ? buf : Buffer.from(buf) },
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
