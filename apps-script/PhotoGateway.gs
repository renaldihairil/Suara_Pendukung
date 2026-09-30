/* ============================================================
 * JEMBATAN FOTO — tambahan untuk aplikasi PWA (Vercel)
 * Tempel SELURUH isi file ini sebagai file baru di project Apps Script
 * (File +  → Skrip → beri nama PhotoGateway), lalu isi PGW_KEY.
 *
 * PENTING — aplikasi lama Anda SUDAH punya doPost (di Code.gs). Jangan buat doPost kedua.
 * Ubah doPost yang lama di Code.gs menjadi:
 *
 *     function doPost(e) {
 *       const pg = pgw_tryHandle_(e);   // permintaan jembatan foto (ada field "op")
 *       if (pg) return pg;
 *       return handleRequest(e);        // permintaan aplikasi lama (ada field "action")
 *     }
 *
 * Skrip ini berjalan atas nama AKUN ANDA, sehingga foto tersimpan di
 * Google Drive Anda (folder yang sama dengan aplikasi lama) tanpa token
 * yang kedaluwarsa. Memakai konstanta DRIVE_FOLDER_NAME & DRIVE_FOLDER_TTD
 * yang sudah ada di Code.gs.
 * ============================================================ */

// GANTI dengan teks acak panjang (min. 24 karakter), lalu salin nilai yang SAMA ke Vercel: APPSCRIPT_PHOTO_KEY
const PGW_KEY = 'GANTI_DENGAN_KUNCI_ACAK_MIN_24_KARAKTER';

/**
 * JALANKAN SEKALI dari editor (pilih fungsi pgwAuthorize di dropdown → Jalankan) untuk memberi izin
 * yang dibutuhkan jembatan (Drive, email akun, Dokumen untuk OCR). Setelah itu Terapkan → versi baru.
 */
// Catatan: fungsi berakhiran "_" bersifat privat dan TIDAK tampil di dropdown; karena itu nama ini tanpa garis bawah.
// Nomor versi skrip ini — tampil di /api/health (foto.versi) agar jelas versi mana yang sedang ter-deploy.
const PGW_VERSION = 6;

/**
 * DIAGNOSIS: jalankan dari editor (pilih pgwDiag → Jalankan → buka "Log eksekusi").
 * Menunjukkan langkah OCR mana yang bekerja/gagal tanpa perlu foto.
 */
function pgwDiag() {
  Logger.log('versi skrip: ' + PGW_VERSION);
  const hasDrive = (typeof Drive !== 'undefined') && !!Drive.Files;
  Logger.log('layanan Drive: ' + hasDrive + ' | create(v3): ' + (hasDrive && !!Drive.Files.create) + ' | insert(v2): ' + (hasDrive && !!Drive.Files.insert) + ' | export: ' + (hasDrive && !!Drive.Files.export));
  let id = '';
  try {
    const meta = { mimeType: 'application/vnd.google-apps.document' };
    const f = Drive.Files.create ? Drive.Files.create(Object.assign({ name: 'pgw_diag_' + Date.now() }, meta))
                                 : Drive.Files.insert(Object.assign({ title: 'pgw_diag_' + Date.now() }, meta));
    id = f.id;
    Logger.log('1) buat Google Doc: OK');
    try {
      const ex = pgw_export_(id);
      Logger.log('2) export Drive: OK (panjang=' + ex.length + ')');
    } catch (e) { Logger.log('2) export Drive: GAGAL — ' + e.message); }
    try { DocumentApp.openById(id).getBody().getText(); Logger.log('3) DocumentApp: OK'); }
    catch (e) { Logger.log('3) DocumentApp: GAGAL — ' + e.message); }
  } catch (e) {
    Logger.log('1) buat Google Doc: GAGAL — ' + e.message);
  } finally {
    if (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* abaikan */ } }
  }
  Logger.log('selesai');
}

function pgwAuthorize() {
  DriveApp.getRootFolder();
  const email = Session.getEffectiveUser().getEmail();
  if (typeof DocumentApp !== 'undefined') DocumentApp.getActiveDocument;   // memicu izin Dokumen (untuk OCR)
  Logger.log('Izin OK untuk: ' + email);
}

/**
 * Ekspor Google Doc ke teks lewat Drive API v3. Layanan lanjutan Apps Script mewajibkan opsi {alt:'media'}
 * ("Export requires alt=media to download the exported content"); coba itu dulu, lalu tanpa opsi.
 * Hasil bisa berupa string atau Blob → selalu dikembalikan sebagai string.
 */
function pgw_export_(docId) {
  const errs = [];
  const tries = [
    ['alt=media', function () { return Drive.Files.export(docId, 'text/plain', { alt: 'media' }); }],
    ['tanpa opsi', function () { return Drive.Files.export(docId, 'text/plain'); }]
  ];
  // Doc hasil OCR kadang belum siap tepat setelah dibuat → ulangi sekali setelah jeda singkat
  for (let round = 0; round < 2; round++) {
    if (round) Utilities.sleep(1500);
    for (let i = 0; i < tries.length; i++) {
      try {
        const ex = tries[i][1]();
        if (typeof ex === 'string') return ex;
        if (ex && ex.getDataAsString) return ex.getDataAsString();
        return ex ? String(ex) : '';
      } catch (err) { errs.push(tries[i][0] + ': ' + (err && err.message ? err.message : err)); }
    }
  }
  throw new Error(errs.join(' ; '));
}

/**
 * Ambil teks dari Google Doc hasil OCR. Utama: ekspor lewat Drive API (memakai izin Drive yang sudah ada,
 * TANPA izin Dokumen). Cadangan: DocumentApp (butuh izin Dokumen).
 */
function pgw_docText_(docId) {
  let why = '';
  try {
    if (typeof Drive !== 'undefined' && Drive.Files && Drive.Files.export) {      // Drive API v3
      const t = pgw_export_(docId);
      if (t && t.trim()) return t;
      why = 'export Drive kosong (tidak ada teks terbaca)';
    } else {
      why = 'Drive.Files.export tidak tersedia (perlu Drive API v3)';
    }
  } catch (err) { why = 'export Drive gagal: ' + (err && err.message ? err.message : err); }
  try {
    return DocumentApp.openById(docId).getBody().getText();
  } catch (err2) {
    throw new Error('OCR gagal — ' + why + ' | DocumentApp: ' + (err2 && err2.message ? err2.message : err2));
  }
}

function pgw_out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function pgw_folder_(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/** Kembalikan ContentService output bila ini permintaan jembatan (punya "op"), selain itu null. */
function pgw_tryHandle_(e) {
  let req = null;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || 'null'); } catch (err) { return null; }
  if (!req || typeof req !== 'object' || !req.op) return null;
  return pgw_handle_(req);
}

function pgw_handle_(req) {
  try {
    if (String(PGW_KEY).indexOf('GANTI_') === 0 || String(PGW_KEY).length < 24) {
      return pgw_out_({ ok: false, message: 'PGW_KEY belum diisi (min. 24 karakter) di skrip' });
    }
    if (!req.key || req.key !== PGW_KEY) return pgw_out_({ ok: false, message: 'Kunci salah' });

    switch (req.op) {
      case 'ping': {
        // Laporkan izin yang sudah/ belum diberikan agar mudah didiagnosis dari /api/health
        const cap = { drive: false, email: false, dokumen: false, driveApi: false };
        let who = '';
        try { DriveApp.getRootFolder(); cap.drive = true; } catch (err) { /* izin Drive belum ada */ }
        try { who = Session.getEffectiveUser().getEmail(); cap.email = true; } catch (err) { /* izin email belum ada */ }
        try { DocumentApp.openById('izin-cek'); cap.dokumen = true; } catch (err) { cap.dokumen = !/do not have permission to call|Required permissions/i.test(String(err && err.message)); }   // ID palsu → 'No item with the given ID ... or you do not have permission to access it' = izin ADA; izin kurang → 'You do not have permission to call DocumentApp...'
        cap.driveApi = (typeof Drive !== 'undefined' && !!Drive.Files);
        return pgw_out_({ ok: true, user: who, cap: cap, ver: PGW_VERSION });
      }

      case 'upload': {
        if (!req.base64) return pgw_out_({ ok: false, message: 'Data foto kosong' });
        const bytes = Utilities.base64Decode(req.base64);
        const blob = Utilities.newBlob(bytes, req.mime || 'image/jpeg', req.name || ('FOTO_' + Date.now() + '.jpg'));
        const folder = pgw_folder_(req.folder === 'ttd' ? DRIVE_FOLDER_TTD : DRIVE_FOLDER_NAME);
        const file = folder.createFile(blob);
        return pgw_out_({ ok: true, fileId: file.getId() });
      }

      case 'trash': {
        if (req.fileId) { try { DriveApp.getFileById(String(req.fileId)).setTrashed(true); } catch (err) { /* sudah tidak ada */ } }
        return pgw_out_({ ok: true });
      }

      case 'get': {
        const blob = DriveApp.getFileById(String(req.fileId)).getBlob();
        return pgw_out_({ ok: true, mime: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) });
      }

      case 'ocr': {
        // OCR gratis bawaan Google Drive: gambar → Google Doc (OCR) → ambil teks → hapus Doc sementara.
        // Butuh Layanan lanjutan "Drive API" (Layanan + → Drive API → Tambahkan).
        if (!req.base64) return pgw_out_({ ok: false, message: 'Data foto kosong' });
        if (typeof Drive === 'undefined' || !Drive.Files) {
          return pgw_out_({ ok: false, code: 'NO_DRIVE_SERVICE', message: 'Layanan lanjutan Drive API belum ditambahkan di Apps Script (Layanan → + → Drive API)' });
        }
        const blob = Utilities.newBlob(Utilities.base64Decode(req.base64), req.mime || 'image/jpeg', 'ocr_tmp.jpg');
        const title = 'ocr_tmp_' + Date.now();
        const convert = function (lang) {
          if (Drive.Files.insert) {            // Drive API v2
            const o = { ocr: true };
            if (lang) o.ocrLanguage = lang;
            return Drive.Files.insert({ title: title, mimeType: 'application/vnd.google-apps.document' }, blob, o);
          }
          const o3 = {};                        // Drive API v3
          if (lang) o3.ocrLanguage = lang;
          return Drive.Files.create({ name: title, mimeType: 'application/vnd.google-apps.document' }, blob, o3);
        };
        let doc;
        try { doc = convert('id'); } catch (e1) { doc = convert(''); }   // bahasa Indonesia; bila ditolak → otomatis
        try {
          return pgw_out_({ ok: true, text: pgw_docText_(doc.id) });
        } finally {
          try { DriveApp.getFileById(doc.id).setTrashed(true); } catch (e2) { /* abaikan */ }
        }
      }

      default:
        return pgw_out_({ ok: false, message: 'op tidak dikenal' });
    }
  } catch (err) {
    return pgw_out_({ ok: false, message: String(err && err.message ? err.message : err) });
  }
}
