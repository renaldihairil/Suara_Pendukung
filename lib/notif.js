'use strict';
/* ============================================================
 * Notifikasi — riwayat di sheet Notifikasi + status baca per user
 * (sheet NotifState) + Web Push ke perangkat yang berlangganan.
 *
 * Audience: 'all'   → semua user (kecuali pelaku aksi)
 *           'admin' → hanya admin
 * Status "belum dibaca" = notifikasi lebih baru dari LastReadAt user.
 * ============================================================ */
const crypto = require('crypto');
const sheets = require('./gsheets');
const untxt = v => String(v == null ? '' : v).replace(/^'+/, '').trim();
const push = require('./push');
const prefs = require('./prefs');

const MAX_LIST = 100;
const CACHE_MS = 20000;   // daftar notifikasi di-cache per instance (hemat kuota baca Sheets)
const READ_TTL_MS = 60000;
let inflightAll = null;

let ensured = null;
let cache = { at: 0, items: null };
const readCache = {}; // username(lower) → { v: ISO LastReadAt, at }

/** Pastikan sheet notifikasi ada (sekali per instance). Aman untuk spreadsheet lama. */
function ensure() {
  if (!ensured) ensured = sheets.ensureSheets().catch(e => { ensured = null; throw e; });
  return ensured;
}

function rowToNotif(r) {
  const id = String(r[0] || '').trim();
  if (!id) return null;
  return {
    id,
    timestamp: r[1] instanceof Date ? r[1].toISOString() : String(r[1] || ''),
    type: String(r[2] || ''),
    title: String(r[3] || ''),
    message: String(r[4] || ''),
    actor: String(r[5] || ''),
    audience: String(r[6] || 'all') === 'admin' ? 'admin' : 'all',
    dataId: String(r[7] || ''),
    kampung: String(r[8] || ''),
    zone: untxt(r[9])            // '' = semua zona; selain itu hanya user di zona tsb
  };
}

async function readAll() {
  const now = Date.now();
  if (cache.items && now - cache.at < CACHE_MS) return cache.items;
  if (inflightAll) return inflightAll;
  inflightAll = (async () => {
    await ensure();
    const rows = await sheets.readSheet(sheets.SHEET_NOTIF);
    const items = [];
    for (let i = 1; i < rows.length; i++) { const n = rowToNotif(rows[i]); if (n) items.push(n); }
    items.reverse(); // terbaru dulu
    cache = { at: Date.now(), items };
    return items;
  })().finally(() => { inflightAll = null; });
  return inflightAll;
}

async function getLastRead(username) {
  const key = String(username || '').toLowerCase();
  const hit = readCache[key];
  if (hit && Date.now() - hit.at < READ_TTL_MS) return hit.v;
  await ensure();
  const rows = await sheets.readSheet(sheets.SHEET_NOTIF_STATE);
  let found = '';
  for (let i = 1; i < rows.length; i++) {
    if (untxt(rows[i][0]).toLowerCase() === key) { found = String(rows[i][1] || ''); break; }
  }
  readCache[key] = { v: found, at: Date.now() };
  return found;
}

function visibleTo(n, session, zone) {
  if (n.zone && zone && n.zone !== zone) return false; // pengingat per zona waktu
  if (n.actor && n.actor.toLowerCase() === String(session.username || '').toLowerCase()) return false; // aksi sendiri tidak perlu diberitahu
  if (n.audience === 'admin' && session.role !== 'admin') return false;
  return true;
}

/**
 * Buat notifikasi + kirim push. TIDAK PERNAH melempar error — kegagalan
 * notifikasi tidak boleh menggagalkan aksi utama.
 * n: { type, title, message, actor (username), audience, dataId, kampung }
 */
async function notify(n) {
  try {
    await ensure();
    const row = {
      id: 'N' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      timestamp: new Date().toISOString(),
      type: String(n.type || 'info'),
      title: String(n.title || '').slice(0, 120),
      message: String(n.message || '').slice(0, 400),
      actor: String(n.actor || ''),
      audience: n.audience === 'admin' ? 'admin' : 'all',
      dataId: String(n.dataId || ''),
      kampung: String(n.kampung || ''),
      zone: prefs.isZone(n.zone) ? n.zone : ''
    };
    await sheets.appendRow(sheets.SHEET_NOTIF, [
      row.id, row.timestamp, row.type, row.title, row.message, row.actor, row.audience, row.dataId, row.kampung, row.zone ? "'" + row.zone : ''
    ]);
    cache = { at: 0, items: null };

    if (push.isConfigured()) {
      const url = row.dataId ? '/?nav=data&id=' + encodeURIComponent(row.dataId) : '/?nav=notif';
      await push.send(
        { title: row.title, body: row.message, tag: row.type, url, icon: '/icons/icon-192.png' },
        { audience: row.audience, exceptUsername: row.actor, zone: row.zone }
      );
    }
    return row;
  } catch (e) {
    console.error('[notif] gagal membuat notifikasi:', e && e.message);
    return null;
  }
}

/** Daftar notifikasi untuk user + jumlah belum dibaca. */
async function list(session, params) {
  params = params || {};
  const zone = await prefs.userZone(session.username);
  const all = (await readAll()).filter(n => visibleTo(n, session, zone));
  let lastRead = await getLastRead(session.username);
  // Pertama kali user memakai notifikasi: riwayat lama dianggap sudah dibaca
  if (!lastRead) lastRead = (await markRead(session)).lastReadAt;
  const lastReadMs = Date.parse(lastRead) || 0;
  const mapped = all.map(n => ({ ...n, read: (Date.parse(n.timestamp) || 0) <= lastReadMs }));
  const unread = mapped.filter(n => !n.read).length;
  let limit = parseInt(params.limit, 10) || 30;
  limit = Math.min(Math.max(limit, 1), MAX_LIST);
  let items = mapped;
  if (params.unreadOnly) items = items.filter(n => !n.read);
  return { ok: true, items: items.slice(0, limit), unread, lastReadAt: lastRead, serverTime: new Date().toISOString() };
}

/** Tandai semua notifikasi terbaca (sampai sekarang). */
async function markRead(session) {
  await ensure();
  const now = new Date().toISOString();
  const key = String(session.username || '').toLowerCase();
  const rows = await sheets.readSheet(sheets.SHEET_NOTIF_STATE);
  let rowNum = 0;
  for (let i = 1; i < rows.length; i++) {
    if (untxt(rows[i][0]).toLowerCase() === key) { rowNum = i + 1; break; }
  }
  const values = ["'" + session.username, now];
  if (rowNum) await sheets.updateRow(sheets.SHEET_NOTIF_STATE, rowNum, values);
  else await sheets.appendRow(sheets.SHEET_NOTIF_STATE, values);
  readCache[key] = { v: now, at: Date.now() };
  return { ok: true, lastReadAt: now };
}

module.exports = { notify, list, markRead };
