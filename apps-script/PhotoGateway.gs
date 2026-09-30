/* ============================================================
 * JEMBATAN FOTO — tambahan untuk aplikasi PWA (Vercel)
 * Tempel SELURUH isi file ini sebagai file baru di project Apps Script
 * (File +  → Skrip → beri nama PhotoGateway), lalu isi PGW_KEY.
 *
 * Skrip ini berjalan atas nama AKUN ANDA, sehingga foto tersimpan di
 * Google Drive Anda (folder yang sama dengan aplikasi lama) tanpa token
 * yang kedaluwarsa. Memakai konstanta DRIVE_FOLDER_NAME & DRIVE_FOLDER_TTD
 * yang sudah ada di Code.gs.
 * ============================================================ */

// GANTI dengan teks acak panjang (min. 24 karakter), lalu salin nilai yang SAMA ke Vercel: APPSCRIPT_PHOTO_KEY
const PGW_KEY = 'GANTI_DENGAN_KUNCI_ACAK_MIN_24_KARAKTER';

function pgw_out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function pgw_folder_(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

function doPost(e) {
  try {
    if (String(PGW_KEY).indexOf('GANTI_') === 0 || String(PGW_KEY).length < 24) {
      return pgw_out_({ ok: false, message: 'PGW_KEY belum diisi (min. 24 karakter) di skrip' });
    }
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!req.key || req.key !== PGW_KEY) return pgw_out_({ ok: false, message: 'Kunci salah' });

    switch (req.op) {
      case 'ping':
        return pgw_out_({ ok: true, user: Session.getEffectiveUser().getEmail() });

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

      default:
        return pgw_out_({ ok: false, message: 'op tidak dikenal' });
    }
  } catch (err) {
    return pgw_out_({ ok: false, message: String(err && err.message ? err.message : err) });
  }
}
