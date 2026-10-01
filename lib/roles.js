'use strict';
/* ============================================================
 * Peran pengguna (disimpan di kolom Role sheet Users):
 *  - admin    = Super Admin: kelola penuh (pengaturan, user, log, edit/hapus data)
 *  - operator = Operator: input & edit data, ubah status suara & status cetak,
 *               download KTP / PDF per kampung. Tidak bisa hapus data, pengaturan & kelola user.
 *  - user     = Pemantau: hanya melihat data.
 * ============================================================ */

const ROLES = ['admin', 'operator', 'user'];
const ROLE_LABEL = { admin: 'Super Admin', operator: 'Operator', user: 'User' };

/** Nilai bebas dari sheet → salah satu ROLES (nilai tak dikenal = user, paling aman) */
function normRole(v) {
  const s = String(v || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (s === 'admin' || s === 'superadmin' || s === 'administrator') return 'admin';
  if (s === 'operator' || s === 'adminbiasa' || s === 'petugas' || s === 'admininput') return 'operator';
  return 'user';
}

// Aksi tulis yang boleh dilakukan Operator (selain itu: khusus Super Admin)
const OPERATOR_ACTIONS = new Set([
  'add', 'update', 'verifyWithTTD', 'unverify', 'togglePrint', 'setPrintBatch', 'logDownload',
  'getFotoBase64', 'ocrKtp'          // foto tajam (bahan PDF resmi) & baca KTP: bukan untuk peran User
]);

// Aksi yang khusus Super Admin
const ADMIN_ACTIONS = new Set([
  'delete', 'saveConfig', 'renameKampung', 'saveHariH',
  'saveUsers', 'resetUserPassword', 'updateUser', 'getUsers', 'getLogs'
]);

/** Boleh menjalankan aksi ini? (aksi baca umum → true untuk semua peran) */
function can(role, action) {
  const r = normRole(role);
  if (r === 'admin') return true;
  if (ADMIN_ACTIONS.has(action)) return false;
  if (OPERATOR_ACTIONS.has(action)) return r === 'operator';
  return true;
}

module.exports = { ROLES, ROLE_LABEL, normRole, can, OPERATOR_ACTIONS, ADMIN_ACTIONS };
