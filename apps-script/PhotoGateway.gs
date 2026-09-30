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
function pgwAuthorize() {
  DriveApp.getRootFolder();
  const email = Session.getEffectiveUser().getEmail();
  if (typeof DocumentApp !== 'undefined') DocumentApp.getActiveDocument;   // memicu izin Dokumen (untuk OCR)
  Logger.log('Izin OK untuk: ' + email);
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
        return pgw_out_({ ok: true, user: who, cap: cap });
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
          const text = DocumentApp.openById(doc.id).getBody().getText();
          return pgw_out_({ ok: true, text: text });
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
