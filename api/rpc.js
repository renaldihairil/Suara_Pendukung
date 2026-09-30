'use strict';
/* ============================================================
 * /api/rpc — satu endpoint untuk semua "action" (port dari
 * handleRequest Code.gs). Auth via JWT cookie; aksi tulis
 * hanya admin (diverifikasi di SERVER, bukan cuma UI).
 * ============================================================ */
const store = require('../lib/store');
const auth = require('../lib/auth');
const sheets = require('../lib/gsheets');
const drive = require('../lib/gdrive');
const ocr = require('../lib/ocr');
const ktp = require('../lib/ktp');

const WRITE_ACTIONS = new Set([
  'add', 'update', 'delete', 'verifyWithTTD', 'unverify',
  'togglePrint', 'setPrintBatch', 'saveConfig', 'renameKampung',
  'saveUsers', 'resetUserPassword', 'updateUser', 'saveHariH'
]);
const ADMIN_ONLY_READ = new Set(['getUsers', 'getLogs']);

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Payload terlalu besar')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.end();
  }
  if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'Method tidak didukung' });

  let params;
  try { params = await readBody(req); }
  catch (e) { return json(res, 413, { ok: false, message: e.message }); }

  // Frontend memanggil fungsi ala Apps Script (apiGetList, apiAdd, ...).
  // Normalisasi: buang prefix "api" + lowercase huruf pertama
  // → getList, add, verifyWithTTD, dst. (identik dengan action legacy)
  // api-shim mengirim pemanggilan dengan argumen POSISI sebagai { args: [...] } → petakan ke nama parameter
  const ARG_NAMES = {
    delete: ['id'], unverify: ['id'], togglePrint: ['id', 'dicetak'], setPrintBatch: ['ids', 'dicetak'],
    renameKampung: ['oldName', 'newName'], countKampung: ['nama'], getFotoBase64: ['fileId']
  };
  const action = String(params.action || '')
    .replace(/^api/, '')
    .replace(/^./, c => c.toLowerCase());
  if (!action) return json(res, 400, { ok: false, message: 'Action tidak ada' });
  if (Array.isArray(params.args) && ARG_NAMES[action]) {
    ARG_NAMES[action].forEach((k, i) => { if (params[k] === undefined) params[k] = params.args[i]; });
  }

  const session = auth.getSessionFromReq(req);
  if (!session) return json(res, 401, { ok: false, message: 'Unauthorized' });

  if ((WRITE_ACTIONS.has(action) || ADMIN_ONLY_READ.has(action)) && session.role !== 'admin') {
    await store.logAksi('AKSES_DITOLAK', session.username, 'Coba aksi: ' + action);
    return json(res, 403, { ok: false, message: 'Aksi ini khusus admin' });
  }

  try {
    let r;
    switch (action) {
      /* ============ READ (semua role terautentikasi) ============ */
      case 'list':
      case 'getList':       r = await store.getList(params); break;
      case 'dashboard':
      case 'getDashboard':  r = await store.getDashboard(); break;
      case 'version':
      case 'getVersion': {
        const rows = await sheets.readSheet(sheets.SHEET_PENDUKUNG);
        let total = 0;
        for (let i = 1; i < rows.length; i++) if (String(rows[i][0] || '').trim()) total++;
        r = { ok: true, total, version: await store.getVersion() };
        break;
      }
      case 'checkNik':      r = await store.checkNik(params); break;
      case 'scanDuplikat':  r = await store.scanDuplikat(); break;
      case 'getConfig':     r = { ok: true, data: await store.readConfig() }; break;
      case 'countKampung':  r = await store.countKampung(params.nama); break;
      case 'ocrKtp': {
        // Baca Nama & NIK dari foto KTP (semua role terautentikasi; admin yang memakai form input)
        const m = String(params.image || '').match(/^data:image\/[a-z+.-]+;base64,(.+)$/i);
        const b64 = m ? m[1] : String(params.image || '');
        if (!b64 || b64.length < 1000) { r = { ok: false, code: 'OCR_NOIMG', message: 'Foto tidak valid' }; break; }
        if (b64.length > 4 * 1024 * 1024) { r = { ok: false, code: 'OCR_TOOBIG', message: 'Foto terlalu besar untuk dibaca' }; break; }
        try {
          const o = await ocr.recognize(b64);
          const parsed = ktp.parseKtpText(o.text);
          r = { ok: true, hasText: !!String(o.text).trim(), provider: o.provider || '', ms: o.ms || 0, data: parsed };
        } catch (e) {
          const det = String((e && (e.detail || e.message)) || '').slice(0, 480);
          const MSG = {
            OCR_DISABLED: 'Baca otomatis belum aktif',
            OCR_DENIED: 'Izin Apps Script belum lengkap (lihat README bagian "Izin Apps Script")'
          };
          const code = e && e.code;
          r = { ok: false, code: MSG[code] ? code : 'OCR_FAILED', detail: det,
                message: (e && e.multi ? 'Baca otomatis belum bisa dipakai' : (MSG[code] || 'Gagal membaca foto KTP')) + (det ? ' — ' + det : '') };
        }
        break;
      }
      case 'getFotoBase64': {
        const fileId = String(params.fileId || '').trim();
        if (!fileId) { r = { ok: false, message: 'File ID kosong' }; break; }
        const f = await drive.getFileBase64(fileId);
        r = { ok: true, dataUrl: 'data:' + f.mime + ';base64,' + f.base64, mime: f.mime };
        break;
      }

      /* ============ WRITE (admin only, sudah di-guard) ============ */
      case 'add': {
        r = await store.addPendukung(params);
        if (r.ok) await store.logAksi('ADD', session.username, params.nama + ' / ' + params.nik + ' / RT ' + (params.rt || ''));
        break;
      }
      case 'update': {
        r = await store.updatePendukung(params);
        if (r.ok) await store.logAksi('UPDATE', session.username, params.id + ' / ' + params.nama);
        break;
      }
      case 'delete': {
        r = await store.deletePendukung(params.id);
        if (r.ok) await store.logAksi('DELETE', session.username, String(params.id));
        break;
      }
      case 'verifyWithTTD': {
        r = await store.verifyWithTTD(params);
        if (r.ok) await store.logAksi('VERIFY_TTD', session.username, params.id + ' — bukti TTD diupload');
        break;
      }
      case 'unverify': {
        r = await store.unverifyPendukung(params.id);
        if (r.ok) await store.logAksi('UNVERIFY', session.username, String(params.id));
        break;
      }
      case 'togglePrint': {
        r = await store.togglePrint(params.id, params.dicetak);
        if (r.ok) await store.logAksi('TOGGLE_CETAK', session.username, String(params.id) + ' → ' + (r.dicetak ? 'SUDAH' : 'BELUM'));
        break;
      }
      case 'setPrintBatch': {
        r = await store.setPrintBatch(params.ids, params.dicetak);
        if (r.ok) await store.logAksi('CETAK_MASSAL', session.username, r.count + ' data → ' + (r.dicetak ? 'SUDAH' : 'BELUM'));
        break;
      }
      case 'saveConfig': {
        r = await store.saveConfig(params.config || params);
        if (r.ok) await store.logAksi('SAVE_CONFIG', session.username, 'Config disimpan');
        break;
      }
      case 'saveHariH': {
        r = await store.saveHariH(params.hariH || params);
        if (r.ok) await store.logAksi('HARI_H', session.username, r.hariH ? r.hariH.judul + ' / ' + r.hariH.tanggal : 'Hari H dihapus');
        break;
      }
      case 'renameKampung': {
        r = await store.renameKampung(params.oldName, params.newName);
        if (r.ok) await store.logAksi('RENAME_KAMPUNG', session.username, params.oldName + ' → ' + params.newName);
        break;
      }

      /* ============ MANAJEMEN USER (admin only) ============ */
      case 'getUsers': {
        const users = await auth.listUsers();
        r = {
          ok: true,
          data: users.map(u => ({
            id: u.id, username: u.username, nama: u.nama,
            role: u.role, aktif: u.aktif, createdAt: u.createdAt, lastLogin: u.lastLogin
          }))
        };
        break;
      }
      case 'saveUsers': {
        const payload = params.user || {};
        r = await auth.createUser(payload);
        if (r.ok) await store.logAksi('USER_ADD', session.username, payload.username + ' (' + (payload.role || 'user') + ')');
        break;
      }
      case 'resetUserPassword': {
        r = await auth.resetPassword(params.id, params.password);
        if (r.ok) await store.logAksi('USER_RESET_PASS', session.username, String(params.id));
        break;
      }
      case 'updateUser': {
        r = await auth.updateUser(params.id, { nama: params.nama, role: params.role, aktif: params.aktif });
        if (r.ok) await store.logAksi('USER_UPDATE', session.username, String(params.id));
        break;
      }

      /* ============ SEMUA ROLE ============ */
      case 'changeOwnPassword': {
        r = await auth.changeOwnPassword(session, params.oldPassword, params.newPassword);
        if (r.ok) await store.logAksi('GANTI_PASSWORD', session.username, 'Ganti password sendiri');
        break;
      }
      case 'getLogs': {
        r = await store.getLogs(params.limit);
        break;
      }

      default:
        return json(res, 400, { ok: false, message: 'Action tidak dikenal' });
    }
    return json(res, 200, r);
  } catch (err) {
    const msg0 = String(err && err.message ? err.message : '');
    if ((err && err.code === 429) || /quota exceeded|rate.?limit/i.test(msg0)) {
      return json(res, 429, { ok: false, busy: true, message: 'Server sedang sibuk (batas baca Google Sheets tercapai). Tunggu sekitar 1 menit lalu coba lagi.' });
    }
    const status = err && err.status ? err.status : 500;
    return json(res, status, { ok: false, message: 'Error: ' + (err && err.message ? err.message : 'unknown') });
  }
};
