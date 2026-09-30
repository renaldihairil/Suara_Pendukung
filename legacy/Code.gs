/*******************************************************
 * APLIKASI DATA PENDUKUNG PILKADES SERUNI MUMBUL 2026
 * Backend: Google Apps Script
 * Version: FINAL v13 (dengan Bukti Fotokopi TTD)
 *
 * FITUR:
 *  - CRUD pendukung (Nama, NIK, JK, Usia, Kampung, RT)
 *  - RT: 001-010 + UMUM
 *  - Auto parse NIK (JK, tgl lahir, usia)
 *  - Verifikasi suara (PASTI/BELUM) dengan kolom Verified
 *  - ⭐ Foto Bukti Fotokopi KTP TTD (kolom M & N)
 *  - Anti duplikat NIK (real-time + server-side)
 *  - Upload foto KTP ke Google Drive
 *  - Realtime version tracking (untuk polling frontend)
 *  - Config dinamis (kampung, target, nama pilkades)
 *  - Rename kampung (auto update data terkait)
 *  - Scan duplikat NIK
 *  - Dashboard dengan statistik verified
 *  - Utility maintenance (fix RT, bersihkan duplikat, dll)
 *******************************************************/

/* ================== KONSTANTA ================== */
const SHEET_PENDUKUNG = 'Pendukung';
const SHEET_LOG = 'Log';
const SHEET_CONFIG = 'Config';

const PASSWORD = 'barengpakemen#1@';

const RT_LIST = ['001','002','003','004','005','006','007','008','009','010','UMUM'];
const RT_UMUM = 'UMUM';

const DRIVE_FOLDER_NAME = 'FOTO_KTP_PENDUKUNG_2026';
const DRIVE_FOLDER_TTD = 'FOTO_BUKTI_TTD_2026';

const DEFAULT_KAMPUNG_LIST = ['Sasak', 'Mandar', 'Barantapen Asri', 'Dames'];
const DEFAULT_TARGET = 500;

const CACHE_VERSION_KEY = 'pg_version_v1';
const CACHE_DASHBOARD_PREFIX = 'pg_dash_v1_';

/* ================== UTIL DASAR ================== */
function getSS() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

// Cegah race condition: semua operasi tulis ke sheet wajib lewat sini.
function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    throw new Error('Server sedang sibuk, silakan coba lagi beberapa detik lagi');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// Panggil setiap kali ada perubahan data supaya client lain langsung tahu (polling).
function invalidateVersionCache() {
  try { CacheService.getScriptCache().remove(CACHE_VERSION_KEY); } catch (e) {}
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function logAksi(aksi, ket) {
  try {
    getSS().getSheetByName(SHEET_LOG).appendRow([new Date(), aksi, ket || '']);
  } catch (e) {}
}

function getOrCreateFolder(folderName) {
  folderName = folderName || DRIVE_FOLDER_NAME;
  const it = DriveApp.getFoldersByName(folderName);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(folderName);
}

/* ================== NORMALISASI ================== */
function normRT(v) {
  if (v == null) return '001';
  let s = String(v).trim();
  s = s.replace(/^['"]+/, '').replace(/['"]+$/, '');
  if (!s) return '001';

  const lower = s.toLowerCase();
  if (lower === 'umum' || lower === 'u' || lower === 'um') {
    return RT_UMUM;
  }

  if (/^\d{1,2}$/.test(s)) return s.padStart(3, '0');
  if (/^\d{3,}$/.test(s)) return s.slice(-3);
  const n = parseInt(s, 10);
  if (!isNaN(n) && n > 0 && n < 1000) return String(n).padStart(3, '0');
  return s;
}

function isValidRT(rt) {
  return RT_LIST.indexOf(rt) !== -1;
}

function normVerified(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'ya' || s === 'yes' || s === 'verified' || s === 'pasti') return true;
  }
  return false;
}

// ⭐ Status "Dicetak" (print out) — independen dari status Verified/TTD.
function normBool(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'ya' || s === 'yes') return true;
  }
  return false;
}

function fmtDate(d) {
  if (!d) return '';
  if (d instanceof Date) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(d);
}

/* ================== SHEET CONFIG ================== */
function getConfigSheet() {
  const ss = getSS();
  let sh = ss.getSheetByName(SHEET_CONFIG);
  if (!sh) {
    sh = ss.insertSheet(SHEET_CONFIG);
    sh.appendRow(['Key', 'Value']);
  }
  return sh;
}

function readConfig() {
  try {
    const sh = getConfigSheet();
    const data = sh.getDataRange().getValues();
    const cfg = {};
    for (let i = 1; i < data.length; i++) {
      const k = String(data[i][0] || '').trim();
      const v = data[i][1];
      if (k) cfg[k] = v;
    }

    let kampungList = DEFAULT_KAMPUNG_LIST.slice();
    if (cfg.kampung_list) {
      try {
        const parsed = JSON.parse(String(cfg.kampung_list));
        if (Array.isArray(parsed) && parsed.length > 0) {
          kampungList = parsed.map(x => String(x).trim()).filter(x => x);
        }
      } catch (e) {}
    }

    let targetPerKampung = {};
    if (cfg.target_per_kampung) {
      try {
        const parsed = JSON.parse(String(cfg.target_per_kampung));
        if (parsed && typeof parsed === 'object') targetPerKampung = parsed;
      } catch (e) {}
    }

    let targetTotal = DEFAULT_TARGET;
    if (cfg.target_total != null && cfg.target_total !== '') {
      const n = parseInt(cfg.target_total, 10);
      if (!isNaN(n) && n > 0) targetTotal = n;
    } else {
      let sum = 0;
      kampungList.forEach(k => sum += parseInt(targetPerKampung[k] || 0, 10));
      if (sum > 0) targetTotal = sum;
    }

    return {
      kampungList: kampungList,
      targetPerKampung: targetPerKampung,
      targetTotal: targetTotal,
      namaPilkades: String(cfg.nama_pilkades || 'Pilkades Seruni Mumbul 2026'),
      namaKandidat: String(cfg.nama_kandidat || 'Pak Muhaimin (Pak Emen)')
    };
  } catch (e) {
    return {
      kampungList: DEFAULT_KAMPUNG_LIST.slice(),
      targetPerKampung: {},
      targetTotal: DEFAULT_TARGET,
      namaPilkades: 'Pilkades Seruni Mumbul 2026',
      namaKandidat: 'Pak Muhaimin (Pak Emen)'
    };
  }
}

function writeConfig(key, value) {
  const sh = getConfigSheet();
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      sh.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sh.appendRow([key, value]);
}

/* ================== PARSE NIK ================== */
function parseNIK(nik) {
  nik = String(nik).trim();
  if (!/^\d{16}$/.test(nik)) return { valid: false, msg: 'NIK harus 16 digit angka' };

  let dd = parseInt(nik.substring(6, 8), 10);
  const mm = parseInt(nik.substring(8, 10), 10);
  const yy = parseInt(nik.substring(10, 12), 10);

  let jk = 'Laki-laki';
  if (dd > 40) { jk = 'Perempuan'; dd = dd - 40; }

  const nowYY = new Date().getFullYear() % 100;
  const tahun = (yy > nowYY) ? 1900 + yy : 2000 + yy;

  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
    return { valid: false, msg: 'NIK tidak valid (tanggal/bulan)' };
  }

  const tglLahir = new Date(tahun, mm - 1, dd);
  const today = new Date();
  let usia = today.getFullYear() - tglLahir.getFullYear();
  const mDiff = today.getMonth() - tglLahir.getMonth();
  if (mDiff < 0 || (mDiff === 0 && today.getDate() < tglLahir.getDate())) usia--;

  return {
    valid: true,
    jenisKelamin: jk,
    tanggalLahir: Utilities.formatDate(tglLahir, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    usia: usia
  };
}

/* ================== CEK NIK DUPLIKAT ================== */
function cariNIKDiSheet(nik, excludeId) {
  const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
  const data = sh.getDataRange().getValues();
  const results = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    const id = String(r[0] || '');
    if (!id) continue;
    if (excludeId && id === String(excludeId)) continue;
    if (String(r[3] || '').trim() === String(nik).trim()) {
      results.push({
        id: id,
        nama: String(r[2] || ''),
        nik: String(r[3] || ''),
        kampung: String(r[7] || ''),
        rt: normRT(r[8])
      });
    }
  }
  return results;
}

/* ================== UPLOAD FOTO ================== */
function uploadFoto(base64Data, mimeType, fileName) {
  if (!base64Data) return { ok: false, msg: 'Data foto kosong' };
  if (!mimeType) mimeType = 'image/jpeg';

  let cleanB64 = String(base64Data);
  const comma = cleanB64.indexOf(',');
  if (comma !== -1 && cleanB64.substring(0, comma).indexOf('base64') !== -1) {
    cleanB64 = cleanB64.substring(comma + 1);
  }

  const bytes = Utilities.base64Decode(cleanB64);
  const blob = Utilities.newBlob(bytes, mimeType, fileName || ('KTP_' + Date.now() + '.jpg'));

  const folder = getOrCreateFolder(DRIVE_FOLDER_NAME);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const fileId = file.getId();
  const viewUrl = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1600';
  return { ok: true, fileId: fileId, url: viewUrl };
}

// ⭐ Upload khusus bukti TTD (folder terpisah)
function uploadBuktiTTD(base64Data, mimeType, fileName) {
  if (!base64Data) return { ok: false, msg: 'Data foto bukti kosong' };
  if (!mimeType) mimeType = 'image/jpeg';

  let cleanB64 = String(base64Data);
  const comma = cleanB64.indexOf(',');
  if (comma !== -1 && cleanB64.substring(0, comma).indexOf('base64') !== -1) {
    cleanB64 = cleanB64.substring(comma + 1);
  }

  const bytes = Utilities.base64Decode(cleanB64);
  const blob = Utilities.newBlob(bytes, mimeType, fileName || ('TTD_' + Date.now() + '.jpg'));

  const folder = getOrCreateFolder(DRIVE_FOLDER_TTD);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const fileId = file.getId();
  const viewUrl = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1600';
  return { ok: true, fileId: fileId, url: viewUrl };
}

function deleteFoto(fileId) {
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) {}
}

// ⭐ Ambil isi foto (base64) dari Drive by fileId, dipakai untuk generate PDF
// A4 di client (hindari CORS kalau fetch langsung dari URL thumbnail Drive).
function getFotoBase64(fileId) {
  const file = DriveApp.getFileById(fileId);
  const blob = file.getBlob();
  const mime = blob.getContentType() || 'image/jpeg';
  const base64 = Utilities.base64Encode(blob.getBytes());
  return { ok: true, dataUrl: 'data:' + mime + ';base64,' + base64, mime: mime };
}

/* ================== VERSION TRACKING ================== */
function getVersionFromSheet() {
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(CACHE_VERSION_KEY);
    if (cached) return cached;

    const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
    if (!sh) return '0|empty';

    const lastRow = sh.getLastRow();
    if (lastRow < 2) return '0|empty';

    const lastId = String(sh.getRange(lastRow, 1).getValue() || '');

    let verifiedCount = 0;
    let ttdCount = 0;
    let printedCount = 0;
    try {
      const verifiedData = sh.getRange(2, 12, lastRow - 1, 1).getValues();
      verifiedData.forEach(r => { if (normVerified(r[0])) verifiedCount++; });

      const ttdData = sh.getRange(2, 13, lastRow - 1, 1).getValues();
      ttdData.forEach(r => { if (String(r[0] || '').trim()) ttdCount++; });

      const printedData = sh.getRange(2, 15, lastRow - 1, 1).getValues();
      printedData.forEach(r => { if (normBool(r[0])) printedCount++; });
    } catch (e) {}

    const cfg = readConfig();
    // ⭐ FIX: dulu pakai cfgHash.length (panjang string) sehingga perubahan
    // nama kampung/kandidat dengan jumlah karakter sama TIDAK terdeteksi
    // oleh client lain yang sedang polling. Sekarang pakai isi hash-nya langsung.
    const cfgHash = cfg.kampungList.join('|') + '|' + cfg.targetTotal + '|' + cfg.namaPilkades + '|' + cfg.namaKandidat;

    const version = lastRow + '|' + lastId + '|' + verifiedCount + '|' + ttdCount + '|' + printedCount + '|' + cfgHash;
    try { cache.put(CACHE_VERSION_KEY, version, 10); } catch (e) {}
    return version;
  } catch (e) {
    return '0|error';
  }
}

/* ================== WEB APP ENTRY ================== */
function doGet(e) {
  if (e && e.parameter && e.parameter.action) {
    return handleRequest(e);
  }
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Data Pendukung Pak Emen - Pilkades 2026')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  return handleRequest(e);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ================== API HANDLER (HTTP) ================== */
function handleRequest(e) {
  try {
    let params = {};
    if (e && e.postData && e.postData.contents) {
      try { params = JSON.parse(e.postData.contents); } catch (err) {}
    }
    if (e && e.parameter) {
      Object.keys(e.parameter).forEach(k => params[k] = e.parameter[k]);
    }

    const action = params.action;
    const password = params.password;

    if (action === 'login') {
      if (password === PASSWORD) {
        logAksi('LOGIN', 'Berhasil');
        return jsonOut({ ok: true, message: 'Login berhasil' });
      }
      logAksi('LOGIN', 'Gagal');
      return jsonOut({ ok: false, message: 'Password salah' });
    }

    if (password !== PASSWORD) {
      return jsonOut({ ok: false, message: 'Unauthorized' });
    }

    switch (action) {
      case 'list':           return jsonOut(apiGetList(params));
      case 'add':            return jsonOut(apiAdd(params));
      case 'update':         return jsonOut(apiUpdate(params));
      case 'delete':         return jsonOut(apiDelete(params));
      case 'dashboard':      return jsonOut(apiGetDashboard());
      case 'version':        return jsonOut(apiGetVersion());
      case 'checkNik':       return jsonOut(apiCheckNik(params));
      case 'scanDuplikat':   return jsonOut(apiScanDuplikat());
      case 'getConfig':      return jsonOut(apiGetConfig());
      case 'saveConfig':     return jsonOut(apiSaveConfig(params.config));
      case 'renameKampung':  return jsonOut(apiRenameKampung(params.oldName, params.newName));
      case 'countKampung':   return jsonOut(apiCountKampung(params.nama));
      case 'toggleVerify':   return jsonOut(apiToggleVerify(params.id, params.verified));
      case 'verifyWithTTD':  return jsonOut(apiVerifyWithTTD(params));
      case 'unverify':       return jsonOut(apiUnverify(params.id));
      case 'getFotoBase64':  return jsonOut(apiGetFotoBase64(params.fileId));
      case 'togglePrint':    return jsonOut(apiTogglePrint(params.id, params.dicetak));
      case 'setPrintBatch':  return jsonOut(apiSetPrintBatch(params.ids, params.dicetak));
      default:               return jsonOut({ ok: false, message: 'Action tidak dikenal' });
    }
  } catch (err) {
    return jsonOut({ ok: false, message: 'Error: ' + err.message });
  }
}

/* ================== SERVER FUNCTIONS ================== */

function apiLogin(password) {
  return (password === PASSWORD)
    ? { ok: true, message: 'Login berhasil' }
    : { ok: false, message: 'Password salah' };
}

function apiGetVersion() {
  try {
    const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
    const lastRow = sh.getLastRow();
    return {
      ok: true,
      total: Math.max(0, lastRow - 1),
      version: getVersionFromSheet()
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function apiCheckNik(params) {
  try {
    const nik = String(params.nik || '').trim();
    const excludeId = params.excludeId ? String(params.excludeId) : null;

    if (!/^\d{16}$/.test(nik)) {
      return { ok: false, message: 'NIK harus 16 digit' };
    }

    const found = cariNIKDiSheet(nik, excludeId);
    if (found.length === 0) {
      return { ok: true, tersedia: true, duplikat: [] };
    }
    return { ok: true, tersedia: false, duplikat: found };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// ⭐ Dipakai fitur "Download KTP (A4)" di client — ambil isi file foto sebagai base64.
function apiGetFotoBase64(fileId) {
  try {
    fileId = String(fileId || '').trim();
    if (!fileId) return { ok: false, message: 'File ID kosong' };
    return getFotoBase64(fileId);
  } catch (e) {
    return { ok: false, message: 'Gagal mengambil foto: ' + e.message };
  }
}

function apiScanDuplikat() {
  try {
    const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
    const data = sh.getDataRange().getValues();
    const map = {};

    for (let i = 1; i < data.length; i++) {
      const r = data[i];
      const id = String(r[0] || '');
      if (!id) continue;
      const nik = String(r[3] || '').trim();
      if (!nik) continue;

      if (!map[nik]) map[nik] = [];
      map[nik].push({
        rowNum: i + 1,
        id: id,
        nama: String(r[2] || ''),
        nik: nik,
        kampung: String(r[7] || ''),
        rt: normRT(r[8]),
        timestamp: r[1] instanceof Date ? r[1].toISOString() : String(r[1])
      });
    }

    const duplikat = [];
    Object.keys(map).forEach(nik => {
      if (map[nik].length > 1) {
        duplikat.push({ nik: nik, entries: map[nik] });
      }
    });

    return {
      ok: true,
      totalGroup: duplikat.length,
      totalBaris: duplikat.reduce((s, d) => s + d.entries.length, 0),
      duplikat: duplikat
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/* ⭐ Verify dengan bukti TTD */
function apiVerifyWithTTD(params) {
  try {
    const id = String(params.id || '');
    if (!id) return { ok: false, message: 'ID tidak ada' };

    return withLock(() => {
    const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
    const rows = sh.getDataRange().getValues();

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === id) {
        // Cek apakah bukti TTD dikirim
        if (!params.fotoTTDBase64) {
          return { ok: false, message: 'Bukti fotokopi TTD wajib diupload' };
        }

        // Upload bukti TTD
        const nama = String(rows[i][2] || '');
        const nik = String(rows[i][3] || '');
        const up = uploadBuktiTTD(
          params.fotoTTDBase64,
          params.fotoTTDMime || 'image/jpeg',
          'TTD_' + nik + '_' + Date.now() + '.jpg'
        );
        if (!up.ok) return { ok: false, message: 'Gagal upload bukti TTD: ' + up.msg };

        // Hapus bukti TTD lama kalau ada
        const oldTTDId = String(rows[i][13] || '');
        if (oldTTDId) deleteFoto(oldTTDId);

        // Update kolom L (verified=true), M (FotoTTD), N (FotoTTDId)
        sh.getRange(i + 1, 12, 1, 3).setValues([[true, up.url, up.fileId]]);

        logAksi('VERIFY_TTD', id + ' / ' + nama + ' - Bukti TTD diupload');
        invalidateVersionCache();

        return {
          ok: true,
          message: 'Suara PASTI ✅ (bukti TTD tersimpan)',
          verified: true,
          fotoTTD: up.url,
          fotoTTDId: up.fileId,
          version: getVersionFromSheet()
        };
      }
    }
    return { ok: false, message: 'Data tidak ditemukan' };
    });
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/* ⭐ Unverify: reset status jadi belum + hapus bukti TTD */
function apiUnverify(id) {
  try {
    if (!id) return { ok: false, message: 'ID tidak ada' };

    return withLock(() => {
    const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
    const rows = sh.getDataRange().getValues();

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === String(id)) {
        const oldTTDId = String(rows[i][13] || '');
        if (oldTTDId) deleteFoto(oldTTDId);

        // Reset kolom L, M, N
        sh.getRange(i + 1, 12, 1, 3).setValues([[false, '', '']]);

        logAksi('UNVERIFY', String(id) + ' - Status direset ke BELUM');
        invalidateVersionCache();

        return {
          ok: true,
          message: 'Status direset ke BELUM PASTI',
          verified: false,
          version: getVersionFromSheet()
        };
      }
    }
    return { ok: false, message: 'Data tidak ditemukan' };
    });
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/* Legacy: verify tanpa TTD (untuk backward compat) */
function apiToggleVerify(id, verified) {
  try {
    if (!id) return { ok: false, message: 'ID tidak ada' };
    return withLock(() => {
    const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
    const rows = sh.getDataRange().getValues();

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === String(id)) {
        const v = normVerified(verified);
        // Kalau unverify → hapus juga bukti TTD
        if (!v) {
          const oldTTDId = String(rows[i][13] || '');
          if (oldTTDId) deleteFoto(oldTTDId);
          sh.getRange(i + 1, 12, 1, 3).setValues([[false, '', '']]);
        } else {
          sh.getRange(i + 1, 12).setValue(true);
        }
        logAksi('VERIFY', String(id) + ' → ' + (v ? 'PASTI' : 'BELUM'));
        invalidateVersionCache();
        return {
          ok: true,
          message: v ? 'Ditandai sebagai Suara PASTI ✅' : 'Ditandai sebagai Suara BELUM PASTI',
          verified: v,
          version: getVersionFromSheet()
        };
      }
    }
    return { ok: false, message: 'Data tidak ditemukan' };
    });
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/* ⭐ Toggle status "Dicetak" (print out) — independen dari Verified/TTD */
function apiTogglePrint(id, dicetak) {
  try {
    if (!id) return { ok: false, message: 'ID tidak ada' };
    return withLock(() => {
      const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
      const rows = sh.getDataRange().getValues();

      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(id)) {
          const v = normBool(dicetak);
          sh.getRange(i + 1, 15).setValue(v);
          logAksi('TOGGLE_CETAK', String(id) + ' → ' + (v ? 'SUDAH DICETAK' : 'BELUM DICETAK'));
          invalidateVersionCache();
          return {
            ok: true,
            message: v ? 'Ditandai sebagai sudah dicetak' : 'Ditandai sebagai belum dicetak',
            dicetak: v,
            version: getVersionFromSheet()
          };
        }
      }
      return { ok: false, message: 'Data tidak ditemukan' };
    });
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/* ⭐ Set status "Dicetak" untuk banyak data sekaligus (dipakai Download KTP Massal) */
function apiSetPrintBatch(ids, dicetak) {
  try {
    if (typeof ids === 'string') {
      try { ids = JSON.parse(ids); } catch (e) { ids = ids.split(','); }
    }
    if (!Array.isArray(ids) || ids.length === 0) return { ok: false, message: 'Tidak ada data dipilih' };
    const idSet = {};
    ids.forEach(id => { idSet[String(id)] = true; });
    const v = normBool(dicetak);

    return withLock(() => {
      const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
      const lastRow = sh.getLastRow();
      if (lastRow < 2) return { ok: false, message: 'Data kosong' };

      const idCol = sh.getRange(2, 1, lastRow - 1, 1).getValues();
      const printRange = sh.getRange(2, 15, lastRow - 1, 1);
      const printCol = printRange.getValues();

      let count = 0;
      for (let i = 0; i < idCol.length; i++) {
        if (idSet[String(idCol[i][0])]) {
          printCol[i][0] = v;
          count++;
        }
      }
      printRange.setValues(printCol);

      logAksi('CETAK_MASSAL', count + ' data → ' + (v ? 'SUDAH DICETAK' : 'BELUM DICETAK'));
      invalidateVersionCache();
      return { ok: true, count: count, dicetak: v, version: getVersionFromSheet() };
    });
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function apiGetConfig() {
  try {
    return { ok: true, data: readConfig() };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function apiSaveConfig(cfg) {
  try {
    if (!cfg || typeof cfg !== 'object') {
      return { ok: false, message: 'Data config tidak valid' };
    }

    let kampungList = cfg.kampungList;
    if (!Array.isArray(kampungList)) {
      return { ok: false, message: 'Daftar kampung tidak valid' };
    }
    kampungList = kampungList.map(x => String(x || '').trim()).filter(x => x);
    if (kampungList.length === 0) {
      return { ok: false, message: 'Minimal 1 kampung' };
    }

    const seen = {};
    const unique = [];
    kampungList.forEach(k => {
      const lower = k.toLowerCase();
      if (!seen[lower]) { seen[lower] = true; unique.push(k); }
    });
    kampungList = unique;

    const targetPerKampung = {};
    let targetTotal = 0;
    kampungList.forEach(k => {
      const t = parseInt((cfg.targetPerKampung || {})[k] || 0, 10);
      const val = (!isNaN(t) && t >= 0) ? t : 0;
      targetPerKampung[k] = val;
      targetTotal += val;
    });

    if (cfg.targetTotal != null && cfg.targetTotal !== '') {
      const t = parseInt(cfg.targetTotal, 10);
      if (!isNaN(t) && t > 0) targetTotal = t;
    }
    if (targetTotal <= 0) targetTotal = DEFAULT_TARGET;

    return withLock(() => {
      writeConfig('kampung_list', JSON.stringify(kampungList));
      writeConfig('target_per_kampung', JSON.stringify(targetPerKampung));
      writeConfig('target_total', String(targetTotal));
      if (cfg.namaPilkades != null) writeConfig('nama_pilkades', String(cfg.namaPilkades));
      if (cfg.namaKandidat != null) writeConfig('nama_kandidat', String(cfg.namaKandidat));

      logAksi('SAVE_CONFIG', kampungList.length + ' kampung, target total ' + targetTotal);
      invalidateVersionCache();

      return {
        ok: true,
        message: 'Pengaturan berhasil disimpan',
        data: readConfig()
      };
    });
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function apiRenameKampung(oldName, newName) {
  try {
    oldName = String(oldName || '').trim();
    newName = String(newName || '').trim();
    if (!oldName || !newName) return { ok: false, message: 'Nama lama/baru wajib' };
    if (oldName === newName) return { ok: false, message: 'Nama sama' };

    return withLock(() => {
      const cfg = readConfig();
      if (cfg.kampungList.indexOf(newName) !== -1) {
        return { ok: false, message: 'Nama kampung baru sudah dipakai' };
      }

      const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
      const data = sh.getDataRange().getValues();
      let updated = 0;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][7]).trim() === oldName) {
          sh.getRange(i + 1, 8).setValue(newName);
          updated++;
        }
      }

      const newList = cfg.kampungList.map(k => k === oldName ? newName : k);
      const newTarget = {};
      Object.keys(cfg.targetPerKampung).forEach(k => {
        newTarget[k === oldName ? newName : k] = cfg.targetPerKampung[k];
      });

      writeConfig('kampung_list', JSON.stringify(newList));
      writeConfig('target_per_kampung', JSON.stringify(newTarget));

      logAksi('RENAME_KAMPUNG', oldName + ' → ' + newName + ' (' + updated + ' baris)');
      invalidateVersionCache();

      return {
        ok: true,
        message: 'Kampung di-rename (' + updated + ' data diupdate)',
        data: readConfig()
      };
    });
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function apiCountKampung(nama) {
  try {
    const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
    const data = sh.getDataRange().getValues();
    let count = 0;
    for (let i = 1; i < data.length; i++) {
      if (!data[i][0]) continue;
      if (String(data[i][7]).trim() === String(nama).trim()) count++;
    }
    return { ok: true, count: count };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function apiGetDashboard() {
  try {
    const version = getVersionFromSheet();
    const cache = CacheService.getScriptCache();
    const cacheKey = CACHE_DASHBOARD_PREFIX + version;
    const cached = cache.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }

    const cfg = readConfig();
    const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
    const data = sh.getDataRange().getValues().slice(1).filter(r => r[0]);

    const today = new Date(); today.setHours(0,0,0,0);
    let todayCount = 0;

    const kampungCount = {};
    cfg.kampungList.forEach(k => kampungCount[k] = 0);

    const kampungVerified = {};
    cfg.kampungList.forEach(k => kampungVerified[k] = 0);

    let laki = 0, perempuan = 0;
    let verified = 0, unverified = 0;
    let ttdCount = 0;
    let unknownKampung = 0;
    let dicetak = 0, belumCetak = 0;

    data.forEach(r => {
      const ts = new Date(r[1]); ts.setHours(0,0,0,0);
      if (ts.getTime() === today.getTime()) todayCount++;

      const kampungNama = String(r[7] || '').trim();
      if (kampungCount[kampungNama] === undefined) {
        kampungCount[kampungNama] = 0;
        kampungVerified[kampungNama] = 0;
        if (cfg.kampungList.indexOf(kampungNama) === -1) unknownKampung++;
      }
      kampungCount[kampungNama] = (kampungCount[kampungNama] || 0) + 1;

      if (r[4] === 'Laki-laki') laki++;
      else if (r[4] === 'Perempuan') perempuan++;

      const isVerified = normVerified(r[11]);
      if (isVerified) {
        verified++;
        kampungVerified[kampungNama] = (kampungVerified[kampungNama] || 0) + 1;
      } else {
        unverified++;
      }

      // Hitung bukti TTD
      if (String(r[12] || '').trim()) ttdCount++;

      // ⭐ Hitung status cetak (kolom O)
      if (normBool(r[14])) dicetak++; else belumCetak++;
    });

    const targetPerKampung = {};
    cfg.kampungList.forEach(k => {
      targetPerKampung[k] = parseInt(cfg.targetPerKampung[k] || 0, 10) || 0;
    });

    const result = {
      ok: true,
      data: {
        total: data.length,
        hariIni: todayCount,
        perKampung: kampungCount,
        kampungVerified: kampungVerified,
        targetPerKampung: targetPerKampung,
        laki: laki,
        perempuan: perempuan,
        verified: verified,
        unverified: unverified,
        ttdCount: ttdCount,
        dicetak: dicetak,
        belumCetak: belumCetak,
        target: cfg.targetTotal,
        kampungList: cfg.kampungList,
        namaPilkades: cfg.namaPilkades,
        namaKandidat: cfg.namaKandidat,
        unknownKampung: unknownKampung,
        version: version
      }
    };
    try { cache.put(cacheKey, JSON.stringify(result), 30); } catch (e) {}
    return result;
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function apiGetList(filter) {
  try {
    filter = filter || {};
    const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
    const data = sh.getDataRange().getValues();
    const list = [];

    for (let i = 1; i < data.length; i++) {
      const r = data[i];
      if (!r[0]) continue;

      const fotoId = r[10] || '';
      const fotoTTDId = r[13] || '';
      list.push({
        id: String(r[0]),
        timestamp: r[1] instanceof Date ? r[1].toISOString() : String(r[1]),
        nama: String(r[2] || ''),
        nik: String(r[3] || ''),
        jenisKelamin: String(r[4] || ''),
        tanggalLahir: fmtDate(r[5]),
        usia: r[6] || 0,
        kampung: String(r[7] || ''),
        rt: normRT(r[8]),
        fotoKTP: String(r[9] || ''),
        fotoKTPId: String(fotoId),
        fotoThumb: fotoId ? ('https://drive.google.com/thumbnail?id=' + fotoId + '&sz=w400') : '',
        verified: normVerified(r[11]),
        fotoTTD: String(r[12] || ''),
        fotoTTDId: String(fotoTTDId),
        fotoTTDThumb: fotoTTDId ? ('https://drive.google.com/thumbnail?id=' + fotoTTDId + '&sz=w400') : '',
        dicetak: normBool(r[14])
      });
    }

    list.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime() || 0;
      const tb = new Date(b.timestamp).getTime() || 0;
      if (tb !== ta) return tb - ta;
      return String(b.id).localeCompare(String(a.id));
    });

    let result = list;
    if (filter.kampung) {
      const fk = String(filter.kampung).trim();
      result = result.filter(x => String(x.kampung).trim() === fk);
    }
    if (filter.rt) {
      const frt = normRT(filter.rt);
      result = result.filter(x => normRT(x.rt) === frt);
    }
    if (filter.q) {
      const q = String(filter.q).toLowerCase();
      result = result.filter(x =>
        x.nama.toLowerCase().includes(q) || x.nik.includes(q)
      );
    }
    if (filter.verified === 'true' || filter.verified === true) {
      result = result.filter(x => x.verified === true);
    } else if (filter.verified === 'false' || filter.verified === false) {
      result = result.filter(x => x.verified !== true);
    }
    if (filter.dicetak === 'true' || filter.dicetak === true) {
      result = result.filter(x => x.dicetak === true);
    } else if (filter.dicetak === 'false' || filter.dicetak === false) {
      result = result.filter(x => x.dicetak !== true);
    }

    return {
      ok: true,
      data: result,
      total: result.length,
      grandTotal: list.length,
      config: readConfig(),
      version: getVersionFromSheet()
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function apiAdd(data) {
  try {
    const cfg = readConfig();
    const nama = (data.nama || '').trim();
    const nik = (data.nik || '').trim();
    const kampung = (data.kampung || '').trim();
    const rt = normRT(data.rt);

    if (!nama) return { ok: false, message: 'Nama wajib diisi' };
    if (!/^\d{16}$/.test(nik)) return { ok: false, message: 'NIK harus 16 digit' };
    if (cfg.kampungList.indexOf(kampung) === -1) {
      return { ok: false, message: 'Kampung tidak valid' };
    }
    if (!isValidRT(rt)) {
      return { ok: false, message: 'RT tidak valid' };
    }

    const parsed = parseNIK(nik);
    if (!parsed.valid) return { ok: false, message: parsed.msg };

    // ⭐ FIX: cek duplikat + tulis baris dibungkus lock supaya 2 user yang
    // input NIK sama secara bersamaan tidak lolos berdua (race condition).
    return withLock(() => {
      const duplikat = cariNIKDiSheet(nik);
      if (duplikat.length > 0) {
        return {
          ok: false,
          message: 'NIK sudah terdaftar: ' + duplikat[0].nama +
                   ' (' + duplikat[0].kampung + ' RT ' + duplikat[0].rt + ')',
          duplikat: duplikat
        };
      }

      let fotoUrl = '', fotoId = '';
      if (data.fotoBase64) {
        const up = uploadFoto(
          data.fotoBase64,
          data.fotoMime || 'image/jpeg',
          'KTP_' + nik + '_' + Date.now() + '.jpg'
        );
        if (!up.ok) return { ok: false, message: 'Gagal upload foto: ' + up.msg };
        fotoUrl = up.url;
        fotoId = up.fileId;
      }

      // ⭐ Optional: bukti TTD saat add (biasanya kosong, tapi support kalau ada)
      let fotoTTDUrl = '', fotoTTDId = '';
      if (data.fotoTTDBase64) {
        const upTTD = uploadBuktiTTD(
          data.fotoTTDBase64,
          data.fotoTTDMime || 'image/jpeg',
          'TTD_' + nik + '_' + Date.now() + '.jpg'
        );
        if (upTTD.ok) {
          fotoTTDUrl = upTTD.url;
          fotoTTDId = upTTD.fileId;
        }
      }

      const id = 'P' + Date.now();
      const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
      sh.appendRow([
        id,
        new Date(),
        nama,
        nik,
        parsed.jenisKelamin,
        parsed.tanggalLahir,
        parsed.usia,
        kampung,
        "'" + rt,
        fotoUrl,
        fotoId,
        false,       // L: Verified
        fotoTTDUrl,  // M: FotoTTD
        fotoTTDId,   // N: FotoTTDId
        false        // O: Dicetak
      ]);

      logAksi('ADD', nama + ' / ' + nik + ' / RT ' + rt);
      invalidateVersionCache();

      return {
        ok: true,
        message: 'Data berhasil disimpan',
        id: id,
        version: getVersionFromSheet()
      };
    });
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function apiUpdate(data) {
  try {
    const id = String(data.id || '');
    if (!id) return { ok: false, message: 'ID tidak ada' };

    // ⭐ FIX: dibungkus lock supaya edit yang beririsan (mis. cek NIK duplikat
    // lalu tulis) tidak saling menimpa antar user.
    return withLock(() => {
    const cfg = readConfig();
    const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
    const rows = sh.getDataRange().getValues();

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === id) {
        const nama = (data.nama || rows[i][2]).trim();
        const nik = (data.nik || String(rows[i][3])).trim();
        const kampung = (data.kampung || rows[i][7]).trim();
        const rt = normRT(data.rt || rows[i][8]);

        if (!/^\d{16}$/.test(nik)) return { ok: false, message: 'NIK harus 16 digit' };
        if (cfg.kampungList.indexOf(kampung) === -1) {
          return { ok: false, message: 'Kampung tidak valid' };
        }
        if (!isValidRT(rt)) {
          return { ok: false, message: 'RT tidak valid' };
        }
        const parsed = parseNIK(nik);
        if (!parsed.valid) return { ok: false, message: parsed.msg };

        const duplikat = cariNIKDiSheet(nik, id);
        if (duplikat.length > 0) {
          return {
            ok: false,
            message: 'NIK sudah dipakai: ' + duplikat[0].nama +
                     ' (' + duplikat[0].kampung + ' RT ' + duplikat[0].rt + ')',
            duplikat: duplikat
          };
        }

        let fotoUrl = rows[i][9] || '';
        let fotoId = rows[i][10] || '';
        if (data.fotoBase64) {
          if (fotoId) deleteFoto(fotoId);
          const up = uploadFoto(
            data.fotoBase64,
            data.fotoMime || 'image/jpeg',
            'KTP_' + nik + '_' + Date.now() + '.jpg'
          );
          if (!up.ok) return { ok: false, message: 'Gagal upload foto: ' + up.msg };
          fotoUrl = up.url;
          fotoId = up.fileId;
        }

        // ⭐ Bukti TTD: kalau ada upload baru, ganti
        let fotoTTDUrl = rows[i][12] || '';
        let fotoTTDId = rows[i][13] || '';
        if (data.fotoTTDBase64) {
          if (fotoTTDId) deleteFoto(fotoTTDId);
          const upTTD = uploadBuktiTTD(
            data.fotoTTDBase64,
            data.fotoTTDMime || 'image/jpeg',
            'TTD_' + nik + '_' + Date.now() + '.jpg'
          );
          if (!upTTD.ok) return { ok: false, message: 'Gagal upload bukti TTD: ' + upTTD.msg };
          fotoTTDUrl = upTTD.url;
          fotoTTDId = upTTD.fileId;
        }

        const existingVerified = normVerified(rows[i][11]);

        // Update kolom C-N (12 kolom: C sampai N)
        sh.getRange(i + 1, 3, 1, 12).setValues([[
          nama,
          nik,
          parsed.jenisKelamin,
          parsed.tanggalLahir,
          parsed.usia,
          kampung,
          "'" + rt,
          fotoUrl,
          fotoId,
          existingVerified,
          fotoTTDUrl,
          fotoTTDId
        ]]);

        logAksi('UPDATE', id + ' / ' + nama + ' / RT ' + rt);
        invalidateVersionCache();

        return {
          ok: true,
          message: 'Data berhasil diperbarui',
          version: getVersionFromSheet()
        };
      }
    }
    return { ok: false, message: 'Data tidak ditemukan' };
    });
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function apiDelete(id) {
  try {
    const idStr = String(id || '');
    if (!idStr) return { ok: false, message: 'ID tidak ada' };

    // ⭐ FIX: dibungkus lock supaya delete tidak beririsan dengan add/update lain.
    return withLock(() => {
    const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
    const rows = sh.getDataRange().getValues();

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === idStr) {
        const nama = rows[i][2];
        // Hapus foto KTP
        if (rows[i][10]) deleteFoto(rows[i][10]);
        // Hapus bukti TTD
        if (rows[i][13]) deleteFoto(rows[i][13]);
        sh.deleteRow(i + 1);
        logAksi('DELETE', idStr + ' / ' + nama);
        invalidateVersionCache();
        return {
          ok: true,
          message: 'Data dihapus',
          version: getVersionFromSheet()
        };
      }
    }
    return { ok: false, message: 'Data tidak ditemukan' };
    });
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/* ================== INIT / SETUP ================== */
function initSheets() {
  const ss = getSS();

  let sh = ss.getSheetByName(SHEET_PENDUKUNG);
  if (!sh) {
    sh = ss.insertSheet(SHEET_PENDUKUNG);
    sh.appendRow([
      'ID',
      'Timestamp',
      'Nama',
      'NIK',
      'JenisKelamin',
      'TanggalLahir',
      'Usia',
      'Kampung',
      'RT',
      'FotoKTP',
      'FotoKTPId',
      'Verified',
      'FotoTTD',
      'FotoTTDId',
      'Dicetak'
    ]);
  } else {
    // Pastikan header kolom L, M, N, O ada
    const header = sh.getRange(1, 1, 1, 20).getValues()[0];
    if (String(header[11] || '').trim() === '') {
      sh.getRange(1, 12).setValue('Verified');
    }
    if (String(header[12] || '').trim() === '') {
      sh.getRange(1, 13).setValue('FotoTTD');
    }
    if (String(header[13] || '').trim() === '') {
      sh.getRange(1, 14).setValue('FotoTTDId');
    }
    if (String(header[14] || '').trim() === '') {
      sh.getRange(1, 15).setValue('Dicetak');
    }
  }

  sh.getRange('I:I').setNumberFormat('@');
  sh.getRange('L:L').setNumberFormat('@');
  sh.getRange('O:O').setNumberFormat('@');

  if (!ss.getSheetByName(SHEET_LOG)) {
    const log = ss.insertSheet(SHEET_LOG);
    log.appendRow(['Timestamp', 'Aksi', 'Keterangan']);
  }

  getConfigSheet();

  const cfg = readConfig();
  writeConfig('kampung_list', JSON.stringify(cfg.kampungList));
  writeConfig('target_per_kampung', JSON.stringify(cfg.targetPerKampung));
  writeConfig('target_total', String(cfg.targetTotal));
  writeConfig('nama_pilkades', cfg.namaPilkades);
  writeConfig('nama_kandidat', cfg.namaKandidat);

  Logger.log('Init selesai');
}

/* ================== UTILITY / MAINTENANCE ================== */

function fixRTDiSheet() {
  const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) { Logger.log('Tidak ada data'); return; }

  sh.getRange('I:I').setNumberFormat('@');
  const rtRange = sh.getRange(2, 9, lastRow - 1, 1);
  const values = rtRange.getValues();
  let fixCount = 0;

  const newValues = values.map(r => {
    const fixed = normRT(r[0]);
    if (String(r[0]).replace(/^'/, '') !== fixed) fixCount++;
    return [fixed];
  });

  rtRange.setValues(newValues);
  Logger.log('Fix ' + fixCount + ' baris RT');
}

function bersihkanBarisRusak() {
  const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) { Logger.log('Tidak ada data'); return; }

  const data = sh.getDataRange().getValues();
  let dihapus = 0;

  for (let i = data.length - 1; i >= 1; i--) {
    const r = data[i];
    const id = String(r[0] || '').trim();
    const nama = String(r[2] || '').trim();
    const nik = String(r[3] || '').trim();
    if (!id || (!nama && !nik)) {
      sh.deleteRow(i + 1);
      dihapus++;
    }
  }
  Logger.log('Hapus ' + dihapus + ' baris rusak');
}

function bersihkanDuplikatNIK() {
  const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
  const data = sh.getDataRange().getValues();
  const map = {};

  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    const id = String(r[0] || '');
    if (!id) continue;
    const nik = String(r[3] || '').trim();
    if (!nik) continue;
    const ts = r[1] instanceof Date ? r[1].getTime() : new Date(r[1]).getTime() || 0;

    if (!map[nik]) map[nik] = [];
    map[nik].push({ rowNum: i + 1, ts: ts, nama: r[2] });
  }

  let toDelete = [];
  Object.keys(map).forEach(nik => {
    const arr = map[nik];
    if (arr.length > 1) {
      arr.sort((a, b) => b.ts - a.ts);
      for (let i = 1; i < arr.length; i++) {
        toDelete.push(arr[i].rowNum);
      }
    }
  });

  toDelete.sort((a, b) => b - a);
  toDelete.forEach(rowNum => sh.deleteRow(rowNum));

  Logger.log('Hapus ' + toDelete.length + ' baris duplikat');
  return toDelete.length;
}

function fixSharingSemuaFoto() {
  const folder = getOrCreateFolder(DRIVE_FOLDER_NAME);
  const files = folder.getFiles();
  let count = 0;
  while (files.hasNext()) {
    const f = files.next();
    try {
      f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      count++;
    } catch (e) {}
  }
  Logger.log('Fix sharing ' + count + ' file KTP');

  // Juga folder TTD
  const folderTTD = getOrCreateFolder(DRIVE_FOLDER_TTD);
  const filesTTD = folderTTD.getFiles();
  let countTTD = 0;
  while (filesTTD.hasNext()) {
    const f = filesTTD.next();
    try {
      f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      countTTD++;
    } catch (e) {}
  }
  Logger.log('Fix sharing ' + countTTD + ' file TTD');
}

function migrasiKolomVerified() {
  const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) { Logger.log('Tidak ada data'); return; }

  sh.getRange('L:L').setNumberFormat('@');
  sh.getRange(2, 12, lastRow - 1, 1).setValue(false);
  Logger.log('Set semua ' + (lastRow - 1) + ' baris verified=false');
}

// ⭐ Migrasi: pastikan kolom M & N ada di semua baris
function migrasiKolomTTD() {
  const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) { Logger.log('Tidak ada data'); return; }

  // Pastikan header ada
  const header = sh.getRange(1, 1, 1, 20).getValues()[0];
  if (String(header[12] || '').trim() === '') sh.getRange(1, 13).setValue('FotoTTD');
  if (String(header[13] || '').trim() === '') sh.getRange(1, 14).setValue('FotoTTDId');

  // Set default kosong di kolom M & N untuk semua baris
  sh.getRange(2, 13, lastRow - 1, 2).setValue('');
  Logger.log('Migrasi kolom TTD selesai untuk ' + (lastRow - 1) + ' baris');
}

function verifikasiMassalByNIK(daftarNIK) {
  const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
  const data = sh.getDataRange().getValues();
  const set = {};
  (daftarNIK || []).forEach(n => set[String(n).trim()] = true);

  let count = 0;
  for (let i = 1; i < data.length; i++) {
    const nik = String(data[i][3] || '').trim();
    if (set[nik]) {
      sh.getRange(i + 1, 12).setValue(true);
      count++;
    }
  }
  Logger.log('Verifikasi ' + count + ' baris');
  return count;
}

function debugSheet() {
  const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
  const lastRow = sh.getLastRow();
  Logger.log('Total baris: ' + lastRow);
  const start = Math.max(2, lastRow - 4);
  const rows = sh.getRange(start, 1, lastRow - start + 1, 14).getValues();
  rows.forEach((r, i) => {
    Logger.log('Baris ' + (start + i) + ': ID=' + r[0] +
               ' | Nama=' + r[2] +
               ' | NIK=' + r[3] +
               ' | RT=' + r[8] +
               ' | Verified=' + r[11] +
               ' | TTD=' + (r[12] ? 'ADA' : 'kosong'));
  });
}

function debugConfig() {
  const cfg = readConfig();
  Logger.log(JSON.stringify(cfg, null, 2));
}

function testPerforma() {
  const t0 = new Date();
  const sh = getSS().getSheetByName(SHEET_PENDUKUNG);
  const data = sh.getDataRange().getValues();
  const t1 = new Date();
  Logger.log('Baca sheet: ' + (t1 - t0) + ' ms, ' + data.length + ' baris');

  const t2 = new Date();
  const list = data.slice(1).map(r => ({ id: r[0], nama: r[2], nik: r[3] }));
  const t3 = new Date();
  Logger.log('Map data: ' + (t3 - t2) + ' ms');

  const t4 = new Date();
  CacheService.getScriptCache().put('test', JSON.stringify(list), 60);
  const t5 = new Date();
  Logger.log('Tulis cache: ' + (t5 - t4) + ' ms');
}