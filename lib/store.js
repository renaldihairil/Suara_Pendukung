'use strict';
/* ============================================================
 * Store — akses data Pendukung & Config (port dari Code.gs).
 * Semua respons berbentuk { ok, message?, ... } identik dengan
 * API lama supaya frontend minim perubahan.
 * ============================================================ */
const sheets = require('./gsheets');
const drive = require('./gdrive');
const domain = require('./domain');

let versionCache = { value: null, at: 0 };

function invalidateVersion() {
  versionCache = { value: null, at: 0 };
}

// fresh=true WAJIB untuk bacaan yang dipakai menulis (nomor baris harus akurat / cek duplikat final).
// Bacaan tampilan (daftar, dashboard, versi, cek NIK) boleh dari cache pendek di lapisan sheet.
async function readPendukungRows(fresh) {
  return sheets.readSheet(sheets.SHEET_PENDUKUNG, { fresh: !!fresh });
}

async function readConfig(fresh) {
  const rows = await sheets.readSheet(sheets.SHEET_CONFIG, { fresh: !!fresh });
  return domain.parseConfigFromRows(rows);
}

const untxtCfg = v => String(v == null ? '' : v).replace(/^'+/, '').trim();

/** Tulis beberapa key Config sekaligus: SATU kali baca, tulis hanya yang berubah (hemat kuota Sheets). */
async function writeConfigEntries(entries) {
  const rows = await sheets.readSheet(sheets.SHEET_CONFIG, { fresh: true });
  const rowOf = {};
  for (let i = 1; i < rows.length; i++) rowOf[String(rows[i][0] || '').trim()] = i + 1;
  for (const [key, value] of Object.entries(entries)) {
    if (rowOf[key]) {
      if (untxtCfg(rows[rowOf[key] - 1][1]) === untxtCfg(value)) continue;
      await sheets.updateCells(sheets.SHEET_CONFIG, rowOf[key], 2, [value]);
    } else if (value !== '') {
      await sheets.appendRow(sheets.SHEET_CONFIG, [key, value]);
    }
  }
}

/* ================== VERSION ================== */

async function getVersion() {
  const now = Date.now();
  if (versionCache.value && now - versionCache.at < 15000) return versionCache.value;
  try {
    // Pendukung + Config dibaca dalam SATU permintaan (hemat kuota baca Sheets)
    const [rows, cfgRows] = await sheets.readSheets([sheets.SHEET_PENDUKUNG, sheets.SHEET_CONFIG]);
    let verifiedCount = 0, ttdCount = 0, printedCount = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!String(r[0] || '').trim()) continue;
      if (domain.normVerified(r[11])) verifiedCount++;
      if (String(r[13] || '').trim()) ttdCount++;
      if (domain.normBool(r[14])) printedCount++;
    }
    const cfg = domain.parseConfigFromRows(cfgRows);
    const version = rows.length + '|' + String(rows[rows.length - 1] ? rows[rows.length - 1][0] || '' : '') +
      '|' + verifiedCount + '|' + ttdCount + '|' + printedCount + '|' + domain.cfgHashOf(cfg);
    versionCache = { value: version, at: now };
    return version;
  } catch (e) {
    return '0|error';
  }
}

/* ================== LIST ================== */

async function getList(filter) {
  filter = filter || {};
  const rows = await readPendukungRows();
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const item = domain.rowToPendukung(rows[i], i + 1);
    if (item) list.push(item);
  }

  list.sort((a, b) => {
    const ta = new Date(a.timestamp).getTime() || 0;
    const tb = new Date(b.timestamp).getTime() || 0;
    if (tb !== ta) return tb - ta;
    return String(b.id).localeCompare(String(a.id));
  });

  let result = list;
  if (filter.kampung) {
    const fk = String(filter.kampung).trim();
    result = result.filter(x => String(x.kampung).trim() === fk);
  }
  if (filter.rt) {
    const frt = domain.normRT(filter.rt);
    result = result.filter(x => x.rt === frt);
  }
  if (filter.q) {
    const q = String(filter.q).toLowerCase();
    result = result.filter(x => x.nama.toLowerCase().includes(q) || x.nik.includes(q));
  }
  if (filter.verified === 'true' || filter.verified === true) result = result.filter(x => x.verified === true);
  else if (filter.verified === 'false' || filter.verified === false) result = result.filter(x => x.verified !== true);
  if (filter.dicetak === 'true' || filter.dicetak === true) result = result.filter(x => x.dicetak === true);
  else if (filter.dicetak === 'false' || filter.dicetak === false) result = result.filter(x => x.dicetak !== true);

  const cfg = await readConfig();
  return {
    ok: true,
    data: result,
    total: result.length,
    grandTotal: list.length,
    config: cfg,
    version: await getVersion()
  };
}

/* ================== DASHBOARD ================== */

async function getDashboard() {
  const cfg = await readConfig();
  const rows = await readPendukungRows();
  const data = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim()) data.push(rows[i]);
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  let todayCount = 0;

  const kampungCount = {};
  cfg.kampungList.forEach(k => { kampungCount[k] = 0; });
  const kampungVerified = {};
  cfg.kampungList.forEach(k => { kampungVerified[k] = 0; });

  let laki = 0, perempuan = 0, verified = 0, unverified = 0, ttdCount = 0;
  let unknownKampung = 0, dicetak = 0, belumCetak = 0;

  data.forEach(r => {
    const ts = new Date(r[1]); if (!isNaN(ts.getTime())) { ts.setHours(0, 0, 0, 0); if (ts.getTime() === today.getTime()) todayCount++; }

    const kampungNama = String(r[7] || '').trim();
    if (kampungCount[kampungNama] === undefined) {
      kampungCount[kampungNama] = 0;
      kampungVerified[kampungNama] = 0;
      if (cfg.kampungList.indexOf(kampungNama) === -1) unknownKampung++;
    }
    kampungCount[kampungNama] = (kampungCount[kampungNama] || 0) + 1;

    if (r[4] === 'Laki-laki') laki++;
    else if (r[4] === 'Perempuan') perempuan++;

    if (domain.normVerified(r[11])) {
      verified++;
      kampungVerified[kampungNama] = (kampungVerified[kampungNama] || 0) + 1;
    } else {
      unverified++;
    }

    if (String(r[13] || '').trim()) ttdCount++;
    if (domain.normBool(r[14])) dicetak++; else belumCetak++;
  });

  const targetPerKampung = {};
  cfg.kampungList.forEach(k => { targetPerKampung[k] = parseInt(cfg.targetPerKampung[k] || 0, 10) || 0; });

  return {
    ok: true,
    data: {
      total: data.length,
      hariIni: todayCount,
      perKampung: kampungCount,
      kampungVerified,
      targetPerKampung,
      laki, perempuan, verified, unverified, ttdCount,
      dicetak, belumCetak,
      target: cfg.targetTotal,
      kampungList: cfg.kampungList,
      namaPilkades: cfg.namaPilkades,
      namaKandidat: cfg.namaKandidat,
      hariH: cfg.hariH,
      unknownKampung,
      version: await getVersion()
    }
  };
}

/* ================== ADD / UPDATE / DELETE ================== */

async function addPendukung(data) {
  const cfg = await readConfig();
  const nama = String(data.nama || '').trim();
  const nik = String(data.nik || '').trim();
  const kampung = String(data.kampung || '').trim();
  const rt = domain.normRT(data.rt);

  if (!nama) return { ok: false, message: 'Nama wajib diisi' };
  if (!/^\d{16}$/.test(nik)) return { ok: false, message: 'NIK harus 16 digit' };
  if (cfg.kampungList.indexOf(kampung) === -1) return { ok: false, message: 'Kampung tidak valid' };
  if (!domain.isValidRT(rt)) return { ok: false, message: 'RT tidak valid' };
  const parsed = domain.parseNIK(nik);
  if (!parsed.valid) return { ok: false, message: parsed.msg };

  const rows = await readPendukungRows(true);
  const duplikat = domain.findDuplikatNIK(rows, nik);
  if (duplikat.length > 0) {
    return {
      ok: false,
      message: 'NIK sudah terdaftar: ' + duplikat[0].nama + ' (' + duplikat[0].kampung + ' RT ' + duplikat[0].rt + ')',
      duplikat
    };
  }

  let fotoId = '';
  let fotoGagal = '';
  if (data.fotoBase64) {
    const up = await drive.uploadBase64(
      data.fotoBase64, data.fotoMime || 'image/jpeg',
      'KTP_' + nik + '_' + Date.now() + '.jpg', drive.FOLDER_KTP
    );
    if (up.ok) fotoId = up.fileId;
    else fotoGagal = up.msg;   // data tetap disimpan; foto bisa diunggah ulang lewat Edit
  }

  let ttdId = '';
  if (data.fotoTTDBase64) {
    const upT = await drive.uploadBase64(
      data.fotoTTDBase64, data.fotoTTDMime || 'image/jpeg',
      'TTD_' + nik + '_' + Date.now() + '.jpg', drive.FOLDER_TTD
    );
    if (upT.ok) ttdId = upT.fileId;
  }

  const id = 'P' + Date.now();
  await sheets.appendRow(sheets.SHEET_PENDUKUNG, [
    id, new Date().toISOString(), nama, nik,
    parsed.jenisKelamin, parsed.tanggalLahir, parsed.usia,
    kampung, "'" + rt,
    '', fotoId,
    false, '', ttdId, false
  ]);
  invalidateVersion();

  if (fotoGagal) {
    return { ok: true, fotoGagal: true, message: 'Data tersimpan, TETAPI foto KTP gagal diunggah (' + fotoGagal + '). Buka Edit untuk unggah ulang.', id, version: await getVersion() };
  }
  return { ok: true, message: 'Data berhasil disimpan', id, version: await getVersion() };
}

async function updatePendukung(data) {
  const id = String(data.id || '');
  if (!id) return { ok: false, message: 'ID tidak ada' };

  const cfg = await readConfig();
  const rows = await readPendukungRows(true);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '') !== id) continue;
    const r = rows[i];
    const nama = String(data.nama != null && data.nama !== '' ? data.nama : r[2]).trim();
    const nik = String(data.nik != null && data.nik !== '' ? data.nik : r[3]).trim();
    const kampung = String(data.kampung != null && data.kampung !== '' ? data.kampung : r[7]).trim();
    const rt = domain.normRT(data.rt != null && data.rt !== '' ? data.rt : r[8]);

    if (!/^\d{16}$/.test(nik)) return { ok: false, message: 'NIK harus 16 digit' };
    if (cfg.kampungList.indexOf(kampung) === -1) return { ok: false, message: 'Kampung tidak valid' };
    if (!domain.isValidRT(rt)) return { ok: false, message: 'RT tidak valid' };
    const parsed = domain.parseNIK(nik);
    if (!parsed.valid) return { ok: false, message: parsed.msg };

    const duplikat = domain.findDuplikatNIK(rows, nik, id);
    if (duplikat.length > 0) {
      return {
        ok: false,
        message: 'NIK sudah dipakai: ' + duplikat[0].nama + ' (' + duplikat[0].kampung + ' RT ' + duplikat[0].rt + ')',
        duplikat
      };
    }

    let fotoId = String(r[10] || '');
    if (data.fotoBase64) {
      const up = await drive.uploadBase64(
        data.fotoBase64, data.fotoMime || 'image/jpeg',
        'KTP_' + nik + '_' + Date.now() + '.jpg', drive.FOLDER_KTP
      );
      if (!up.ok) return { ok: false, message: 'Gagal upload foto: ' + up.msg + '. Data belum diubah.' };
      if (fotoId) await drive.trashFile(fotoId);   // foto lama dibuang HANYA setelah yang baru sukses
      fotoId = up.fileId;
    }

    let ttdId = String(r[13] || '');
    if (data.fotoTTDBase64) {
      const upT = await drive.uploadBase64(
        data.fotoTTDBase64, data.fotoTTDMime || 'image/jpeg',
        'TTD_' + nik + '_' + Date.now() + '.jpg', drive.FOLDER_TTD
      );
      if (!upT.ok) return { ok: false, message: 'Gagal upload bukti TTD: ' + upT.msg + '. Data belum diubah.' };
      if (ttdId) await drive.trashFile(ttdId);
      ttdId = upT.fileId;
    }

    const verified = domain.normVerified(r[11]);
    await sheets.updateRow(sheets.SHEET_PENDUKUNG, i + 1, [
      id, r[1] instanceof Date ? r[1].toISOString() : String(r[1] || ''), nama, nik,
      parsed.jenisKelamin, parsed.tanggalLahir, parsed.usia,
      kampung, "'" + rt,
      '', fotoId,
      verified, '', ttdId,
      domain.normBool(r[14])
    ]);
    invalidateVersion();
    return { ok: true, message: 'Data berhasil diperbarui', version: await getVersion() };
  }
  return { ok: false, message: 'Data tidak ditemukan' };
}

async function deletePendukung(id) {
  const idStr = String(id || '');
  if (!idStr) return { ok: false, message: 'ID tidak ada' };
  const rows = await readPendukungRows(true);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '') !== idStr) continue;
    if (rows[i][10]) await drive.trashFile(rows[i][10]);
    if (rows[i][13]) await drive.trashFile(rows[i][13]);
    await sheets.deleteRow(sheets.SHEET_PENDUKUNG, i + 1);
    invalidateVersion();
    return { ok: true, message: 'Data dihapus', version: await getVersion() };
  }
  return { ok: false, message: 'Data tidak ditemukan' };
}

/* ================== VERIFY / PRINT ================== */

async function verifyWithTTD(data) {
  const id = String(data.id || '');
  if (!id) return { ok: false, message: 'ID tidak ada' };
  if (!data.fotoTTDBase64) return { ok: false, message: 'Bukti fotokopi TTD wajib diupload' };

  const rows = await readPendukungRows(true);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '') !== id) continue;
    const nama = String(rows[i][2] || '');
    const nik = String(rows[i][3] || '');
    const up = await drive.uploadBase64(
      data.fotoTTDBase64, data.fotoTTDMime || 'image/jpeg',
      'TTD_' + nik + '_' + Date.now() + '.jpg', drive.FOLDER_TTD
    );
    if (!up.ok) return { ok: false, message: 'Gagal upload bukti TTD: ' + up.msg };

    const oldTTDId = String(rows[i][13] || '');
    if (oldTTDId) await drive.trashFile(oldTTDId);

    await sheets.updateCells(sheets.SHEET_PENDUKUNG, i + 1, 12, [true, '', up.fileId]);
    invalidateVersion();
    return {
      ok: true,
      message: 'Suara PASTI ✅ (bukti TTD tersimpan)',
      verified: true,
      fotoTTD: '/api/photo?id=' + encodeURIComponent(up.fileId), // selalu ada id
      fotoTTDId: up.fileId,
      version: await getVersion()
    };
  }
  return { ok: false, message: 'Data tidak ditemukan' };
}

async function unverifyPendukung(id) {
  const idStr = String(id || '');
  if (!idStr) return { ok: false, message: 'ID tidak ada' };
  const rows = await readPendukungRows(true);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '') !== idStr) continue;
    const oldTTDId = String(rows[i][13] || '');
    if (oldTTDId) await drive.trashFile(oldTTDId);
    await sheets.updateCells(sheets.SHEET_PENDUKUNG, i + 1, 12, [false, '', '']);
    invalidateVersion();
    return { ok: true, message: 'Status direset ke BELUM PASTI', verified: false, version: await getVersion() };
  }
  return { ok: false, message: 'Data tidak ditemukan' };
}

async function togglePrint(id, dicetak) {
  const idStr = String(id || '');
  if (!idStr) return { ok: false, message: 'ID tidak ada' };
  const v = domain.normBool(dicetak);
  const rows = await readPendukungRows(true);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '') !== idStr) continue;
    await sheets.updateCells(sheets.SHEET_PENDUKUNG, i + 1, 15, [v]);
    invalidateVersion();
    return {
      ok: true,
      message: v ? 'Ditandai sebagai sudah dicetak' : 'Ditandai sebagai belum dicetak',
      dicetak: v, version: await getVersion()
    };
  }
  return { ok: false, message: 'Data tidak ditemukan' };
}

async function setPrintBatch(ids, dicetak) {
  if (typeof ids === 'string') {
    try { ids = JSON.parse(ids); } catch (e) { ids = ids.split(','); }
  }
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, message: 'Tidak ada data dipilih' };
  const idSet = {};
  ids.forEach(x => { idSet[String(x)] = true; });
  const v = domain.normBool(dicetak);

  const rows = await readPendukungRows(true);
  const updates = [];
  for (let i = 1; i < rows.length; i++) {
    if (idSet[String(rows[i][0] || '')]) updates.push({ rowNum: i + 1, value: v });
  }
  if (!updates.length) return { ok: false, message: 'Data tidak ditemukan' };

  // Tulis satu per satu (kecil kemungkinan > ratusan); bisa dioptimasi nanti
  for (const u of updates) {
    await sheets.updateCells(sheets.SHEET_PENDUKUNG, u.rowNum, 15, [u.value]);
  }
  invalidateVersion();
  return { ok: true, count: updates.length, dicetak: v, version: await getVersion() };
}

/* ================== CHECK NIK & SCAN ================== */

async function checkNik(params) {
  const nik = String(params.nik || '').trim();
  const excludeId = params.excludeId ? String(params.excludeId) : null;
  if (!/^\d{16}$/.test(nik)) return { ok: false, message: 'NIK harus 16 digit' };
  const rows = await readPendukungRows();
  const found = domain.findDuplikatNIK(rows, nik, excludeId);
  if (found.length === 0) return { ok: true, tersedia: true, duplikat: [] };
  return { ok: true, tersedia: false, duplikat: found };
}

async function scanDuplikat() {
  const rows = await readPendukungRows();
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const id = String(r[0] || '');
    if (!id) continue;
    const nik = String(r[3] || '').trim();
    if (!nik) continue;
    if (!map[nik]) map[nik] = [];
    map[nik].push({
      rowNum: i + 1, id,
      nama: String(r[2] || ''), nik,
      kampung: String(r[7] || ''),
      rt: domain.normRT(r[8]),
      timestamp: r[1] instanceof Date ? r[1].toISOString() : String(r[1] || '')
    });
  }
  const duplikat = [];
  Object.keys(map).forEach(nik => {
    if (map[nik].length > 1) duplikat.push({ nik, entries: map[nik] });
  });
  return {
    ok: true,
    totalGroup: duplikat.length,
    totalBaris: duplikat.reduce((s, d) => s + d.entries.length, 0),
    duplikat
  };
}

async function countKampung(nama) {
  const rows = await readPendukungRows();
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    if (!String(rows[i][0] || '').trim()) continue;
    if (String(rows[i][7] || '').trim() === String(nama).trim()) count++;
  }
  return { ok: true, count };
}

/* ================== CONFIG SAVE & RENAME ================== */

/**
 * Simpan pengaturan. Bisa PARSIAL — hanya field yang dikirim yang diubah:
 *   info    : { namaPilkades, namaKandidat }
 *   target  : { targetTotal }
 *   kampung : { kampungList, targetPerKampung }
 */
async function saveConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ok: false, message: 'Data config tidak valid' };
  const cur = await readConfig(true);
  const entries = {};

  // --- info Pilkades
  if (cfg.namaPilkades != null) {
    const v = String(cfg.namaPilkades).trim();
    if (!v) return { ok: false, message: 'Nama Pilkades wajib diisi' };
    entries.nama_pilkades = v;
  }
  if (cfg.namaKandidat != null) {
    const v = String(cfg.namaKandidat).trim();
    if (!v) return { ok: false, message: 'Nama Kandidat wajib diisi' };
    entries.nama_kandidat = v;
  }

  // --- daftar kampung + target per kampung
  if (cfg.kampungList !== undefined || cfg.targetPerKampung !== undefined) {
    let kampungList = cfg.kampungList !== undefined ? cfg.kampungList : cur.kampungList;
    if (!Array.isArray(kampungList)) return { ok: false, message: 'Daftar kampung tidak valid' };
    kampungList = kampungList.map(x => String(x || '').trim()).filter(x => x);
    if (kampungList.length === 0) return { ok: false, message: 'Minimal 1 kampung' };
    const seen = {};
    kampungList = kampungList.filter(k => {
      const lower = k.toLowerCase();
      if (seen[lower]) return false;
      seen[lower] = true;
      return true;
    });
    const src = (cfg.targetPerKampung !== undefined ? cfg.targetPerKampung : cur.targetPerKampung) || {};
    const targetPerKampung = {};
    kampungList.forEach(k => {
      const t = parseInt(src[k] || 0, 10);
      targetPerKampung[k] = (!isNaN(t) && t >= 0) ? t : 0;
    });
    entries.kampung_list = JSON.stringify(kampungList);
    entries.target_per_kampung = JSON.stringify(targetPerKampung);
  }

  // --- target total
  if (cfg.targetTotal !== undefined) {
    const t = parseInt(cfg.targetTotal, 10);
    if (cfg.targetTotal !== null && cfg.targetTotal !== '' && (isNaN(t) || t <= 0)) return { ok: false, message: 'Target total harus lebih dari 0' };
    entries.target_total = String((!isNaN(t) && t > 0) ? t : domain.DEFAULT_TARGET);
  }

  if (!Object.keys(entries).length) return { ok: false, message: 'Tidak ada perubahan untuk disimpan' };
  await writeConfigEntries(entries);
  invalidateVersion();
  return { ok: true, message: 'Pengaturan berhasil disimpan', data: await readConfig() };
}

async function renameKampung(oldName, newName) {
  oldName = String(oldName || '').trim();
  newName = String(newName || '').trim();
  if (!oldName || !newName) return { ok: false, message: 'Nama lama/baru wajib' };
  if (oldName === newName) return { ok: false, message: 'Nama sama' };

  const cfg = await readConfig(true);
  if (cfg.kampungList.indexOf(newName) !== -1) return { ok: false, message: 'Nama kampung baru sudah dipakai' };

  const rows = await readPendukungRows(true);
  let updated = 0;
  const colValues = [];
  for (let i = 1; i < rows.length; i++) {
    const cur8 = String(rows[i][7] == null ? '' : rows[i][7]);
    if (cur8.trim() === oldName) { colValues.push(newName); updated++; } else colValues.push(cur8);
  }
  // seluruh kolom Kampung ditulis dalam SATU permintaan (sebelumnya satu per baris → melewati kuota tulis)
  if (updated > 0) await sheets.updateColumnValues(sheets.SHEET_PENDUKUNG, 2, 8, colValues);

  const newList = cfg.kampungList.map(k => (k === oldName ? newName : k));
  const newTarget = {};
  Object.keys(cfg.targetPerKampung).forEach(k => {
    newTarget[k === oldName ? newName : k] = cfg.targetPerKampung[k];
  });
  await writeConfigEntries({ kampung_list: JSON.stringify(newList), target_per_kampung: JSON.stringify(newTarget) });

  invalidateVersion();
  return { ok: true, message: 'Kampung di-rename (' + updated + ' data diupdate)', data: await readConfig() };
}

/* ================== LOG ================== */

async function logAksi(aksi, username, ket) {
  try {
    await sheets.appendRow(sheets.SHEET_LOG, [new Date().toISOString(), aksi, username || '', ket || '']);
  } catch (e) { /* log tidak boleh menggagalkan aksi utama */ }
}

async function getLogs(limit) {
  const rows = await sheets.readSheet(sheets.SHEET_LOG);
  const logs = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!String(r[0] || '').trim()) continue;
    logs.push({
      rowNum: i + 1,
      timestamp: r[0] instanceof Date ? r[0].toISOString() : String(r[0] || ''),
      aksi: String(r[1] || ''),
      username: String(r[2] || ''),
      keterangan: String(r[3] || '')
    });
  }
  logs.reverse();
  const n = parseInt(limit, 10) || 200;
  return { ok: true, data: logs.slice(0, Math.min(Math.max(n, 1), 1000)) };
}

/* ================== HARI H PEMILIHAN ================== */

const untxt = v => String(v == null ? '' : v).replace(/^'+/, '').trim();
const validYmd = x => /^\d{4}-\d{2}-\d{2}$/.test(x) && new Date(x + 'T00:00:00Z').toISOString().slice(0, 10) === x;

/** Simpan / hapus (tanggal kosong) jadwal Hari H pemilihan di sheet Config — 1x baca, hanya tulis yang berubah. */
async function saveHariH(data) {
  data = data || {};
  const tanggal = String(data.tanggal || '').trim();
  const clear = !tanggal;
  const judul = String(data.judul || '').trim().slice(0, 80) || 'Pemilihan Kepala Desa';
  const jam = String(data.jam || '').trim();
  const lokasi = String(data.lokasi || '').trim().slice(0, 120);
  if (!clear && !validYmd(tanggal)) return { ok: false, message: 'Tanggal tidak valid' };
  if (!clear && jam && !/^([01]\d|2[0-3]):[0-5]\d$/.test(jam)) return { ok: false, message: 'Jam tidak valid (format HH:MM)' };

  const txt = v => (v ? "'" + v : '');
  const entries = clear
    ? { hari_h_tanggal: '', hari_h_jam: '', hari_h_lokasi: '', hari_h_judul: '' }
    : { hari_h_tanggal: txt(tanggal), hari_h_jam: txt(jam), hari_h_lokasi: lokasi, hari_h_judul: judul };

  await writeConfigEntries(entries);
  invalidateVersion();
  const cfg = await readConfig();
  return { ok: true, message: clear ? 'Hari H dihapus' : 'Hari H tersimpan', hariH: cfg.hariH };
}

module.exports = {
  saveHariH,
  invalidateVersion, getVersion, readConfig, getList, getDashboard,
  addPendukung, updatePendukung, deletePendukung,
  verifyWithTTD, unverifyPendukung, togglePrint, setPrintBatch,
  checkNik, scanDuplikat, countKampung, saveConfig, renameKampung,
  logAksi, getLogs
};
