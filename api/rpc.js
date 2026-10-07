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
const roles = require('../lib/roles');

const DOWNLOAD_JENIS = { KTP: 'DOWNLOAD_KTP', KTP_MASSAL: 'DOWNLOAD_KTP_MASSAL', PDF_KAMPUNG: 'DOWNLOAD_PDF', KTP_TTD: 'DOWNLOAD_KTP_TTD' };
const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 200);
const siapa = (nama, id) => (nama ? nama : 'ID ' + id);
const photourl = require('../lib/photourl');
const push = require('../lib/push');

/** NIK tersamar untuk akun peran User: 5203••••••••0005 */
function maskNik(v) {
  const s = String(v == null ? '' : v);
  return s.length >= 10 ? s.slice(0, 4) + '•'.repeat(s.length - 8) + s.slice(-4) : (s ? '•'.repeat(s.length) : s);
}
/**
 * Respons untuk peran User: semua NIK disamarkan & URL foto diganti versi kabur
 * (di SERVER, sehingga NIK lengkap / foto tajam tidak pernah sampai ke perangkat User).
 */
function redactForUser(v) {
  if (Array.isArray(v)) return v.map(redactForUser);
  if (!v || typeof v !== 'object') return v;
  const o = {};
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (k === 'nik' || k === 'NIK') o[k] = maskNik(x);
    else if (k === 'fotoKTP') o[k] = v.fotoKTPId ? photourl.photoUrl(v.fotoKTPId, { blur: true }) : '';
    else if (k === 'fotoTTD') o[k] = v.fotoTTDId ? photourl.photoUrl(v.fotoTTDId, { blur: true }) : '';
    else if (x && typeof x === 'object') o[k] = redactForUser(x);
    else o[k] = x;
  }
  return o;
}

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

  // Peran diambil dari sheet Users (bukan hanya token) → perubahan peran/nonaktif langsung berlaku
  const session = await auth.resolveSession(auth.getSessionFromReq(req));
  if (!session) {
    res.setHeader('Set-Cookie', auth.clearSessionCookie());
    return json(res, 401, { ok: false, message: 'Unauthorized' });
  }

  if (!roles.can(session.role, action)) {
    await store.logAksi('AKSES_DITOLAK', session, 'Coba aksi: ' + action);
    return json(res, 403, {
      ok: false, denied: true, role: session.role,
      message: session.role === 'operator' ? 'Aksi ini khusus Super Admin' : 'Akun Anda hanya bisa melihat data'
    });
  }
  const isSuper = session.role === 'admin';
  const me = { username: session.username, nama: session.nama, role: session.role, jabatan: session.jabatan || '', panggilan: session.panggilan || '' };

  let pushJob = null;                         // notifikasi push dikirim di belakang layar setelah aksi berhasil
  const actorPush = Object.assign({}, session, { peran: roles.ROLE_LABEL[session.role] || '' });
  try {
    let r;
    switch (action) {
      /* ============ READ (semua role terautentikasi) ============ */
      case 'list':
      case 'getList':       r = await store.getList(params); break;
      case 'bootstrap':
      case 'getBootstrap':  r = await store.getBootstrap({ withLogs: isSuper, fresh: !!params.fresh }); r.me = me; break;
      case 'dashboard':
      case 'getDashboard':  r = await store.getDashboard(); break;
      case 'version':
      case 'getVersion': {
        const version = await store.getVersion();
        r = { ok: true, total: Number(String(version).split('|')[0]) || 0, version };
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

      /* ============ WRITE: Operator & Super Admin (sudah di-guard roles.can) ============ */
      case 'add': {
        r = await store.addPendukung(params, session);
        if (r.ok) pushJob = push.notify({ type: 'baru', id: r.id, nama: clip(params.nama, 80), kampung: clip(params.kampung, 60),
          rt: require('../lib/domain').normRT(params.rt) }, actorPush).catch(e => console.warn('[push]', e.message));
        if (r.ok) await store.logAksi('ADD', session, clip(params.nama, 80) + ' / NIK ' + clip(params.nik, 20) + ' / ' + clip(params.kampung, 60) + ' RT ' + require('../lib/domain').normRT(params.rt));
        break;
      }
      case 'verifyWithTTD': {
        const [nm] = await store.namaById(params.id);
        r = await store.verifyWithTTD(params, session);
        if (r.ok) {
          const pv = ((await store.getList({})).data || []).find(x => String(x.id) === String(params.id)) || {};
          pushJob = push.notify({ type: 'pasti', id: params.id, nama: pv.nama || nm, kampung: pv.kampung || '', rt: pv.rt || '' }, actorPush).catch(e => console.warn('[push]', e.message));
        }
        if (r.ok) await store.logAksi('VERIFY_TTD', session, siapa(nm, params.id) + ' → status suara PASTI (' +
          (r.metodeTTD === 'digital' ? 'tanda tangan digital di aplikasi' : 'bukti fotokopi KTP ber-TTD diupload') + ')');
        break;
      }
      case 'unverify': {
        const [nm] = await store.namaById(params.id);
        r = await store.unverifyPendukung(params.id);
        if (r.ok) await store.logAksi('UNVERIFY', session, siapa(nm, params.id) + ' → status suara BELUM PASTI');
        break;
      }
      case 'togglePrint': {
        const [nm] = await store.namaById(params.id);
        r = await store.togglePrint(params.id, params.dicetak);
        if (r.ok) await store.logAksi('TOGGLE_CETAK', session, siapa(nm, params.id) + ' → ' + (r.dicetak ? 'SUDAH' : 'BELUM') + ' dicetak');
        break;
      }
      case 'setPrintBatch': {
        let ids = params.ids;
        if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch (e) { ids = ids.split(','); } }
        const names = (await store.namaById(Array.isArray(ids) ? ids.slice(0, 3) : [])).filter(Boolean);
        r = await store.setPrintBatch(params.ids, params.dicetak);
        if (r.ok) await store.logAksi('CETAK_MASSAL', session, r.count + ' data → ' + (r.dicetak ? 'SUDAH' : 'BELUM') + ' dicetak' +
          (names.length ? ' (' + names.join(', ') + (r.count > names.length ? ', …' : '') + ')' : ''));
        break;
      }
      case 'logDownload': {
        // Download KTP / PDF dibuat di perangkat → perangkat melaporkannya agar tercatat di Log Aktivitas
        const aksi = DOWNLOAD_JENIS[String(params.jenis || '')];
        if (!aksi) { r = { ok: false, message: 'Jenis download tidak dikenal' }; break; }
        await store.logAksi(aksi, session, clip(params.keterangan, 300));
        r = { ok: true };
        break;
      }

      case 'update': {
        // catat APA yang diubah (data sebelum vs sesudah) agar Super Admin bisa memeriksa hasil edit Operator
        const lama = ((await store.getList({})).data || []).find(x => String(x.id) === String(params.id));
        r = await store.updatePendukung(params);
        if (r.ok) {
          const ch = [];
          if (lama) {
            const domain = require('../lib/domain');
            const cmp = [['nama', 'nama'], ['nik', 'NIK'], ['kampung', 'kampung'], ['rt', 'RT'],
              ['tempatLahir', 'tempat lahir'], ['statusPerkawinan', 'status perkawinan']];
            const norm = (k, v) => {
              if (k === 'rt') return domain.normRT(v);
              if (k === 'statusPerkawinan') return domain.normStatusKawin(v) || '';
              return domain.cleanText(v);
            };
            cmp.forEach(([k, lbl]) => {
              if (params[k] == null) return;
              const baru = norm(k, params[k]);
              const old = norm(k, lama[k]);
              if (baru !== old) ch.push(lbl + ' ' + (clip(old, 40) || '(kosong)') + ' → ' + (clip(baru, 40) || '(kosong)'));
            });
          }
          if (params.fotoBase64) ch.push('foto KTP diganti');
          if (params.fotoTTDBase64) ch.push('bukti TTD diganti');
          await store.logAksi('UPDATE', session, clip(params.nama || (lama && lama.nama), 80) + ' / NIK ' + clip(params.nik || (lama && lama.nik), 20) +
            (ch.length ? ' — ' + ch.join(', ') : ' — tanpa perubahan isi'));
        }
        break;
      }

      /* ============ WRITE: khusus Super Admin ============ */
      case 'delete': {
        const [nm] = await store.namaById(params.id);
        r = await store.deletePendukung(params.id);
        if (r.ok) await store.logAksi('DELETE', session, siapa(nm, params.id));
        break;
      }
      case 'saveConfig': {
        r = await store.saveConfig(params.config || params);
        if (r.ok) await store.logAksi('SAVE_CONFIG', session, 'Pengaturan disimpan');
        break;
      }
      case 'saveHariH': {
        r = await store.saveHariH(params.hariH || params);
        if (r.ok) await store.logAksi('HARI_H', session, r.hariH ? r.hariH.judul + ' / ' + r.hariH.tanggal : 'Hari H dihapus');
        break;
      }
      case 'renameKampung': {
        r = await store.renameKampung(params.oldName, params.newName);
        if (r.ok) await store.logAksi('RENAME_KAMPUNG', session, params.oldName + ' → ' + params.newName);
        break;
      }

      /* ============ MANAJEMEN USER (Super Admin) ============ */
      case 'getUsers': {
        const [users, pushCount] = await Promise.all([auth.listUsers(), push.countByUser()]);
        r = {
          ok: true,
          data: users.map(u => ({
            id: u.id, username: u.username, nama: u.nama,
            role: u.role, aktif: u.aktif, createdAt: u.createdAt, lastLogin: u.lastLogin, jabatan: u.jabatan, panggilan: u.panggilan,
            notifPerangkat: pushCount[u.username.toLowerCase()] || 0
          }))
        };
        break;
      }
      case 'saveUsers': {
        const payload = params.user || {};
        r = await auth.createUser(payload);
        if (r.ok) await store.logAksi('USER_ADD', session, clip(payload.nama || payload.username, 60) + ' (@' + clip(payload.username, 30) + ') sebagai ' + roles.ROLE_LABEL[roles.normRole(payload.role)]);
        break;
      }
      case 'resetUserPassword': {
        const target = (await auth.listUsers(false)).find(u => u.id === String(params.id));
        r = await auth.resetPassword(params.id, params.password);
        if (r.ok) await store.logAksi('USER_RESET_PASS', session, target ? target.nama + ' (@' + target.username + ')' : String(params.id));
        break;
      }
      case 'updateUser': {
        const before = (await auth.listUsers(true)).find(u => u.id === String(params.id));
        r = await auth.updateUser(params.id, { nama: params.nama, role: params.role, aktif: params.aktif, jabatan: params.jabatan, panggilan: params.panggilan });
        if (r.ok) {
          const ch = [];
          if (before) {
            if (params.nama != null && String(params.nama).trim() !== before.nama) ch.push('nama → ' + clip(params.nama, 60));
            if (params.role != null && roles.normRole(params.role) !== before.role) ch.push('peran ' + roles.ROLE_LABEL[before.role] + ' → ' + roles.ROLE_LABEL[roles.normRole(params.role)]);
            if (params.aktif != null && !!params.aktif !== before.aktif) ch.push(params.aktif ? 'diaktifkan' : 'dinonaktifkan');
            const JAB = { '': 'Umum', timses: 'Tim Sukses', cakades: 'Calon Kades' };
            if (params.jabatan != null && auth.normJabatan(params.jabatan) !== before.jabatan) ch.push('jabatan ' + JAB[before.jabatan] + ' → ' + JAB[auth.normJabatan(params.jabatan)]);
            if (params.panggilan != null && auth.normPanggilan(params.panggilan) !== before.panggilan) ch.push('panggilan → ' + (auth.normPanggilan(params.panggilan) || 'tanpa'));
          }
          await store.logAksi('USER_UPDATE', session, (before ? before.nama + ' (@' + before.username + ')' : String(params.id)) + (ch.length ? ': ' + ch.join(', ') : ''));
        }
        break;
      }

      /* ============ NOTIFIKASI PUSH (semua peran) ============ */
      case 'pushKey':         r = { ok: true, publicKey: await push.publicKey(), tenang: push.isQuiet() }; break;
      case 'pushSubscribe':   r = await push.subscribe(session, params.subscription, params.perangkat); break;
      case 'pushUnsubscribe': r = await push.unsubscribe(params.endpoint); break;
      case 'pushStatus':      r = await push.status(session, params.endpoint); break;

      /* ============ SEMUA ROLE ============ */
      case 'changeOwnPassword': {
        r = await auth.changeOwnPassword(session, params.oldPassword, params.newPassword);
        if (r.ok) await store.logAksi('GANTI_PASSWORD', session, 'Ganti password sendiri');
        break;
      }
      case 'getLogs': {
        r = await store.getLogs(params.limit);
        break;
      }

      default:
        return json(res, 400, { ok: false, message: 'Action tidak dikenal' });
    }
    if (session.role === 'user' && r && typeof r === 'object') r = redactForUser(r);
    if (pushJob) await push.later(pushJob);
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
