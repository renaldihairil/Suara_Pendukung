'use strict';
const { photoUrl } = require('./photourl');
/* ============================================================
 * Logika domain — port 1:1 dari Code.gs (parseNIK, normRT,
 * normalisasi, anti-duplikat NIK).
 * ============================================================ */

const RT_LIST = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', 'UMUM'];
const RT_UMUM = 'UMUM';
const DEFAULT_KAMPUNG_LIST = ['Sasak', 'Mandar', 'Barantapen Asri', 'Dames'];
const DEFAULT_TARGET = 500;

function normRT(v) {
  if (v == null) return '001';
  let s = String(v).trim();
  s = s.replace(/^['"]+/, '').replace(/['"]+$/, '');
  if (!s) return '001';
  const lower = s.toLowerCase();
  if (lower === 'umum' || lower === 'u' || lower === 'um') return RT_UMUM;
  if (/^\d{1,2}$/.test(s)) return s.padStart(3, '0');
  if (/^\d{3,}$/.test(s)) return s.slice(-3);
  const n = parseInt(s, 10);
  if (!isNaN(n) && n > 0 && n < 1000) return String(n).padStart(3, '0');
  return s;
}

function isValidRT(rt) {
  return RT_LIST.indexOf(rt) !== -1;
}

function normVerified(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'ya' || s === 'yes' || s === 'verified' || s === 'pasti') return true;
  }
  return false;
}

function normBool(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'ya' || s === 'yes') return true;
  }
  return false;
}

function parseNIK(nik) {
  nik = String(nik || '').trim();
  if (!/^\d{16}$/.test(nik)) return { valid: false, msg: 'NIK harus 16 digit angka' };

  let dd = parseInt(nik.substring(6, 8), 10);
  const mm = parseInt(nik.substring(8, 10), 10);
  const yy = parseInt(nik.substring(10, 12), 10);

  let jk = 'Laki-laki';
  if (dd > 40) { jk = 'Perempuan'; dd = dd - 40; }

  const nowYY = new Date().getFullYear() % 100;
  const tahun = (yy > nowYY) ? 1900 + yy : 2000 + yy;

  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
    return { valid: false, msg: 'NIK tidak valid (tanggal/bulan)' };
  }

  const tglLahir = new Date(tahun, mm - 1, dd);
  const today = new Date();
  let usia = today.getFullYear() - tglLahir.getFullYear();
  const mDiff = today.getMonth() - tglLahir.getMonth();
  if (mDiff < 0 || (mDiff === 0 && today.getDate() < tglLahir.getDate())) usia--;

  const pad = n => String(n).padStart(2, '0');
  return {
    valid: true,
    jenisKelamin: jk,
    tanggalLahir: tahun + '-' + pad(mm) + '-' + pad(dd),
    usia
  };
}

/* ================== CONFIG ================== */

/** Jadwal Hari H pemilihan dari Config (null bila belum diisi). */
function parseHariH(cfg) {
  const un = v => String(v == null ? '' : v).replace(/^'+/, '').trim();
  const tanggal = un(cfg.hari_h_tanggal);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) return null;
  return {
    tanggal,
    judul: un(cfg.hari_h_judul) || 'Pemilihan Kepala Desa',
    jam: un(cfg.hari_h_jam),
    lokasi: un(cfg.hari_h_lokasi)
  };
}

function parseConfigFromRows(rows) {
  const cfg = {};
  for (let i = 1; i < rows.length; i++) {
    const k = String(rows[i][0] || '').trim();
    const v = rows[i][1];
    if (k) cfg[k] = v;
  }

  let kampungList = DEFAULT_KAMPUNG_LIST.slice();
  if (cfg.kampung_list) {
    try {
      const parsed = JSON.parse(String(cfg.kampung_list));
      if (Array.isArray(parsed) && parsed.length > 0) {
        kampungList = parsed.map(x => String(x).trim()).filter(x => x);
      }
    } catch (e) { /* pakai default */ }
  }

  let targetPerKampung = {};
  if (cfg.target_per_kampung) {
    try {
      const parsed = JSON.parse(String(cfg.target_per_kampung));
      if (parsed && typeof parsed === 'object') targetPerKampung = parsed;
    } catch (e) { /* kosong */ }
  }

  let targetTotal = DEFAULT_TARGET;
  if (cfg.target_total != null && cfg.target_total !== '') {
    const n = parseInt(cfg.target_total, 10);
    if (!isNaN(n) && n > 0) targetTotal = n;
  } else {
    let sum = 0;
    kampungList.forEach(k => { sum += parseInt(targetPerKampung[k] || 0, 10); });
    if (sum > 0) targetTotal = sum;
  }

  return {
    kampungList,
    targetPerKampung,
    targetTotal,
    namaPilkades: String(cfg.nama_pilkades || 'Pilkades Seruni Mumbul 2026'),
    namaKandidat: String(cfg.nama_kandidat || 'Pak Muhaimin (Pak Emen)'),
    hariH: parseHariH(cfg)
  };
}

/* ================== BARIS PENDUKUNG ================== */
// Kolom sheet Pendukung (A..O):
// 0 ID | 1 Timestamp | 2 Nama | 3 NIK | 4 JK | 5 TglLahir | 6 Usia |
// 7 Kampung | 8 RT | 9 FotoKTP | 10 FotoKTPId | 11 Verified |
// 12 FotoTTD | 13 FotoTTDId | 14 Dicetak

function rowToPendukung(r, rowNum) {
  if (!r || !String(r[0] || '').trim()) return null;
  const fotoId = String(r[10] || '').trim();
  const ttdId = String(r[13] || '').trim();
  // NIK dari Sheets bisa berupa number (UNFORMATTED_VALUE) → 16 digit besar
  // di JS presisinya turun (mis. ...8E+15). Konversi aman lewat BigInt.
  let nik = r[3] == null ? '' : String(r[3]).trim();
  if (typeof r[3] === 'number') nik = BigInt(Math.round(r[3])).toString();
  nik = nik.replace(/\.0+$/, '').replace(/[^0-9]/g, '') || nik;
  return {
    rowNum,
    id: String(r[0]),
    timestamp: serializeDateValue(r[1]),
    nama: String(r[2] || ''),
    nik,
    jenisKelamin: String(r[4] || ''),
    tanggalLahir: fmtDate(r[5]),
    usia: typeof r[6] === 'number' ? Math.round(r[6]) : (parseInt(r[6], 10) || 0),
    kampung: String(r[7] || ''),
    rt: normRT(r[8]),
    fotoKTP: photoUrl(fotoId),
    fotoKTPId: fotoId,
    fotoTTD: photoUrl(ttdId),
    fotoTTDId: ttdId,
    verified: normVerified(r[11]),
    dicetak: normBool(r[14]),
    // cara verifikasi: 'digital' (tanda tangan di layar) | 'foto' (fotokopi KTP ber-TTD; data lama tanpa kolom = foto)
    metodeTTD: ttdId ? (String(r[15] || '').trim().toLowerCase() === 'digital' ? 'digital' : 'foto') : ''
  };
}

/** Serial number Sheets (hari sejak 1899-12-30) atau string/Date → ISO string. */
function serializeDateValue(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') {
    const ms = Math.round((v - 25569) * 86400 * 1000); // 25569 hari = 1970-01-01
    return new Date(ms).toISOString();
  }
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function fmtDate(d) {
  if (!d) return '';
  if (typeof d === 'number') {
    const ms = Math.round((d - 25569) * 86400 * 1000);
    const dt = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
  }
  if (d instanceof Date && !isNaN(d.getTime())) {
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  return String(d);
}

/** Cari entri duplikat NIK. rows = isi sheet Pendukung. */
function findDuplikatNIK(rows, nik, excludeId) {
  const results = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const id = String(r[0] || '');
    if (!id) continue;
    if (excludeId && id === String(excludeId)) continue;
    if (String(r[3] || '').trim() === String(nik).trim()) {
      results.push({
        id,
        nama: String(r[2] || ''),
        nik: String(r[3] || ''),
        kampung: String(r[7] || ''),
        rt: normRT(r[8])
      });
    }
  }
  return results;
}

function cfgHashOf(cfg) {
  return cfg.kampungList.join('|') + '|' + cfg.targetTotal + '|' + cfg.namaPilkades + '|' + cfg.namaKandidat + '|' + JSON.stringify(cfg.hariH || null);
}

module.exports = {
  RT_LIST, RT_UMUM, DEFAULT_KAMPUNG_LIST, DEFAULT_TARGET,
  normRT, isValidRT, normVerified, normBool, parseNIK, fmtDate,
  parseConfigFromRows, rowToPendukung, findDuplikatNIK, cfgHashOf
};
