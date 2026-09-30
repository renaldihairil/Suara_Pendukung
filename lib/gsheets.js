'use strict';
/* ============================================================
 * Operasi dasar Google Sheets — satu-satunya tempat yang
 * menyentuh API spreadsheets.
 * ============================================================ */
const { getGoogle, withRetry } = require('./gauth');

const SHEET_PENDUKUNG = 'Pendukung';
const SHEET_LOG = 'Log';
const SHEET_CONFIG = 'Config';
const SHEET_USERS = 'Users';
const SHEET_NOTIF = 'Notifikasi';        // riwayat notifikasi (dibuat tiap aksi penting)
const SHEET_NOTIF_STATE = 'NotifState';  // per user: kapan terakhir membaca notifikasi
const SHEET_PUSH = 'PushSubs';           // langganan Web Push per perangkat
const SHEET_AGENDA = 'Agenda';           // jadwal: hari pemilihan, kunjungan, rapat, dll
const SHEET_REMINDER_LOG = 'ReminderLog'; // penanda pengingat yang sudah terkirim (anti dobel)
const SHEET_USER_PREFS = 'UserPrefs';     // preferensi user: zona waktu (WIB/WITA/WIT)

const HEADERS = {
  [SHEET_PENDUKUNG]: ['ID', 'Timestamp', 'Nama', 'NIK', 'JenisKelamin', 'TanggalLahir', 'Usia', 'Kampung', 'RT', 'FotoKTP', 'FotoKTPId', 'Verified', 'FotoTTD', 'FotoTTDId', 'Dicetak'],
  [SHEET_LOG]: ['Timestamp', 'Aksi', 'Username', 'Keterangan'],
  [SHEET_CONFIG]: ['Key', 'Value'],
  [SHEET_USERS]: ['ID', 'Username', 'PasswordHash', 'Nama', 'Role', 'Aktif', 'CreatedAt', 'LastLogin'],
  [SHEET_NOTIF]: ['ID', 'Timestamp', 'Tipe', 'Judul', 'Pesan', 'Aktor', 'Audience', 'DataId', 'Kampung', 'Zona'],
  [SHEET_NOTIF_STATE]: ['Username', 'LastReadAt'],
  [SHEET_PUSH]: ['ID', 'Username', 'Role', 'Endpoint', 'P256dh', 'Auth', 'CreatedAt', 'UserAgent'],
  [SHEET_AGENDA]: ['ID', 'Judul', 'Jenis', 'Tanggal', 'Jam', 'Lokasi', 'Catatan', 'DibuatOleh', 'DibuatPada'],
  [SHEET_REMINDER_LOG]: ['Key', 'SentAt', 'Token'],
  [SHEET_USER_PREFS]: ['Username', 'Mode', 'Zone', 'UpdatedAt']
};
const ALL_SHEETS = Object.keys(HEADERS);

function sheetTitle(name) {
  return `'${name}'`;
}

/** Pastikan semua sheet & header ada — dipanggil saat login/bootstrap */
async function ensureSheets() {
  const { sheets, env } = getGoogle();
  const meta = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: env.spreadsheetId }));
  const existing = new Set((meta.data.sheets || []).map(s => s.properties.title));

  const missing = ALL_SHEETS.filter(n => !existing.has(n));
  if (missing.length) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: env.spreadsheetId,
      resource: { requests: missing.map(title => ({ addSheet: { properties: { title } } })) }
    }));
  }

  // Isi header jika baris pertama kosong
  for (const name of ALL_SHEETS) {
    const check = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: env.spreadsheetId,
      range: `${sheetTitle(name)}!A1:C1`
    }));
    const firstRow = (check.data.values && check.data.values[0]) || [];
    if (!firstRow[0]) {
      const head = HEADERS[name];
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: env.spreadsheetId,
        range: `${sheetTitle(name)}!A1`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [head] }
      }));
    }
  }

  // Kunci kolom penting sebagai TEKS supaya Sheets tidak mengubahnya jadi
  // angka (NIK 16 digit bisa kehilangan digit & tampil notasi ilmiah).
  // Gunakan sheetId sebenarnya (bukan null = "sheet pertama").
  const idByTitle = {};
  (meta.data.sheets || []).forEach(s => { idByTitle[s.properties.title] = s.properties.sheetId; });
  const lockReqs = [
    lockColumnText(idByTitle[SHEET_PENDUKUNG], 4),  // D = NIK
    lockColumnText(idByTitle[SHEET_PENDUKUNG], 9),  // I = RT
    lockColumnText(idByTitle[SHEET_USERS], 2)       // B = Username
  ].filter(r => r);
  if (lockReqs.length) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: env.spreadsheetId,
      resource: { requests: lockReqs }
    }));
  }
}

/** Request format teks untuk satu kolom sheet (sheetId numeric). */
function lockColumnText(sheetId, col) {
  if (sheetId == null) return null;
  return {
    repeatCell: {
      range: { sheetId, startColumnIndex: col - 1, endColumnIndex: col },
      cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } },
      fields: 'userEnteredFormat.numberFormat'
    }
  };
}

/** Baca seluruh nilai sheet (mulai A1). Return array-of-array.
 *  PENTING: UNFORMATTED_VALUE + ISO8601 — nilai MENTAH, bukan tampilan sel.
 *  Default FORMATTED_VALUE membuat NIK 16 digit terbaca "5,20308E+15"
 *  (notasi ilmiah locale) sehingga banyak NIK berbeda tampak sama. */
async function readSheet(name) {
  const { sheets, env } = getGoogle();
  try {
    const res = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: env.spreadsheetId,
      range: `${sheetTitle(name)}!A1:Z`,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER'
    }));
    return res.data.values || [];
  } catch (e) {
    // Sheet belum ada → anggap kosong
    if (e && e.code === 400 && String(e.message || '').indexOf('Unable to parse range') !== -1) return [];
    throw e;
  }
}

/** Tambah satu baris di akhir sheet */
async function appendRow(name, values) {
  const { sheets, env } = getGoogle();
  await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: env.spreadsheetId,
    range: `${sheetTitle(name)}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [values] }
  }));
}

/** Update satu baris berdasarkan nomor baris (1-indexed, termasuk header) */
async function updateRow(name, rowNum, values) {
  const { sheets, env } = getGoogle();
  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: env.spreadsheetId,
    range: `${sheetTitle(name)}!A${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [values] }
  }));
}

/** Update sebagian kolom satu baris mulai kolom tertentu (1-indexed: A=1).
 *  Range akhir dihitung otomatis dari panjang values (API Google menolak
 *  penulisan melebihi range yang diminta). */
async function updateCells(name, rowNum, startCol, values) {
  const { sheets, env } = getGoogle();
  const colLetter = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const startL = colLetter(startCol);
  const endL = colLetter(startCol + values.length - 1);
  const range = (startL === endL)
    ? `${sheetTitle(name)}!${startL}${rowNum}`
    : `${sheetTitle(name)}!${startL}${rowNum}:${endL}${rowNum}`;
  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: env.spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [values] }
  }));
}

/** Update satu kolom untuk banyak baris (batch per range kolom) */
async function updateColumnValues(name, startRow, col, values) {
  const { sheets, env } = getGoogle();
  const colLetter = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const letter = colLetter(col);
  const range = `${sheetTitle(name)}!${letter}${startRow}:${letter}${startRow + values.length - 1}`;
  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: env.spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    resource: { values: values.map(v => [v]) }
  }));
}

/** Hapus satu baris (1-indexed termasuk header) */
async function deleteRow(name, rowNum) {
  const { sheets, env } = getGoogle();
  // Cari sheetId dulu
  const meta = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: env.spreadsheetId }));
  const sh = (meta.data.sheets || []).find(s => s.properties.title === name);
  if (!sh) return;
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: env.spreadsheetId,
    resource: { requests: [{ deleteDimension: { range: { sheetId: sh.properties.sheetId, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum } } }] }
  }));
}

module.exports = {
  SHEET_PENDUKUNG, SHEET_LOG, SHEET_CONFIG, SHEET_USERS, SHEET_NOTIF, SHEET_NOTIF_STATE, SHEET_PUSH, SHEET_AGENDA, SHEET_REMINDER_LOG, SHEET_USER_PREFS,
  ensureSheets, readSheet, appendRow, updateRow, updateCells, updateColumnValues, deleteRow
};
