'use strict';
/* ============================================================
 * Parser teks hasil OCR KTP → { nik, nama, tglLahir, ... }
 * Murni (tanpa I/O) supaya mudah diuji. Strategi:
 *  - NIK: cari deretan 14–18 karakter angka/huruf-mirip-angka, koreksi
 *    salah-baca (O→0, I→1, dst), lalu VALIDASI struktur NIK
 *    (kode provinsi, tanggal lahir, bulan). Kandidat terbaik menang.
 *  - Nama: dari baris label "Nama" (satu baris / baris berikutnya);
 *    cadangan: baris huruf-kapital pertama setelah NIK sebelum TTL.
 *  - Silang-cek: tanggal lahir di NIK vs baris "Tempat/Tgl Lahir".
 * ============================================================ */

const PROV = new Set([11,12,13,14,15,16,17,18,19,21,31,32,33,34,35,36,51,52,53,61,62,63,64,65,71,72,73,74,75,76,81,82,91,92,93,94,95,96]);

const FIX = { O:'0', o:'0', D:'0', Q:'0', U:'0', I:'1', l:'1', i:'1', '|':'1', '!':'1', L:'1', Z:'2', z:'2', E:'3', A:'4', S:'5', s:'5', G:'6', b:'6', T:'7', Y:'7', B:'8', g:'9', q:'9' };

function fixDigits(s) {
  return String(s).split('').map(c => (/\d/.test(c) ? c : (FIX[c] || ''))).join('');
}

/** Periksa struktur NIK; kembalikan { valid, tgl:{dd,mm,yy,female} } */
function checkNik(nik) {
  if (!/^\d{16}$/.test(nik)) return { valid: false };
  const prov = parseInt(nik.slice(0, 2), 10);
  let dd = parseInt(nik.slice(6, 8), 10);
  const mm = parseInt(nik.slice(8, 10), 10);
  const yy = parseInt(nik.slice(10, 12), 10);
  const female = dd > 40;
  if (female) dd -= 40;
  const ok = PROV.has(prov) && dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12;
  return { valid: ok, tgl: { dd, mm, yy, female } };
}

const LABELS = /^(PROVINSI|KABUPATEN|KOTA|NIK|NAMA|TEMPAT|TGL|LAHIR|JENIS|KELAMIN|GOL|DARAH|ALAMAT|RT|RW|RT\/RW|KEL|DESA|KELURAHAN|KECAMATAN|AGAMA|STATUS|PERKAWINAN|PEKERJAAN|KEWARGANEGARAAN|BERLAKU|HINGGA|SEUMUR|HIDUP|WNI|WNA|ISLAM|KRISTEN|KATOLIK|HINDU|BUDDHA|BUDHA|KONGHUCU|KAWIN|BELUM|CERAI|LAKI|PEREMPUAN|LAKI-LAKI|PELAJAR|MAHASISWA|KARYAWAN|SWASTA|WIRASWASTA|PETANI|BURUH|PNS|TNI|POLRI)$/;

function cleanName(s) {
  let t = String(s || '')
    .replace(/[|_~`^*=<>{}\[\]\\\/0-9]/g, ' ')   // digit & simbol = noise (nama tak berisi angka)
    .replace(/[:;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // buang potongan 1 huruf di awal/akhir yang biasanya noise (mis. "I BUDI" boleh tetap jika bagian nama asli; hanya buang simbol)
  t = t.replace(/^[.,'\- ]+|[.,'\- ]+$/g, '');
  return t.toUpperCase();
}

function looksLikeName(s) {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 3 || t.length > 60) return false;
  if (!/^[A-Z][A-Z .,'\-]*$/.test(t)) return false;
  const words = t.split(/\s+/);
  // tolak baris yang seluruhnya label/keyword KTP
  if (words.every(w => LABELS.test(w.replace(/[.,]/g, '')))) return false;
  if (/(PROVINSI|KABUPATEN|TEMPAT|LAHIR|KELAMIN|ALAMAT|KEWARGANEGARAAN|PEKERJAAN|PERKAWINAN|BERLAKU)/.test(t)) return false;
  return true;
}

/* ---------- Tempat lahir, status perkawinan & alamat ---------- */

// Awal baris yang merupakan label KTP (nilai di baris berikutnya tidak boleh berupa label lain)
const LABEL_START = /^(PROVINSI|KABUPATEN|KOTA|N[I1l]K|NAMA|TEMPAT|TGL|JENIS|GOL|ALAMAT|RT\s*\/?\s*RW|KEL|DESA|KECAMATAN|AGAMA|STATUS|PEKERJAAN|KEWARGANEGARAAN|BERLAKU)\b/i;
const DATE_RE = /(\d{2})\s*[-\/.]\s*(\d{2})\s*[-\/.]\s*(\d{4})/;

/** Rapikan nilai teks KTP: buang pemisah ":" di depan, simbol noise & spasi berlebih */
function cleanValue(s) {
  return String(s || '')
    .replace(/^[\s:;.\-=]+/, '')
    .replace(/[|_~`^*<>{}\[\]\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s,.:;\-]+$/, '')
    .trim()
    .toUpperCase();
}

/**
 * Nilai sebuah label: sisa baris setelah label, atau baris berikutnya bila baris label kosong
 * (OCR sering memisah "Alamat" dan ": DS SERUNI" ke dua baris). Baris berikutnya yang berupa label lain diabaikan.
 */
function labeledValue(lines, labelRe) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(labelRe);
    if (!m) continue;
    const same = cleanValue(lines[i].slice(m[0].length));
    if (same) return same;
    const next = lines[i + 1] || '';
    if (next && !LABEL_START.test(next.replace(/^[\s:;.\-]+/, ''))) return cleanValue(next);
    return '';
  }
  return '';
}

/** Tempat lahir: teks sebelum tanggal pada baris tanggal lahir (diutamakan tanggal yang cocok dengan NIK) */
function parseTempatLahir(lines, nikTgl) {
  const pickPrefix = ln => {
    const m = ln.match(DATE_RE);
    if (!m) return '';
    let pre = ln.slice(0, m.index);
    if (pre.lastIndexOf(':') !== -1) pre = pre.slice(pre.lastIndexOf(':') + 1);
    pre = pre.replace(/TEMPAT\s*\/?\s*(TGL|TANGGAL)?\.?\s*LAHIR/i, '').replace(/[^A-Za-z .'\-]/g, ' ');
    const t = cleanValue(pre);
    if (t.length < 3 || t.length > 60 || !/[A-Z]{3}/.test(t)) return '';
    if (t.split(' ').every(w => LABELS.test(w.replace(/[.,]/g, '')))) return '';
    return t;
  };
  if (nikTgl) {
    for (const ln of lines) {
      const m = ln.match(DATE_RE);
      if (!m) continue;
      const cocok = parseInt(m[1], 10) === nikTgl.dd && parseInt(m[2], 10) === nikTgl.mm && parseInt(m[3].slice(2), 10) === nikTgl.yy;
      if (cocok) { const t = pickPrefix(ln); if (t) return t; }
    }
  }
  const labeled = lines.find(ln => /TEMPAT|LAHIR/i.test(ln) && DATE_RE.test(ln));
  return labeled ? pickPrefix(labeled) : '';
}

/** Status perkawinan dari kata kunci KTP ("PERKAWINAN" di label tidak ikut terhitung) */
function parseStatusKawin(text) {
  const t = String(text || '').toUpperCase();
  if (/BELUM\s*KAWIN/.test(t)) return 'Belum Kawin';
  if (/CERAI\s*HIDUP/.test(t)) return 'Cerai Hidup';
  if (/CERAI\s*MATI/.test(t)) return 'Cerai Mati';
  if (/(^|[^A-Z])KAWIN([^A-Z]|$)/.test(t)) return 'Kawin';
  return '';
}

/** Alamat: jalan/dusun + RT/RW + Kel/Desa + Kecamatan (bagian yang tidak terbaca dilewati) */
function parseAlamat(lines) {
  const jalan = labeledValue(lines, /^\s*A\s*[l1I]\s*a\s*m\s*a\s*t\b/i);
  if (!jalan || LABEL_START.test(jalan) || !/[A-Z]{2}/.test(jalan)) return '';
  const parts = [jalan];
  const rtLine = lines.find(ln => /^\s*RT\s*\/?\s*RW\b/i.test(ln));
  const rtSrc = rtLine ? rtLine + ' ' + (lines[lines.indexOf(rtLine) + 1] || '') : '';
  const rt = rtSrc.match(/RW\s*[:;.\-]?\s*(?:[^\d\n]*?)(\d{1,3})\s*\/\s*(\d{1,3})/i);
  if (rt) parts.push('RT/RW ' + rt[1].padStart(3, '0') + '/' + rt[2].padStart(3, '0'));
  const desa = labeledValue(lines, /^\s*(KEL\s*\/?\s*DESA|KELURAHAN|DESA)\b/i);
  if (desa && /[A-Z]{3}/.test(desa) && !LABEL_START.test(desa)) parts.push('KEL/DESA ' + desa);
  const kec = labeledValue(lines, /^\s*KECAMATAN\b/i);
  if (kec && /[A-Z]{3}/.test(kec) && !LABEL_START.test(kec)) parts.push('KEC. ' + kec);
  return parts.join(', ').slice(0, 300);
}

function parseKtpText(rawText) {
  const text = String(rawText || '');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = { nik: '', nikValid: false, nama: '', tglLahir: '', jenisKelamin: '', cocokTgl: false, confidence: 'low', catatan: [] };

  /* ---------- NIK ---------- */
  const cands = [];
  const addCand = (digits, bonus) => {
    if (!digits) return;
    if (digits.length === 16) {
      const c = checkNik(digits);
      cands.push({ nik: digits, valid: c.valid, tgl: c.tgl, score: (c.valid ? 100 : 10) + bonus });
    }
    // panjang selain 16 sengaja DITOLAK: menebak/memperbaiki digit bisa menghasilkan NIK salah yang tetap tampak valid
  };
  lines.forEach((ln, idx) => {
    const hasNikLabel = /N[I1l]K/i.test(ln);
    // segmen angka/huruf-mirip-angka (spasi di dalam NIK yang terpecah ikut disatukan)
    const re = /[0-9OoDQUIl|!LZzEASsGbTYBgq][0-9OoDQUIl|!LZzEASsGbTYBgq \-]{12,24}[0-9OoDQUIl|!LZzEASsGbTYBgq]/g;
    let m;
    while ((m = re.exec(ln))) {
      const seg = m[0].replace(/[ \-]/g, '');
      const digitCount = (seg.match(/\d/g) || []).length;
      if (digitCount < 9) continue;                 // bukan deretan angka (mis. kata biasa)
      addCand(fixDigits(seg), (hasNikLabel ? 15 : 0) + (digitCount === seg.length ? 10 : 0) + (idx < 8 ? 5 : 0));
    }
    // kasus "NIK : <digit tergabung di baris lain>" sudah tertangani oleh loop semua baris
  });
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (best) {
    out.nik = best.nik;
    out.nikValid = best.valid;
  }

  /* ---------- Nama ---------- */
  let nama = '';
  for (let i = 0; i < lines.length && !nama; i++) {
    const ln = lines[i];
    const m = ln.match(/^\s*N\s*[aA4]\s*[mM]\s*[aA4]\b\s*[:;.\-]?\s*(.*)$/);
    if (!m) continue;
    const same = cleanName(m[1]);
    if (looksLikeName(same)) { nama = same; break; }
    // nilai di baris berikutnya (":" atau langsung)
    for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
      const nx = cleanName(lines[j]);
      if (looksLikeName(nx)) { nama = nx; break; }
      if (/LAHIR|TEMPAT/i.test(lines[j])) break;
    }
  }
  if (!nama && best) {
    // cadangan: baris-baris nilai setelah NIK; pilih baris huruf-kapital pertama sebelum tanggal lahir / kata label
    const nikLineIdx = lines.findIndex(l => fixDigits(l.replace(/[ \-]/g, '')).includes(best.nik));
    for (let j = Math.max(0, nikLineIdx + 1); j < lines.length; j++) {
      if (/\d{2}[-\/ ]\d{2}[-\/ ]\d{4}/.test(lines[j])) break;
      const nx = cleanName(lines[j]);
      if (looksLikeName(nx) && nx.split(' ').some(w => w.length >= 3)) { nama = nx; break; }
    }
  }
  out.nama = nama;

  /* ---------- Tanggal lahir & JK (silang-cek) ---------- */
  const tglM = text.match(/(\d{2})\s*[-\/.]\s*(\d{2})\s*[-\/.]\s*(\d{4})/);
  if (tglM) out.tglLahir = `${tglM[1]}-${tglM[2]}-${tglM[3]}`;
  if (/PEREMPUAN/i.test(text)) out.jenisKelamin = 'PEREMPUAN';
  else if (/LAKI/i.test(text)) out.jenisKelamin = 'LAKI-LAKI';
  if (best && best.valid && best.tgl && tglM) {
    const dd = parseInt(tglM[1], 10), mm = parseInt(tglM[2], 10), yy = parseInt(tglM[3].slice(2), 10);
    out.cocokTgl = dd === best.tgl.dd && mm === best.tgl.mm && yy === best.tgl.yy;
    if (!out.cocokTgl) out.catatan.push('Tanggal lahir di KTP tidak cocok dengan isi NIK, mohon cek ulang NIK');
  }

  /* ---------- Tempat lahir, status perkawinan, alamat (hanya bila terbaca jelas) ---------- */
  out.tempatLahir = parseTempatLahir(lines, best && best.valid ? best.tgl : null);
  out.statusPerkawinan = parseStatusKawin(text);
  out.alamat = parseAlamat(lines);

  /* ---------- Keyakinan ---------- */
  if (out.nik && out.nikValid && out.nama && (out.cocokTgl || !tglM)) out.confidence = 'high';
  else if (out.nik && out.nikValid) out.confidence = 'medium';
  else out.confidence = 'low';
  if (out.nik && !out.nikValid) out.catatan.push('Struktur NIK tidak wajar (kode wilayah/tanggal), kemungkinan salah baca');
  return out;
}

module.exports = { parseKtpText, checkNik, fixDigits, parseTempatLahir, parseStatusKawin, parseAlamat };
