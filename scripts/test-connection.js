'use strict';
/* ============================================================
 * Tes koneksi Service Account → Google Sheets + Drive.
 * Pakai:  node scripts/test-connection.js <SPREADSHEET_ID>
 * Ambil ID dari URL spreadsheet: docs.google.com/spreadsheets/d/<ID>/edit
 * ============================================================ */
const fs = require('fs');
const path = require('path');

/* Muat .env sederhana (KEY=VALUE per baris) */
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    console.error('✗ File .env tidak ditemukan di root proyek.');
    process.exit(1);
  }
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}

async function main() {
  loadEnv();

  const id = process.argv[2] || process.env.SPREADSHEET_ID || '';
  if (!id || id === 'ISI_ID_SPREADSHEET_ANDA') {
    console.error('✗ SPREADSHEET_ID belum diisi.');
    console.error('  Cara pakai: node scripts/test-connection.js <SPREADSHEET_ID>');
    console.error('  Ambil ID dari URL: docs.google.com/spreadsheets/d/<ID>/edit');
    process.exit(1);
  }
  process.env.SPREADSHEET_ID = id;

  console.log('1) Memuat kredensial service account...');
  const sheetsLib = require('../lib/gsheets');
  console.log('   ✓ Kredensial valid');

  console.log('2) Membaca spreadsheet (sheet Config)...');
  try {
    await sheetsLib.ensureSheets();
    console.log('   ✓ Spreadsheet terhubung, sheet Pendukung/Log/Config/Users siap');
  } catch (e) {
    console.error('   ✗ GAGAL: ' + e.message);
    console.error('   → Pastikan spreadsheet SUDAH di-share (Editor) ke email service account:');
    const { parseCredentials } = require('../lib/env');
    try { console.error('     ' + parseCredentials(process.env.GOOGLE_CREDENTIALS).client_email); } catch (e2) {}
    process.exit(1);
  }

  console.log('3) Menulis tes ke sheet Config...');
  try {
    const rows = await sheetsLib.readSheet(sheetsLib.SHEET_CONFIG);
    console.log('   ✓ Baca OK (' + Math.max(0, rows.length - 1) + ' baris config)');
  } catch (e) {
    console.error('   ✗ GAGAL baca: ' + e.message);
    process.exit(1);
  }

  console.log('4) Tes akses Drive (buat folder bila belum ada)...');
  try {
    const drive = require('../lib/gdrive');
    await drive.getOrCreateFolder(drive.FOLDER_KTP);
    await drive.getOrCreateFolder(drive.FOLDER_TTD);
    console.log('   ✓ Drive OK (folder foto siap)');
  } catch (e) {
    console.error('   ✗ GAGAL Drive: ' + e.message);
    console.error('   → Aktifkan Google Drive API di project, dan share folder Drive ke service account.');
    process.exit(1);
  }

  console.log('');
  console.log('════════════════════════════════════════════');
  console.log('  ✅ SEMUA KONEKSI BERHASIL — siap deploy!');
  console.log('════════════════════════════════════════════');
}

main().catch(e => { console.error('✗', e.message); process.exit(1); });
