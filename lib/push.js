'use strict';
/* ============================================================
 * Notifikasi PUSH (Web Push) — hanya 2 kejadian:
 *   'baru'  = data pendukung baru ditambahkan
 *   'pasti' = suara diverifikasi PASTI
 * Dikirim ke SEMUA perangkat yang mengaktifkan notifikasi, KECUALI
 * milik pelakunya sendiri. Jam tenang 22.00–06.00 WITA: tidak dikirim.
 *
 * Kunci VAPID: env VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, atau dibuat
 * OTOMATIS sekali lalu disimpan di sheet Config (vapid_public/vapid_private).
 * Langganan perangkat: sheet "PushSubs" (dibaca ter-cache ±60 dtk).
 * Pengiriman berjalan di belakang layar (waitUntil) → simpan data tidak melambat.
 * ============================================================ */
const sheets = require('./gsheets');

const SHEET = sheets.SHEET_PUSH;
const QUIET_START = 22, QUIET_END = 6;           // WITA
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:noreply@suara-pendukung.vercel.app';

let wp = null;
function webpush() { if (!wp) wp = require('web-push'); return wp; }

/* ---------- kunci VAPID ---------- */
let keysMemo = null;
async function readCfgRaw() {
  const rows = await sheets.readSheet(sheets.SHEET_CONFIG);
  const o = {};
  for (let i = 1; i < rows.length; i++) o[String(rows[i][0] || '').trim()] = String(rows[i][1] || '').replace(/^'+/, '').trim();
  return o;
}
async function getKeys() {
  if (keysMemo) return keysMemo;
  const envPub = String(process.env.VAPID_PUBLIC_KEY || '').trim(), envPriv = String(process.env.VAPID_PRIVATE_KEY || '').trim();
  if (envPub && envPriv) return (keysMemo = { publicKey: envPub, privateKey: envPriv });
  let c = await readCfgRaw();
  if (!c.vapid_public || !c.vapid_private) {
    const k = webpush().generateVAPIDKeys();
    // tulis HANYA bila masih kosong (baca ulang tanpa cache untuk menghindari 2 instance membuat kunci berbeda)
    const rows = await sheets.readSheet(sheets.SHEET_CONFIG, { fresh: true });
    const has = rows.some(r => String(r[0] || '').trim() === 'vapid_public' && String(r[1] || '').trim());
    if (!has) {
      await sheets.appendRow(sheets.SHEET_CONFIG, ['vapid_public', k.publicKey]);
      await sheets.appendRow(sheets.SHEET_CONFIG, ['vapid_private', k.privateKey]);
    }
    c = await readCfgRaw();
  }
  return (keysMemo = { publicKey: c.vapid_public, privateKey: c.vapid_private });
}
async function publicKey() { return (await getKeys()).publicKey; }

/* ---------- langganan ---------- */
async function readSubs(fresh) {
  await sheets.ensureSheets();
  const rows = await sheets.readSheet(SHEET, { fresh: !!fresh });
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const endpoint = String(r[0] || '').trim();
    if (!endpoint) continue;
    list.push({ rowNum: i + 1, endpoint, p256dh: String(r[1] || ''), auth: String(r[2] || ''),
      username: String(r[3] || ''), peran: String(r[4] || ''), perangkat: String(r[5] || '') });
  }
  return list;
}

function validSub(sub) {
  return sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1200 &&
    sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
}

async function subscribe(session, sub, perangkat) {
  if (!validSub(sub)) return { ok: false, message: 'Data langganan notifikasi tidak valid' };
  const subs = await readSubs(true);
  const now = new Date().toISOString();
  const row = [sub.endpoint, sub.keys.p256dh, sub.keys.auth, session.username, session.role, String(perangkat || '').slice(0, 120), now, now];
  const ada = subs.find(s => s.endpoint === sub.endpoint);
  if (ada) await sheets.updateRow(SHEET, ada.rowNum, row);
  else await sheets.appendRow(SHEET, row);
  return { ok: true };
}

async function unsubscribe(endpoint) {
  const subs = await readSubs(true);
  const ada = subs.find(s => s.endpoint === String(endpoint || ''));
  if (ada) await sheets.deleteRow(SHEET, ada.rowNum);
  return { ok: true };
}

async function status(session, endpoint) {
  const subs = await readSubs(false);
  const s = subs.find(x => x.endpoint === String(endpoint || ''));
  return { ok: true, aktif: !!(s && s.username === session.username) };
}

/** { username: jumlah perangkat aktif } — untuk halaman Kelola User */
async function countByUser() {
  try {
    const subs = await readSubs(false);
    const m = {};
    subs.forEach(s => { const k = s.username.toLowerCase(); m[k] = (m[k] || 0) + 1; });
    return m;
  } catch (e) { return {}; }
}

/* ---------- kirim ---------- */
function witaHour(d) {
  return parseInt(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Makassar' }).format(d || new Date()), 10) % 24;
}
function isQuiet(d) { const h = witaHour(d); return h >= QUIET_START || h < QUIET_END; }

/**
 * evt: { type:'baru'|'pasti', id, nama, kampung, rt } • actor: sesi pelaku
 * → { sent, skipped, removed, quiet }
 */
async function notify(evt, actor) {
  if (isQuiet()) return { sent: 0, quiet: true };
  const subs = (await readSubs(false)).filter(s => s.username.toLowerCase() !== String(actor.username || '').toLowerCase());
  if (!subs.length) return { sent: 0 };
  const payload = JSON.stringify({
    type: evt.type, id: evt.id, nama: evt.nama, lokasi: [evt.kampung, evt.rt ? 'RT ' + evt.rt : ''].filter(Boolean).join(' '),
    oleh: actor.nama || actor.username, peran: actor.peran || '', at: Date.now()
  });
  if (process.env.PUSH_MOCK === '1') {                        // server uji: catat tanpa jaringan
    global.__pushSent = (global.__pushSent || []).concat(subs.map(s => ({ to: s.username, payload: JSON.parse(payload) })));
    return { sent: subs.length };
  }
  const keys = await getKeys();
  const opts = { vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: 6 * 3600, urgency: 'normal', topic: evt.type === 'pasti' ? 'suara-pasti' : 'data-baru', timeout: 6000 };
  let sent = 0;
  const gone = [];
  await Promise.all(subs.map(s =>
    webpush().sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, opts)
      .then(() => { sent++; })
      .catch(e => { if (e && (e.statusCode === 404 || e.statusCode === 410)) gone.push(s); })
  ));
  // perangkat yang sudah mencabut izin / uninstall → hapus dari daftar (dari bawah agar nomor baris tetap benar)
  gone.sort((a, b) => b.rowNum - a.rowNum);
  for (const s of gone) { try { await sheets.deleteRow(SHEET, s.rowNum); } catch (e) { /* abaikan */ } }
  return { sent, removed: gone.length };
}

/** Jalankan setelah respons dikirim (Vercel waitUntil); tanpa dukungan → ditunggu maks. 4 dtk */
async function later(promise) {
  const p = Promise.resolve(promise).catch(e => console.warn('[push] gagal:', e && e.message));
  try {
    const ctx = globalThis[Symbol.for('@vercel/request-context')];
    const c = ctx && ctx.get && ctx.get();
    if (c && typeof c.waitUntil === 'function') { c.waitUntil(p); return; }
  } catch (e) { /* abaikan */ }
  await Promise.race([p, new Promise(r => setTimeout(r, 4000))]);
}

module.exports = { publicKey, subscribe, unsubscribe, status, countByUser, notify, later, isQuiet, witaHour };
