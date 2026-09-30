'use strict';
/* ============================================================
 * Agenda & pengingat — jadwal hari pemilihan (Hari H), kunjungan,
 * rapat, dll. + notifikasi pengingat otomatis:
 *   • Hitung mundur harian menuju Hari H (pagi, jam bisa diatur)
 *   • Pengingat agenda lain: H-1 dan hari-H agenda
 *
 * Pengingat dipicu dari 3 jalur (aman dobel, ada penanda ReminderLog):
 *   1) /api/cron  (Vercel Cron harian + GitHub Actions berkala)
 *   2) "lazy trigger" saat ada user yang membuka aplikasi (notifList)
 *   3) tombol "Kirim pengingat sekarang" di Pengaturan (admin)
 * ============================================================ */
const crypto = require('crypto');
const sheets = require('./gsheets');
const notif = require('./notif');
const push = require('./push');
const prefs = require('./prefs');

const JENIS = ['pemilihan', 'kunjungan', 'rapat', 'lainnya'];
const DEFAULTS = { enabled: true, time: '06:00', countdown: true, agendaReminders: true, zone: prefs.FALLBACK_ZONE };

const untxt = v => String(v == null ? '' : v).replace(/^'+/, '').trim();
const txt = v => "'" + String(v == null ? '' : v); // paksa teks di Sheets (apostrof hilang otomatis)

/* ---------------- waktu (zona WIB) ---------------- */

function tzNow(date, zone) {
  const d = date || new Date();
  const parts = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: prefs.isZone(zone) ? zone : prefs.FALLBACK_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d).forEach(p => { parts[p.type] = p.value; });
  const hh = parts.hour === '24' ? '00' : parts.hour;
  return { date: parts.year + '-' + parts.month + '-' + parts.day, time: hh + ':' + parts.minute };
}

const dayNum = ymd => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN; };
const diffDays = (ymd, todayYmd) => Math.round(dayNum(ymd) - dayNum(todayYmd));
const validYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(dayNum(s)) && new Date(dayNum(s) * 86400000).toISOString().slice(0, 10) === s;
const validHm = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function tanggalPanjang(ymd) {
  if (!validYmd(ymd)) return String(ymd || '');
  return new Date(dayNum(ymd) * 86400000).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/* ---------------- pengaturan (sheet Config) ---------------- */

const CFG_KEYS = { enabled: 'reminder_enabled', time: 'reminder_time', countdown: 'reminder_countdown', agendaReminders: 'reminder_agenda', zone: 'reminder_zone' };

async function readSettings() {
  const rows = await sheets.readSheet(sheets.SHEET_CONFIG);
  const map = {};
  for (let i = 1; i < rows.length; i++) map[String(rows[i][0] || '').trim()] = rows[i][1];
  const bool = (k, def) => (map[k] === undefined || map[k] === '' ? def : String(map[k]).trim().toLowerCase() !== 'false');
  const time = untxt(map[CFG_KEYS.time]);
  return {
    enabled: bool(CFG_KEYS.enabled, DEFAULTS.enabled),
    time: validHm(time) ? time : DEFAULTS.time,
    countdown: bool(CFG_KEYS.countdown, DEFAULTS.countdown),
    agendaReminders: bool(CFG_KEYS.agendaReminders, DEFAULTS.agendaReminders),
    zone: prefs.isZone(untxt(map[CFG_KEYS.zone])) ? untxt(map[CFG_KEYS.zone]) : DEFAULTS.zone
  };
}

async function writeConfigKey(key, value) {
  const rows = await sheets.readSheet(sheets.SHEET_CONFIG);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() === key) { await sheets.updateCells(sheets.SHEET_CONFIG, i + 1, 2, [value]); return; }
  }
  await sheets.appendRow(sheets.SHEET_CONFIG, [key, value]);
}

async function saveSettings(input) {
  input = input || {};
  const time = String(input.time || '').trim();
  if (!validHm(time)) return { ok: false, message: 'Jam pengingat tidak valid (format HH:MM)' };
  await writeConfigKey(CFG_KEYS.enabled, input.enabled === false || input.enabled === 'false' ? 'false' : 'true');
  await writeConfigKey(CFG_KEYS.time, txt(time));
  await writeConfigKey(CFG_KEYS.countdown, input.countdown === false || input.countdown === 'false' ? 'false' : 'true');
  await writeConfigKey(CFG_KEYS.agendaReminders, input.agendaReminders === false || input.agendaReminders === 'false' ? 'false' : 'true');
  if (input.zone !== undefined && input.zone !== '') {
    if (!prefs.isZone(input.zone)) return { ok: false, message: 'Zona waktu tidak valid' };
    await writeConfigKey(CFG_KEYS.zone, txt(input.zone));
    prefs.invalidate();
  }
  return { ok: true, settings: await readSettings() };
}

/* ---------------- agenda (sheet Agenda) ---------------- */

function rowToAgenda(r, rowNum) {
  const id = String(r[0] || '').trim();
  if (!id) return null;
  return {
    rowNum, id,
    judul: String(r[1] || ''),
    jenis: JENIS.indexOf(String(r[2] || '')) !== -1 ? String(r[2]) : 'lainnya',
    tanggal: untxt(r[3]),
    jam: untxt(r[4]),
    lokasi: String(r[5] || ''),
    catatan: String(r[6] || ''),
    dibuatOleh: String(r[7] || ''),
    dibuatPada: String(r[8] || '')
  };
}

async function listAgenda() {
  const rows = await sheets.readSheet(sheets.SHEET_AGENDA);
  const out = [];
  for (let i = 1; i < rows.length; i++) { const a = rowToAgenda(rows[i], i + 1); if (a && validYmd(a.tanggal)) out.push(a); }
  out.sort((a, b) => (a.tanggal + (a.jam || '99:99')).localeCompare(b.tanggal + (b.jam || '99:99')));
  return out;
}

function cleanAgenda(input) {
  const a = {
    id: String(input.id || '').trim(),
    judul: String(input.judul || '').trim().slice(0, 120),
    jenis: String(input.jenis || 'lainnya').trim(),
    tanggal: String(input.tanggal || '').trim(),
    jam: String(input.jam || '').trim(),
    lokasi: String(input.lokasi || '').trim().slice(0, 120),
    catatan: String(input.catatan || '').trim().slice(0, 300)
  };
  if (!a.judul) return { error: 'Judul agenda wajib diisi' };
  if (JENIS.indexOf(a.jenis) === -1) return { error: 'Jenis agenda tidak valid' };
  if (!validYmd(a.tanggal)) return { error: 'Tanggal tidak valid' };
  if (a.jam && !validHm(a.jam)) return { error: 'Jam tidak valid (format HH:MM)' };
  return { a };
}

/** Teks ringkas agenda; jam diberi label zona acuan (mis. "08:00 WITA"). */
const detailAgenda = (a, refZone) => tanggalPanjang(a.tanggal) + (a.jam ? ' pukul ' + a.jam + ' ' + prefs.zoneLabel(refZone) : '') + (a.lokasi ? ' di ' + a.lokasi : '');

async function saveAgenda(session, input) {
  const { a, error } = cleanAgenda(input || {});
  if (error) return { ok: false, message: error };
  const rows = await sheets.readSheet(sheets.SHEET_AGENDA);
  let rowNum = 0, old = null;
  if (a.id) {
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0] || '').trim() === a.id) { rowNum = i + 1; old = rowToAgenda(rows[i], rowNum); break; }
    }
    if (!rowNum) return { ok: false, message: 'Agenda tidak ditemukan' };
  }
  const id = a.id || 'A' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const row = [id, a.judul, a.jenis, txt(a.tanggal), a.jam ? txt(a.jam) : '', a.lokasi, a.catatan,
    old ? old.dibuatOleh : session.username, old ? old.dibuatPada : new Date().toISOString()];
  if (rowNum) await sheets.updateRow(sheets.SHEET_AGENDA, rowNum, row);
  else await sheets.appendRow(sheets.SHEET_AGENDA, row);
  return { ok: true, isNew: !rowNum, agenda: { ...a, id } };
}

async function deleteAgenda(id) {
  const rows = await sheets.readSheet(sheets.SHEET_AGENDA);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() === String(id || '').trim()) {
      const a = rowToAgenda(rows[i], i + 1);
      await sheets.deleteRow(sheets.SHEET_AGENDA, i + 1);
      return { ok: true, agenda: a };
    }
  }
  return { ok: false, message: 'Agenda tidak ditemukan' };
}

/** Teks agenda memakai zona acuan saat ini (untuk isi notifikasi). */
async function describe(a) { return detailAgenda(a, (await readSettings()).zone); }

/** Agenda pemilihan terdekat yang belum lewat (atau baru lewat kemarin → ucapan terima kasih). */
function nextElection(list, today) {
  const el = list.filter(a => a.jenis === 'pemilihan' && diffDays(a.tanggal, today) >= -1);
  el.sort((x, y) => x.tanggal.localeCompare(y.tanggal));
  return el[0] || null;
}

/* ---------------- kata-kata penyemangat ---------------- */

const pick = (arr, n) => arr[Math.abs(n) % arr.length];

/**
 * Susun pesan hitung mundur.  stats (opsional): { total, verified, target }
 * candidate: nama kandidat (opsional)
 */
function buildCountdown(days, agenda, stats, candidate) {
  const tgl = tanggalPanjang(agenda.tanggal);
  const nama = agenda.judul || 'Hari Pemilihan';
  const cand = candidate ? ' ' + candidate : '';
  let title, msg;
  if (days < 0) {
    title = '🙏 Terima kasih, Tim Pendukung!';
    msg = 'Pemilihan telah dilaksanakan. Terima kasih atas kerja keras, doa, dan semangat seluruh tim' + cand + '. Apa pun hasilnya, kebersamaan ini sangat berarti.';
  } else if (days === 0) {
    title = '🗳️ Hari H telah tiba!';
    msg = pick([
      'Hari ini ' + nama + '! Bismillah — ajak keluarga & tetangga datang ke TPS dan gunakan hak pilihnya. Semangat' + cand + '!',
      'Inilah harinya! Pastikan semua pendukung sudah berangkat ke TPS. Terima kasih atas perjuangan selama ini. 💪'
    ], 0);
  } else if (days === 1) {
    title = '🌙 Besok Hari H!';
    msg = 'Besok ' + nama + ' (' + tgl + '). Istirahat yang cukup, pastikan logistik siap, dan ingatkan semua pendukung untuk datang ke TPS.';
  } else if (days <= 7) {
    title = '🔥 H-' + days + ' menuju ' + nama;
    msg = pick([
      'Tinggal ' + days + ' hari lagi! Saatnya merapatkan barisan — pastikan semua pendukung tahu waktu & lokasi TPS-nya.',
      'H-' + days + '! Fokus ke pendukung yang masih belum pasti. Satu kunjungan hari ini bisa menambah satu suara.',
      'Sebentar lagi! ' + days + ' hari menuju ' + nama + '. Jaga kekompakan dan semangat tim. 🤝'
    ], days);
  } else if (days <= 30) {
    title = '⏳ ' + days + ' hari lagi menuju ' + nama;
    msg = pick([
      'Waktu terus berjalan — ' + days + ' hari lagi. Yuk percepat verifikasi suara dan kunjungi warga di tiap kampung.',
      'Perjalanan hampir separuh jalan lebih. Tetap semangat, tetap santun, tetap konsisten! 🌱',
      'Setiap hari berarti. Hari ini, sapa satu keluarga lagi dan pastikan suaranya PASTI.'
    ], days);
  } else {
    title = '🗓️ ' + days + ' hari menuju ' + nama;
    msg = pick([
      'Masih ' + days + ' hari. Waktu yang cukup untuk membangun kepercayaan warga — mulai dari hal kecil, konsisten tiap hari.',
      'Semangat pagi, Tim Pendukung! ' + days + ' hari lagi menuju ' + nama + '. Mari kerja cerdas dan ikhlas. ☀️'
    ], days);
  }
  if (days >= 0 && stats && stats.total != null) {
    const belum = Math.max(0, (stats.total || 0) - (stats.verified || 0));
    msg += ' Saat ini: ' + (stats.verified || 0) + ' suara PASTI dari ' + (stats.total || 0) + ' pendukung' +
      (stats.target ? ' (target ' + stats.target + ')' : '') + (belum ? ', masih ' + belum + ' belum pasti.' : '.');
  }
  return { title, message: msg };
}

/** Ringkasan untuk banner dashboard (murah, tanpa statistik). */
function countdownInfo(list, today, candidate) {
  const e = nextElection(list, today);
  if (!e) return null;
  const days = diffDays(e.tanggal, today);
  const c = buildCountdown(days, e, null, candidate);
  return { days, id: e.id, judul: e.judul, tanggal: e.tanggal, jam: e.jam, lokasi: e.lokasi, tanggalPanjang: tanggalPanjang(e.tanggal), message: c.message };
}

/* ---------------- penanda anti-dobel ---------------- */

/** Klaim kunci; true jika kita yang pertama (aman dipanggil bersamaan). */
async function claim(key) {
  const token = crypto.randomBytes(6).toString('hex');
  const k = untxt(key);
  let rows = await sheets.readSheet(sheets.SHEET_REMINDER_LOG);
  for (let i = 1; i < rows.length; i++) if (untxt(rows[i][0]) === k) return false;
  await sheets.appendRow(sheets.SHEET_REMINDER_LOG, [txt(k), new Date().toISOString(), token]);
  rows = await sheets.readSheet(sheets.SHEET_REMINDER_LOG);
  for (let i = 1; i < rows.length; i++) if (untxt(rows[i][0]) === k) return String(rows[i][2] || '') === token;
  return false;
}

/* ---------------- mesin pengingat ---------------- */

async function loadStats() {
  try {
    const store = require('./store');
    const d = await store.getDashboard();
    const x = d && d.data;
    return x ? { total: x.total, verified: x.verified, target: x.target } : null;
  } catch (e) { return null; }
}

async function candidateName() {
  try { const store = require('./store'); const cfg = await store.readConfig(); return cfg.namaKandidat || ''; } catch (e) { return ''; }
}

/**
 * Jalankan pengingat yang jatuh tempo hari ini.
 * opts.force: abaikan jam (untuk tombol admin), tetap anti-dobel.
 */
async function zonesInUse(settings) {
  try {
    const auth = require('./auth');
    const [users, st] = await Promise.all([auth.listUsers(), prefs.load()]);
    const set = new Set();
    users.filter(u => u.aktif).forEach(u => { const p = st.map[u.username.toLowerCase()]; set.add(p ? p.zone : st.defaultZone); });
    if (set.size) return Array.from(set);
  } catch (e) { /* jatuh ke zona default */ }
  return [settings.zone];
}

async function run(opts) {
  opts = opts || {};
  const settings = await readSettings();
  if (!settings.enabled && !opts.force) return { ok: true, skipped: 'Pengingat dinonaktifkan', sent: [] };

  const list = await listAgenda();
  const zones = await zonesInUse(settings);
  const sent = [];
  let earliest = null;

  for (const zone of zones) {
    const now = tzNow(opts.now, zone);
    const lbl = prefs.zoneLabel(zone);
    // jam pengingat = waktu setempat masing-masing zona user
    if (!opts.force && now.time < settings.time) { earliest = earliest || ('Belum waktunya (' + settings.time + ' ' + lbl + ')'); continue; }

    if (settings.countdown) {
      const e = nextElection(list, now.date);
      if (e) {
        const days = diffDays(e.tanggal, now.date);
        if (await claim('countdown:' + zone + ':' + now.date)) {
          const [stats, cand] = await Promise.all([loadStats(), candidateName()]);
          const c = buildCountdown(days, e, stats, cand);
          await notif.notify({ type: 'countdown', title: c.title, message: c.message, actor: '', audience: 'all', zone });
          sent.push('countdown:' + lbl + ':' + now.date);
        }
      }
    }

    if (settings.agendaReminders) {
      for (const a of list) {
        if (a.jenis === 'pemilihan') continue; // sudah ditangani hitung mundur
        const d = diffDays(a.tanggal, now.date);
        if (d !== 0 && d !== 1) continue;
        const key = 'agenda:' + a.id + ':' + (d === 0 ? 'H' : 'H-1') + ':' + a.tanggal + ':' + zone;
        if (!(await claim(key))) continue;
        await notif.notify({
          type: 'agenda_pengingat',
          title: (d === 0 ? '📌 Hari ini: ' : '🔔 Besok: ') + a.judul,
          message: detailAgenda(a, settings.zone) + '.' + (a.catatan ? ' Catatan: ' + a.catatan : ''),
          actor: '', audience: 'all', zone
        });
        sent.push(key);
      }
    }
  }
  if (!sent.length && earliest) return { ok: true, skipped: earliest, sent: [] };
  return { ok: true, sent, zones: zones.map(prefs.zoneLabel) };
}

/** Dipanggil dari endpoint yang sering diakses; dibatasi 1x per 5 menit per instance. */
let lastLazy = 0;
async function maybeRun() {
  const t = Date.now();
  if (t - lastLazy < 5 * 60 * 1000) return null;
  lastLazy = t;
  try { return await run(); } catch (e) { console.error('[reminder] lazy run gagal:', e && e.message); return null; }
}

/** Payload untuk halaman: daftar agenda + hitung mundur + pengaturan (menurut zona waktu user). */
async function getPayload(session) {
  const [list, settings, cand, uz] = await Promise.all([listAgenda(), readSettings(), candidateName(), prefs.userZone(session.username)]);
  const today = tzNow(undefined, uz).date;
  return {
    ok: true,
    today,
    data: list.map(a => ({ id: a.id, judul: a.judul, jenis: a.jenis, tanggal: a.tanggal, jam: a.jam, lokasi: a.lokasi, catatan: a.catatan, days: diffDays(a.tanggal, today) })),
    countdown: countdownInfo(list, today, cand),
    settings: session.role === 'admin' ? settings : { enabled: settings.enabled },
    pushEnabled: push.isConfigured(),
    refZone: settings.zone,
    userZone: uz,
    zones: prefs.ZONES
  };
}

/** Uji: kirim contoh pengingat hari ini ke diri sendiri (push saja, tidak disimpan). */
async function sendTest(session) {
  const today = tzNow(undefined, await prefs.userZone(session.username)).date;
  const list = await listAgenda();
  const e = nextElection(list, today);
  const [stats, cand] = await Promise.all([loadStats(), candidateName()]);
  const sample = e
    ? buildCountdown(diffDays(e.tanggal, today), e, stats, cand)
    : { title: '🗓️ Contoh pengingat', message: 'Belum ada agenda Hari Pemilihan. Tambahkan agenda bertipe "Hari Pemilihan" agar hitung mundur harian aktif.' };
  let pushed = 0;
  if (push.isConfigured()) {
    const r = await push.send({ title: sample.title, body: sample.message, tag: 'tes-pengingat', url: '/' }, { onlyUsername: session.username });
    pushed = r.sent || 0;
  }
  return { ok: true, title: sample.title, message: sample.message, pushed };
}

module.exports = {
  JENIS, tzNow, diffDays, tanggalPanjang, detailAgenda,
  readSettings, saveSettings, listAgenda, saveAgenda, deleteAgenda, describe,
  buildCountdown, countdownInfo, run, maybeRun, getPayload, sendTest, nextElection
};
