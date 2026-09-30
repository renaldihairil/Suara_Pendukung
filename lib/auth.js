'use strict';
/* ============================================================
 * Auth — sesi JWT httpOnly cookie + manajemen user di sheet Users.
 * Password di-hash bcrypt. Bootstrap admin otomatis saat login
 * pertama jika sheet Users masih kosong.
 * ============================================================ */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getEnv } = require('./env');
const sheets = require('./gsheets');

const COOKIE_NAME = 'pkd_session';
const SESSION_TTL_SECONDS = 7 * 24 * 3600; // 7 hari

function newUserId() {
  return 'U' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/* ================== SHEET USERS ================== */

function rowsToUsers(rows) {
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const id = String(r[0] || '').trim();
    if (!id) continue;
    list.push({
      rowNum: i + 1,
      id,
      username: String(r[1] || '').trim(),
      passwordHash: String(r[2] || ''),
      nama: String(r[3] || ''),
      role: String(r[4] || 'user').toLowerCase() === 'admin' ? 'admin' : 'user',
      aktif: String(r[5] || '').trim().toLowerCase() !== 'false',
      createdAt: String(r[6] || ''),
      lastLogin: String(r[7] || '')
    });
  }
  return list;
}

async function listUsers() {
  const rows = await sheets.readSheet(sheets.SHEET_USERS);
  return rowsToUsers(rows);
}

async function findUserByUsername(username) {
  const uname = String(username || '').trim().toLowerCase();
  if (!uname) return null;
  const users = await listUsers();
  return users.find(u => u.username.toLowerCase() === uname) || null;
}

/** Pastikan minimal 1 admin ada; buat dari env saat bootstrap pertama. */
async function ensureBootstrapAdmin() {
  const users = await listUsers();
  if (users.some(u => u.role === 'admin' && u.aktif)) return { bootstrapped: false };
  const env = getEnv();
  if (!env.adminPassword) {
    throw new Error('Sheet Users masih kosong — set env ADMIN_USERNAME & ADMIN_PASSWORD untuk membuat admin pertama');
  }
  const now = new Date().toISOString();
  await sheets.appendRow(sheets.SHEET_USERS, [
    newUserId(),
    env.adminUsername,
    bcrypt.hashSync(env.adminPassword, 10),
    'Administrator',
    'admin',
    'true',
    now,
    ''
  ]);
  return { bootstrapped: true };
}

/* ================== SESI JWT ================== */

function signSession(user) {
  const env = getEnv();
  return jwt.sign(
    { sub: user.id, username: user.username, nama: user.nama, role: user.role },
    env.jwtSecret,
    { expiresIn: SESSION_TTL_SECONDS }
  );
}

function verifySession(token) {
  try {
    const env = getEnv();
    const payload = jwt.verify(token, env.jwtSecret);
    if (!payload || !payload.sub) return null;
    return { userId: payload.sub, username: payload.username, nama: payload.nama, role: payload.role };
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function getSessionFromReq(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  return verifySession(token);
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/* ================== AKSI LOGIN & USER ================== */

async function authenticate(username, password) {
  const user = await findUserByUsername(username);
  if (!user) return { ok: false, message: 'Username atau password salah' };
  if (!user.aktif) return { ok: false, message: 'Akun dinonaktifkan. Hubungi admin.' };
  if (!user.passwordHash || !bcrypt.compareSync(String(password || ''), user.passwordHash)) {
    return { ok: false, message: 'Username atau password salah' };
  }
  return { ok: true, user };
}

async function touchLastLogin(user) {
  try {
    await sheets.updateCells(sheets.SHEET_USERS, user.rowNum, 8, [new Date().toISOString()]);
  } catch (e) { /* tidak kritis */ }
}

async function createUser({ username, password, nama, role }) {
  const uname = String(username || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(uname)) {
    return { ok: false, message: 'Username 3-30 karakter (huruf, angka, . _ -)' };
  }
  if (String(password || '').length < 6) {
    return { ok: false, message: 'Password minimal 6 karakter' };
  }
  const existing = await findUserByUsername(uname);
  if (existing) return { ok: false, message: 'Username sudah dipakai' };
  const r = String(role) === 'admin' ? 'admin' : 'user';
  const now = new Date().toISOString();
  const id = newUserId();
  await sheets.appendRow(sheets.SHEET_USERS, [
    id, uname, bcrypt.hashSync(String(password), 10),
    String(nama || uname).trim(), r, 'true', now, ''
  ]);
  return { ok: true, id };
}

async function updateUser(id, { nama, role, aktif }) {
  const users = await listUsers();
  const user = users.find(u => u.id === String(id));
  if (!user) return { ok: false, message: 'User tidak ditemukan' };

  if (user.role === 'admin' && (role === 'user' || aktif === false)) {
    const adminAktifLain = users.some(u => u.id !== user.id && u.role === 'admin' && u.aktif);
    if (!adminAktifLain) return { ok: false, message: 'Minimal harus ada 1 admin aktif' };
  }

  const newNama = nama != null ? String(nama).trim() : user.nama;
  const newRole = role != null ? (String(role) === 'admin' ? 'admin' : 'user') : user.role;
  const newAktif = aktif != null ? (aktif ? 'true' : 'false') : (user.aktif ? 'true' : 'false');
  await sheets.updateRow(sheets.SHEET_USERS, user.rowNum, [
    user.id, user.username, user.passwordHash, newNama, newRole, newAktif, user.createdAt, user.lastLogin
  ]);
  return { ok: true };
}

async function resetPassword(id, newPassword) {
  if (String(newPassword || '').length < 6) return { ok: false, message: 'Password minimal 6 karakter' };
  const users = await listUsers();
  const user = users.find(u => u.id === String(id));
  if (!user) return { ok: false, message: 'User tidak ditemukan' };
  await sheets.updateCells(sheets.SHEET_USERS, user.rowNum, 3, [bcrypt.hashSync(String(newPassword), 10)]);
  return { ok: true };
}

async function changeOwnPassword(session, oldPassword, newPassword) {
  if (String(newPassword || '').length < 6) return { ok: false, message: 'Password baru minimal 6 karakter' };
  const users = await listUsers();
  const user = users.find(u => u.id === session.userId);
  if (!user) return { ok: false, message: 'User tidak ditemukan' };
  if (!bcrypt.compareSync(String(oldPassword || ''), user.passwordHash)) {
    return { ok: false, message: 'Password lama salah' };
  }
  await sheets.updateCells(sheets.SHEET_USERS, user.rowNum, 3, [bcrypt.hashSync(String(newPassword), 10)]);
  return { ok: true };
}

/** Guard: pastikan sesi valid; untuk write wajib admin. Throw jika ditolak. */
function requireAuth(session, { adminOnly } = {}) {
  if (!session) { const e = new Error('Unauthorized'); e.status = 401; throw e; }
  if (adminOnly && session.role !== 'admin') {
    const e = new Error('Khusus admin'); e.status = 403; throw e;
  }
}

module.exports = {
  COOKIE_NAME, SESSION_TTL_SECONDS,
  listUsers, findUserByUsername, ensureBootstrapAdmin,
  signSession, verifySession, parseCookies, getSessionFromReq,
  sessionCookie, clearSessionCookie,
  authenticate, touchLastLogin,
  createUser, updateUser, resetPassword, changeOwnPassword,
  requireAuth
};
