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
const domain = require('../lib/domain');
const notif = require('../lib/notif');
const push = require('../lib/push');
const reminder = require('../lib/reminder');
const prefs = require('../lib/prefs');

const WRITE_ACTIONS = new Set([
  'add', 'update', 'delete', 'verifyWithTTD', 'unverify',
  'togglePrint', 'setPrintBatch', 'saveConfig', 'renameKampung',
  'saveUsers', 'resetUserPassword', 'updateUser',
  'saveAgenda', 'deleteAgenda', 'saveReminderSettings', 'reminderTest', 'runReminders'
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

const rtText = rt => (String(rt) === 'UMUM' ? 'UMUM' : 'RT ' + rt);
const safe = async fn => { try { return await fn(); } catch (e) { return null; } };

/** Ringkas daftar nama untuk teks notifikasi: "A, B, C dan 2 lainnya" */
function ringkasNama(list) {
  const names = list.map(x => x.nama).filter(Boolean);
  if (!names.length) return '';
  const head = names.slice(0, 3).join(', ');
  return names.length > 3 ? head + ' dan ' + (names.length - 3) + ' lainnya' : head;
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
  const action = String(params.action || '')
    .replace(/^api/, '')
    .replace(/^./, c => c.toLowerCase());
  if (!action) return json(res, 400, { ok: false, message: 'Action tidak ada' });

  const session = auth.getSessionFromReq(req);
  if (!session) return json(res, 401, { ok: false, message: 'Unauthorized' });

  const actor = session.username;
  const actorName = session.nama || session.username;

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
        if (r.ok) {
          await store.logAksi('ADD', session.username, params.nama + ' / ' + params.nik + ' / RT ' + (params.rt || ''));
          await notif.notify({
            type: 'data_baru', title: 'Data baru ditambahkan',
            message: String(params.nama || '').trim() + ' ditambahkan di Kampung ' + String(params.kampung || '').trim() + ' (' + rtText(domain.normRT(params.rt)) + ') oleh ' + actorName + '.',
            actor, audience: 'all', dataId: r.id, kampung: params.kampung
          });
        }
        break;
      }
      case 'update': {
        const before = await safe(() => store.getBrief(params.id));
        r = await store.updatePendukung(params);
        if (r.ok) {
          await store.logAksi('UPDATE', session.username, params.id + ' / ' + params.nama);
          const nama = String(params.nama || (before && before.nama) || '').trim();
          const kampung = String(params.kampung || (before && before.kampung) || '').trim();
          await notif.notify({
            type: 'data_ubah', title: 'Data diperbarui',
            message: 'Data ' + nama + (kampung ? ' (Kampung ' + kampung + ')' : '') + ' diperbarui oleh ' + actorName + '.',
            actor, audience: 'all', dataId: String(params.id), kampung
          });
        }
        break;
      }
      case 'delete': {
        const before = await safe(() => store.getBrief(params.id));
        r = await store.deletePendukung(params.id);
        if (r.ok) {
          await store.logAksi('DELETE', session.username, String(params.id));
          await notif.notify({
            type: 'data_hapus', title: 'Data dihapus',
            message: (before ? before.nama + ' (Kampung ' + before.kampung + ')' : 'Sebuah data') + ' dihapus oleh ' + actorName + '.',
            actor, audience: 'all', kampung: before ? before.kampung : ''
          });
        }
        break;
      }
      case 'verifyWithTTD': {
        const before = await safe(() => store.getBrief(params.id));
        r = await store.verifyWithTTD(params);
        if (r.ok) {
          await store.logAksi('VERIFY_TTD', session.username, params.id + ' — bukti TTD diupload');
          // before.verified = sudah PASTI sebelumnya (upload ulang bukti) → jumlah tidak bertambah
          const pasti = before ? before.verifiedCount + (before.verified ? 0 : 1) : null;
          await notif.notify({
            type: 'verifikasi',
            title: before && before.verified ? 'Bukti TTD diperbarui' : 'Suara PASTI bertambah! ✅',
            message: (before ? before.nama + ' di Kampung ' + before.kampung : 'Sebuah data') +
              (before && before.verified ? ' — bukti TTD diperbarui' : ' berubah dari belum pasti menjadi PASTI (bukti TTD diunggah)') +
              ' oleh ' + actorName + '.' +
              (pasti != null ? ' Total suara PASTI: ' + pasti + ' dari ' + before.totalCount + ' pendukung.' : ''),
            actor, audience: 'all', dataId: String(params.id), kampung: before ? before.kampung : ''
          });
        }
        break;
      }

      case 'unverify': {
        const before = await safe(() => store.getBrief(params.id));
        r = await store.unverifyPendukung(params.id);
        if (r.ok) {
          await store.logAksi('UNVERIFY', session.username, String(params.id));
          const pasti = before ? Math.max(0, before.verifiedCount - (before.verified ? 1 : 0)) : null;
          await notif.notify({
            type: 'batal_verifikasi', title: 'Verifikasi dibatalkan',
            message: 'Status ' + (before ? before.nama + ' (Kampung ' + before.kampung + ')' : 'sebuah data') + ' dikembalikan ke belum pasti oleh ' + actorName + '.' +
              (pasti != null ? ' Total suara PASTI: ' + pasti + ' dari ' + before.totalCount + ' pendukung.' : ''),
            actor, audience: 'all', dataId: String(params.id), kampung: before ? before.kampung : ''
          });
        }
        break;
      }
      case 'togglePrint': {
        const before = await safe(() => store.getBrief(params.id));
        r = await store.togglePrint(params.id, params.dicetak);
        if (r.ok) {
          await store.logAksi('TOGGLE_CETAK', session.username, String(params.id) + ' → ' + (r.dicetak ? 'SUDAH' : 'BELUM'));
          await notif.notify({
            type: 'cetak', title: r.dicetak ? 'KTP sudah dicetak' : 'Status cetak dibatalkan',
            message: (before ? before.nama + ' (Kampung ' + before.kampung + ')' : 'Sebuah data') + ' ditandai ' + (r.dicetak ? 'sudah' : 'belum') + ' dicetak oleh ' + actorName + '.',
            actor, audience: 'all', dataId: String(params.id), kampung: before ? before.kampung : ''
          });
        }
        break;
      }
      case 'setPrintBatch': {
        r = await store.setPrintBatch(params.ids, params.dicetak);
        if (r.ok) {
          await store.logAksi('CETAK_MASSAL', session.username, r.count + ' data → ' + (r.dicetak ? 'SUDAH' : 'BELUM'));
          let ids = params.ids;
          if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch (e) { ids = ids.split(','); } }
          const briefs = (await safe(() => store.getBriefs(ids))) || [];
          const ringkas = ringkasNama(briefs);
          await notif.notify({
            type: 'cetak_massal', title: r.dicetak ? r.count + ' KTP sudah dicetak' : r.count + ' data ditandai belum dicetak',
            message: (ringkas ? ringkas + ' ' : r.count + ' data ') + 'ditandai ' + (r.dicetak ? 'sudah' : 'belum') + ' dicetak oleh ' + actorName + '.',
            actor, audience: 'all'
          });
        }
        break;
      }
      case 'saveConfig': {
        r = await store.saveConfig(params.config);
        if (r.ok) {
          await store.logAksi('SAVE_CONFIG', session.username, 'Config disimpan');
          await notif.notify({
            type: 'pengaturan', title: 'Pengaturan diperbarui',
            message: 'Target suara / daftar kampung diperbarui oleh ' + actorName + '.',
            actor, audience: 'all'
          });
        }
        break;
      }
      case 'renameKampung': {
        r = await store.renameKampung(params.oldName, params.newName);
        if (r.ok) {
          await store.logAksi('RENAME_KAMPUNG', session.username, params.oldName + ' → ' + params.newName);
          await notif.notify({
            type: 'kampung', title: 'Nama kampung diubah',
            message: 'Kampung ' + params.oldName + ' diubah menjadi ' + params.newName + ' oleh ' + actorName + '.',
            actor, audience: 'all', kampung: params.newName
          });
        }
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
        if (r.ok) {
          await store.logAksi('USER_ADD', session.username, payload.username + ' (' + (payload.role || 'user') + ')');
          await notif.notify({
            type: 'user_baru', title: 'User baru ditambahkan',
            message: 'Akun ' + payload.username + ' (' + (payload.role === 'admin' ? 'admin' : 'user') + ') dibuat oleh ' + actorName + '.',
            actor, audience: 'admin'
          });
        }
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

      /* ============ AGENDA & PENGINGAT ============ */
      case 'getAgenda':      r = await reminder.getPayload(session); break;
      case 'saveAgenda': {
        r = await reminder.saveAgenda(session, params.agenda || params);
        if (r.ok) {
          const a = r.agenda;
          await store.logAksi(r.isNew ? 'AGENDA_ADD' : 'AGENDA_UPDATE', session.username, a.judul + ' / ' + a.tanggal);
          const days = reminder.diffDays(a.tanggal, reminder.tzNow(undefined, await prefs.getDefaultZone()).date);
          const detail = await reminder.describe(a);
          const sisa = days > 0 ? ' (' + days + ' hari lagi)' : (days === 0 ? ' (hari ini)' : '');
          await notif.notify(a.jenis === 'pemilihan' ? {
            type: 'agenda', title: r.isNew ? '🗳️ Hari pemilihan ditetapkan' : '🗳️ Jadwal pemilihan diperbarui',
            message: a.judul + ': ' + detail + sisa + '. Ditetapkan oleh ' + actorName + '.',
            actor, audience: 'all'
          } : {
            type: 'agenda', title: (r.isNew ? 'Agenda baru: ' : 'Agenda diperbarui: ') + a.judul,
            message: detail + sisa + '. Oleh ' + actorName + '.',
            actor, audience: 'all'
          });
        }
        break;
      }
      case 'deleteAgenda': {
        r = await reminder.deleteAgenda(params.id);
        if (r.ok) {
          await store.logAksi('AGENDA_DELETE', session.username, r.agenda.judul + ' / ' + r.agenda.tanggal);
          await notif.notify({
            type: 'agenda', title: 'Agenda dibatalkan: ' + r.agenda.judul,
            message: 'Agenda ' + reminder.tanggalPanjang(r.agenda.tanggal) + ' dihapus oleh ' + actorName + '.',
            actor, audience: 'all'
          });
        }
        break;
      }
      case 'saveReminderSettings': {
        r = await reminder.saveSettings(params.settings || params);
        if (r.ok) await store.logAksi('REMINDER_SETTINGS', session.username, 'Jam ' + r.settings.time + (r.settings.enabled ? ' aktif' : ' nonaktif'));
        break;
      }
      case 'getTimezone': r = Object.assign({ ok: true }, await prefs.syncUser(session.username, params.offsetMin), { zones: prefs.ZONES }); break;
      case 'saveTimezone': r = await prefs.saveUser(session.username, params.mode, params.zone, params.offsetMin); break;
      case 'reminderTest':   r = await reminder.sendTest(session); break;
      case 'runReminders': {
        const res = await reminder.run({ force: true });
        r = { ok: true, count: res.sent.length, message: res.sent.length ? res.sent.length + ' pengingat dikirim ke semua user' : 'Pengingat hari ini sudah terkirim sebelumnya (atau belum ada agenda)' };
        break;
      }

      /* ============ NOTIFIKASI & PUSH (semua role) ============ */
      case 'notifList':
        await reminder.maybeRun(); // pemicu pengingat harian (aman dobel)
        r = await notif.list(session, params); break;
      case 'notifMarkRead':  r = await notif.markRead(session); break;
      case 'pushConfig':     r = { ok: true, enabled: push.isConfigured(), publicKey: push.getPublicKey() }; break;
      case 'pushSubscribe':  r = await push.subscribe(session, params.subscription, req.headers['user-agent']); break;
      case 'pushUnsubscribe': r = await push.unsubscribe(params.endpoint); break;
      case 'pushTest': {
        if (!push.isConfigured()) { r = { ok: false, message: 'Push belum diaktifkan di server (VAPID belum diisi)' }; break; }
        const res2 = await push.send(
          { title: 'Tes notifikasi', body: 'Halo ' + actorName + ', notifikasi push berfungsi 🎉', tag: 'tes', url: '/?nav=notif' },
          { onlyUsername: session.username }
        );
        r = res2.sent > 0
          ? { ok: true, message: 'Notifikasi tes dikirim ke ' + res2.sent + ' perangkat' }
          : { ok: false, message: 'Belum ada perangkat yang berlangganan untuk akun ini' };
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
