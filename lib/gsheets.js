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

const HEADERS = {
  [SHEET_PENDUKUNG]: ['ID', 'Timestamp', 'Nama', 'NIK', 'JenisKelamin', 'TanggalLahir', 'Usia', 'Kampung', 'RT', 'FotoKTP', 'FotoKTPId', 'Verified', 'FotoTTD', 'FotoTTDId', 'Dicetak'],
  [SHEET_LOG]: ['Timestamp', 'Aksi', 'Username', 'Keterangan'],
  [SHEET_CONFIG]: ['Key', 'Value'],
  [SHEET_USERS]: ['ID', 'Username', 'PasswordHash', 'Nama', 'Role', 'Aktif', 'CreatedAt', 'LastLogin'],
};
const ALL_SHEETS = Object.keys(HEADERS);

function sheetTitle(name) {
  return `'${name}'`;
}

let ensureMemo = { at: 0, promise: null };
const ENSURE_TTL = 10 * 60 * 1000; // cukup sekali per 10 menit per instance (hemat kuota baca Sheets)

/** Pastikan semua sheet & header ada — dipanggil saat login/bootstrap */
function ensureSheets() {
  const now = Date.now();
  if (ensureMemo.promise && now - ensureMemo.at < ENSURE_TTL) return ensureMemo.promise;
  const p = doEnsureSheets().catch(e => { ensureMemo = { at: 0, promise: null }; throw e; });
  ensureMemo = { at: now, promise: p };
  return p;
}

async function doEnsureSheets() {
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

  // Isi header jika baris pertama kosong — cek SEMUA sheet dengan satu permintaan baca
  const check = await withRetry(() => sheets.spreadsheets.values.batchGet({
    spreadsheetId: env.spreadsheetId,
    ranges: ALL_SHEETS.map(n => `${sheetTitle(n)}!A1:C1`)
  }));
  const vr = (check.data && check.data.valueRanges) || [];
  for (let i = 0; i < ALL_SHEETS.length; i++) {
    const name = ALL_SHEETS[i];
    const firstRow = (vr[i] && vr[i].values && vr[i].values[0]) || [];
    if (!firstRow[0]) {
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: env.spreadsheetId,
        range: `${sheetTitle(name)}!A1`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [HEADERS[name]] }
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

/* ============================================================
 * Cache baca sheet (per instance serverless, TTL pendek).
 * Tujuan: dashboard/daftar/versi/cek NIK yang datang bersamaan memakai SATU bacaan
 * ke Google Sheets (dulu tiap permintaan membaca ulang seluruh sheet → lambat & boros kuota).
 *  - Bacaan sebelum TULIS (yang memakai nomor baris) WAJIB { fresh: true } agar tak salah baris.
 *  - Setiap tulisan dari instance ini membatalkan cache sheet terkait (versi + epoch anti-balapan).
 *  - Sheet yang sama ditulis aplikasi Apps Script lama / instance lain → data bisa tertinggal ≤ TTL.
 * ============================================================ */
const CACHE_TTL = { [SHEET_PENDUKUNG]: 5000, [SHEET_CONFIG]: 10000, [SHEET_USERS]: 10000 };   // Log: tanpa cache
const readCache = new Map();   // nama -> { at, promise }
const epoch = {};              // nama -> counter pembatalan

function invalidate(name) {
  epoch[name] = (epoch[name] || 0) + 1;
  readCache.delete(name);
}

function cacheFresh(name) {
  const ttl = CACHE_TTL[name] || 0;
  const c = readCache.get(name);
  return ttl && c && Date.now() - c.at < ttl ? c : null;
}

function cachePut(name, promise, startEpoch) {
  if (!(CACHE_TTL[name] > 0)) return;
  readCache.set(name, { at: Date.now(), promise });
  promise.then(() => { if ((epoch[name] || 0) !== startEpoch) readCache.delete(name); },
               () => readCache.delete(name));
}

/** Baca seluruh nilai sheet (mulai A1). Return array-of-array. Jangan ubah isi array hasilnya (dipakai bersama).
 *  PENTING: UNFORMATTED_VALUE + ISO8601 — nilai MENTAH, bukan tampilan sel.
 *  Default FORMATTED_VALUE membuat NIK 16 digit terbaca "5,20308E+15"
 *  (notasi ilmiah locale) sehingga banyak NIK berbeda tampak sama. */
function readSheet(name, opts) {
  if (!(opts && opts.fresh)) {
    const c = cacheFresh(name);
    if (c) return c.promise;
  }
  const start = epoch[name] || 0;
  const p = readSheetRaw(name);
  cachePut(name, p, start);
  return p;
}

async function readSheetRaw(name) {
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

/** Baca beberapa sheet sekaligus (yang belum ter-cache dibaca dalam SATU batchGet). Return array-of-rows per nama. */
async function readSheets(names, opts) {
  const fresh = !!(opts && opts.fresh);
  const out = new Array(names.length);
  const missing = [];
  names.forEach((n, i) => {
    const c = !fresh && cacheFresh(n);
    if (c) out[i] = c.promise; else missing.push(i);
  });
  if (missing.length === 1) {
    out[missing[0]] = readSheet(names[missing[0]], { fresh: true });
  } else if (missing.length > 1) {
    const { sheets, env } = getGoogle();
    const starts = missing.map(i => epoch[names[i]] || 0);
    const batch = (async () => {
      try {
        const res = await withRetry(() => sheets.spreadsheets.values.batchGet({
          spreadsheetId: env.spreadsheetId,
          ranges: missing.map(i => `${sheetTitle(names[i])}!A1:Z`),
          valueRenderOption: 'UNFORMATTED_VALUE',
          dateTimeRenderOption: 'SERIAL_NUMBER'
        }));
        const vr = (res.data && res.data.valueRanges) || [];
        return missing.map((_, k) => (vr[k] && vr[k].values) || []);
      } catch (e) {
        // salah satu sheet belum ada → baca satu per satu (sheet hilang = kosong)
        if (e && e.code === 400 && String(e.message || '').indexOf('Unable to parse range') !== -1) {
          const r = [];
          for (const i of missing) r.push(await readSheetRaw(names[i]));
          return r;
        }
        throw e;
      }
    })();
    missing.forEach((i, k) => {
      const p = batch.then(all => all[k]);
      out[i] = p;
      cachePut(names[i], p, starts[k]);
    });
  }
  return Promise.all(out);
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
  invalidate(name);
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
  invalidate(name);
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
  invalidate(name);
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
  invalidate(name);
}

/** Hapus satu baris (1-indexed termasuk header) */
async function deleteRow(name, rowNum) {
  try {
  const { sheets, env } = getGoogle();
  // Cari sheetId dulu
  const meta = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: env.spreadsheetId }));
  const sh = (meta.data.sheets || []).find(s => s.properties.title === name);
  if (!sh) return;
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: env.spreadsheetId,
    resource: { requests: [{ deleteDimension: { range: { sheetId: sh.properties.sheetId, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum } } }] }
  }));
  } finally { invalidate(name); }
}

module.exports = {
  SHEET_PENDUKUNG, SHEET_LOG, SHEET_CONFIG, SHEET_USERS,
  ensureSheets, invalidate, readSheet, readSheets, appendRow, updateRow, updateCells, updateColumnValues, deleteRow
};
