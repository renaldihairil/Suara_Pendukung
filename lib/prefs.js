'use strict';
/* ============================================================
 * Preferensi user — zona waktu (WIB / WITA / WIT).
 *  - mode 'auto'  : mengikuti perangkat (dikirim klien sebagai offset menit)
 *  - mode 'manual': user memilih sendiri
 *  - tanpa data   : memakai zona default aplikasi (awalnya WITA)
 * Zona default disimpan admin di sheet Config (key reminder_zone).
 * ============================================================ */
const sheets = require('./gsheets');

const ZONES = {
  'Asia/Jakarta':  { label: 'WIB',  offset: 420, nama: 'Waktu Indonesia Barat' },
  'Asia/Makassar': { label: 'WITA', offset: 480, nama: 'Waktu Indonesia Tengah' },
  'Asia/Jayapura': { label: 'WIT',  offset: 540, nama: 'Waktu Indonesia Timur' }
};
const FALLBACK_ZONE = ZONES[String(process.env.APP_TIMEZONE || '').trim()] ? String(process.env.APP_TIMEZONE).trim() : 'Asia/Makassar';
const untxt = v => String(v == null ? '' : v).replace(/^'+/, '').trim();

const isZone = z => Object.prototype.hasOwnProperty.call(ZONES, z);
const zoneLabel = z => (ZONES[z] || ZONES[FALLBACK_ZONE]).label;
const zoneFromOffset = off => Object.keys(ZONES).find(z => ZONES[z].offset === Number(off)) || null;

let cache = { at: 0, value: null };
const TTL = 60000;   // preferensi jarang berubah; hemat kuota baca Sheets
let inflight = null;
const invalidate = () => { cache = { at: 0, value: null }; };

/** { defaultZone, map: { usernameLower: { mode, zone, rowNum } } } */
async function load() {
  const now = Date.now();
  if (cache.value && now - cache.at < TTL) return cache.value;
  if (inflight) return inflight;
  inflight = doLoad().finally(() => { inflight = null; });
  return inflight;
}

async function doLoad() {
  const [cfgRows, prefRows] = await sheets.readSheets([sheets.SHEET_CONFIG, sheets.SHEET_USER_PREFS]);
  let defaultZone = FALLBACK_ZONE;
  for (let i = 1; i < cfgRows.length; i++) {
    if (String(cfgRows[i][0] || '').trim() === 'reminder_zone' && isZone(untxt(cfgRows[i][1]))) defaultZone = untxt(cfgRows[i][1]);
  }
  const map = {};
  for (let i = 1; i < prefRows.length; i++) {
    const u = untxt(prefRows[i][0]).toLowerCase();
    if (!u) continue;
    const zone = untxt(prefRows[i][2]);
    map[u] = { mode: untxt(prefRows[i][1]) === 'manual' ? 'manual' : 'auto', zone: isZone(zone) ? zone : defaultZone, rowNum: i + 1 };
  }
  cache = { at: Date.now(), value: { defaultZone, map } };
  return cache.value;
}

async function getDefaultZone() { return (await load()).defaultZone; }

async function userZone(username) {
  const { defaultZone, map } = await load();
  const p = map[String(username || '').toLowerCase()];
  return p ? p.zone : defaultZone;
}

/**
 * Sinkronkan preferensi saat aplikasi dibuka.
 * Belum ada data → buat mode auto dari offset perangkat; mode auto → perbarui jika berpindah zona.
 */
async function syncUser(username, offsetMin) {
  const st = await load();
  const key = String(username || '').toLowerCase();
  const cur = st.map[key];
  const detected = zoneFromOffset(offsetMin) || st.defaultZone;
  if (!cur) { await write(username, null, 'auto', detected); return { mode: 'auto', zone: detected, defaultZone: st.defaultZone, detected }; }
  if (cur.mode === 'auto' && cur.zone !== detected) { await write(username, cur.rowNum, 'auto', detected); return { mode: 'auto', zone: detected, defaultZone: st.defaultZone, detected }; }
  return { mode: cur.mode, zone: cur.zone, defaultZone: st.defaultZone, detected };
}

async function saveUser(username, mode, zone, offsetMin) {
  const st = await load();
  const cur = st.map[String(username || '').toLowerCase()];
  let m = mode === 'manual' ? 'manual' : 'auto';
  let z;
  if (m === 'manual') {
    if (!isZone(zone)) return { ok: false, message: 'Zona waktu tidak valid' };
    z = zone;
  } else {
    z = zoneFromOffset(offsetMin) || st.defaultZone;
  }
  await write(username, cur ? cur.rowNum : null, m, z);
  return { ok: true, mode: m, zone: z, defaultZone: st.defaultZone };
}

let ensured = null;
async function write(username, rowNum, mode, zone) {
  if (!ensured) ensured = sheets.ensureSheets().catch(e => { ensured = null; throw e; });
  await ensured;
  const row = ["'" + username, mode, zone, new Date().toISOString()];
  if (rowNum) await sheets.updateRow(sheets.SHEET_USER_PREFS, rowNum, row);
  else await sheets.appendRow(sheets.SHEET_USER_PREFS, row);
  invalidate();
}

module.exports = { ZONES, FALLBACK_ZONE, isZone, zoneLabel, zoneFromOffset, load, getDefaultZone, userZone, syncUser, saveUser, invalidate };
