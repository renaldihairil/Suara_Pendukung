'use strict';
/* ============================================================
 * Web Push (VAPID) — langganan perangkat disimpan di sheet PushSubs.
 * Jika env VAPID_* belum diisi, push nonaktif (notifikasi dalam
 * aplikasi tetap jalan) dan semua fungsi di sini aman dipanggil.
 *
 * Generate kunci sekali:  npm run vapid
 * ============================================================ */
const crypto = require('crypto');
const sheets = require('./gsheets');
const prefs = require('./prefs');

let webpush = null;
let configured = null; // null = belum dicek

function init() {
  if (configured !== null) return configured;
  const pub = String(process.env.VAPID_PUBLIC_KEY || '').trim();
  const priv = String(process.env.VAPID_PRIVATE_KEY || '').trim();
  if (!pub || !priv) { configured = false; return false; }
  try {
    webpush = webpush || require('web-push');
    webpush.setVapidDetails(String(process.env.VAPID_SUBJECT || 'mailto:admin@example.com').trim(), pub, priv);
    configured = true;
  } catch (e) {
    console.error('[push] VAPID tidak valid:', e.message);
    configured = false;
  }
  return configured;
}

function getPublicKey() { return init() ? String(process.env.VAPID_PUBLIC_KEY).trim() : ''; }
function isConfigured() { return init(); }

/** Untuk pengujian: ganti modul web-push dengan tiruan. */
function _setWebPush(mock) { webpush = mock; configured = null; }

const txt = v => "'" + String(v == null ? '' : v); // paksa teks di Sheets (apostrof otomatis hilang di Sheets)
const untxt = v => String(v == null ? '' : v).replace(/^'+/, '').trim();

async function readSubs() {
  const rows = await sheets.readSheet(sheets.SHEET_PUSH);
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const endpoint = untxt(r[3]);
    if (!endpoint) continue;
    list.push({
      rowNum: i + 1, id: String(r[0] || ''), username: untxt(r[1]),
      role: String(r[2] || 'user'), endpoint,
      keys: { p256dh: untxt(r[4]), auth: untxt(r[5]) }
    });
  }
  return list;
}

/** Simpan/perbarui langganan (kunci unik = endpoint). Satu perangkat = satu user terakhir yang login. */
async function subscribe(session, subscription, userAgent) {
  if (!init()) return { ok: false, message: 'Push belum diaktifkan di server (VAPID belum diisi)' };
  const sub = subscription || {};
  const keys = sub.keys || {};
  if (!sub.endpoint || !/^https:\/\//.test(sub.endpoint) || !keys.p256dh || !keys.auth) {
    return { ok: false, message: 'Data langganan push tidak valid' };
  }
  const subs = await readSubs();
  const existing = subs.find(s => s.endpoint === sub.endpoint);
  const row = [
    existing ? existing.id : 'S' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    session.username, session.role, txt(sub.endpoint), txt(keys.p256dh), txt(keys.auth),
    new Date().toISOString(), String(userAgent || '').slice(0, 160)
  ];
  if (existing) await sheets.updateRow(sheets.SHEET_PUSH, existing.rowNum, row);
  else await sheets.appendRow(sheets.SHEET_PUSH, row);
  return { ok: true };
}

async function unsubscribe(endpoint) {
  const ep = String(endpoint || '').trim();
  if (!ep) return { ok: true };
  const subs = await readSubs();
  const hit = subs.filter(s => s.endpoint === ep).sort((a, b) => b.rowNum - a.rowNum);
  for (const s of hit) await sheets.deleteRow(sheets.SHEET_PUSH, s.rowNum);
  return { ok: true };
}

/**
 * Kirim payload ke semua perangkat yang berhak.
 * opts: { audience: 'all'|'admin', exceptUsername, onlyUsername, zone (Asia/Makassar dst: hanya user di zona itu) }
 * Langganan yang sudah mati (404/410) dibersihkan otomatis.
 */
async function send(payload, opts) {
  opts = opts || {};
  if (!init()) return { sent: 0, failed: 0, skipped: true };
  let subs;
  try { subs = await readSubs(); } catch (e) { return { sent: 0, failed: 0, error: e.message }; }
  const except = String(opts.exceptUsername || '').toLowerCase();
  const only = String(opts.onlyUsername || '').toLowerCase();
  subs = subs.filter(s => {
    const u = s.username.toLowerCase();
    if (only) return u === only;
    if (except && u === except) return false;
    if (opts.audience === 'admin' && s.role !== 'admin') return false;
    return true;
  });
  if (opts.zone && subs.length) {
    try {
      const zm = await prefs.load();
      subs = subs.filter(s => ((zm.map[s.username.toLowerCase()] || {}).zone || zm.defaultZone) === opts.zone);
    } catch (e) { /* gagal baca preferensi → kirim ke semua */ }
  }
  if (!subs.length) return { sent: 0, failed: 0 };

  const body = JSON.stringify(payload);
  const dead = [];
  let sent = 0, failed = 0;
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 6 * 3600, urgency: 'normal', timeout: 8000 });
      sent++;
    } catch (e) {
      failed++;
      if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(s);
    }
  }));
  // hapus dari baris paling bawah agar nomor baris tidak bergeser
  dead.sort((a, b) => b.rowNum - a.rowNum);
  for (const s of dead) { try { await sheets.deleteRow(sheets.SHEET_PUSH, s.rowNum); } catch (e) { /* abaikan */ } }
  return { sent, failed, pruned: dead.length };
}

module.exports = { isConfigured, getPublicKey, subscribe, unsubscribe, send, _setWebPush };
