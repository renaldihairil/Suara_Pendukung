/* ============================================================
 * sapaan.js — Sapaan dashboard sesuai WAKTU (pagi/siang/sore/malam)
 * dan JABATAN user (Tim Sukses / Calon Kades / umum).
 * Pesan dipilih acak dari kumpulan kalimat (berganti setiap membuka
 * Dashboard, tidak mengulang pesan terakhir).
 *
 *   Sapaan.build({ nama, jabatan, panggilan, zone, stats }) →
 *     { periode, salam, emoji, judul, pesan }
 *   Sapaan.JABATAN, Sapaan.PANGGILAN
 * ============================================================ */
(function () {
  'use strict';

  const JABATAN = { '': 'Umum', timses: 'Tim Sukses', cakades: 'Calon Kades' };
  const PANGGILAN = { '': 'Tanpa panggilan', Bapak: 'Bapak', Ibu: 'Ibu' };
  const PERIODE = {
    pagi:  { salam: 'Selamat Pagi',  emoji: '🌤️' },
    siang: { salam: 'Selamat Siang', emoji: '☀️' },
    sore:  { salam: 'Selamat Sore',  emoji: '🌇' },
    malam: { salam: 'Selamat Malam', emoji: '🌙' }
  };

  /* {P} = panggilan hormat (mis. "Bapak" — kata sapaan ditulis kapital sesuai EYD; tanpa panggilan = nama),
     {N} = nama panggilan, {total} {persen} {target} {pasti} {baru} {hari} = angka dari dashboard */
  const PESAN = {
    timses: {
      umum: [
        'Terus semangat bekerja dengan ikhlas dan cerdas.',
        'Setiap data yang Anda input adalah langkah nyata menuju kemenangan.',
        'Kerja tulus hari ini, hasil manis di hari pemilihan.',
        'Sapa warga dengan senyum, rangkul dengan hati.',
        'Kekompakan tim adalah kekuatan terbesar kita.',
        'Jaga data tetap rapi dan akurat — kepercayaan dimulai dari ketelitian.',
        'Satu dukungan yang pasti lebih berharga dari seribu janji. Mari pastikan bersama.',
        'Bekerja dengan santun, menang dengan bermartabat.',
        'Langkah kecil yang konsisten akan membawa hasil besar.',
        'Terima kasih sudah menjadi bagian dari perjuangan ini.'
      ],
      pagi: [
        'Awali hari dengan niat baik dan semangat baru.',
        'Pagi yang cerah untuk menjemput dukungan warga.',
        'Bismillah, semoga hari ini penuh berkah dan kemudahan.'
      ],
      siang: [
        'Tetap jaga stamina — jangan lupa istirahat dan makan siang.',
        'Setengah hari sudah dilalui, lanjutkan dengan semangat yang sama.',
        'Panas tak menyurutkan langkah. Tetap semangat dan jaga kesehatan.'
      ],
      sore: [
        'Saatnya merapikan hasil kerja hari ini.',
        'Sore yang baik untuk bersilaturahmi dengan warga.',
        'Sedikit lagi menuju akhir hari — tuntaskan dengan baik.'
      ],
      malam: [
        'Terima kasih atas kerja keras hari ini. Istirahatlah yang cukup.',
        'Rekap hasil hari ini, lalu siapkan langkah untuk esok.',
        'Kerja hebat hari ini. Semoga lelahnya menjadi berkah.'
      ],
      data: [
        s => s.baru > 0 ? 'Hari ini sudah ' + s.baru + ' pendukung baru tercatat. Luar biasa, terus pertahankan!' : '',
        s => s.persen > 0 && s.persen < 100 ? 'Target sudah ' + s.persen + '% tercapai. Mari kejar sisanya bersama!' : '',
        s => s.persen >= 100 ? 'Target sudah tercapai! Terus jaga dan pastikan setiap dukungan.' : '',
        s => s.hari > 0 ? 'Tinggal ' + s.hari + ' hari lagi menuju hari pemilihan. Manfaatkan setiap kesempatan.' : ''
      ]
    },
    cakades: {
      umum: [
        'Terima kasih atas kepemimpinan dan arahan {P}. Tim terus bergerak dengan semangat.',
        'Semoga {P} senantiasa diberi kesehatan dan kelancaran dalam setiap langkah.',
        'Amanah warga adalah kehormatan. Tim siap menjaganya bersama {P}.',
        'Setiap dukungan adalah amanah. Semoga perjuangan ini membawa kebaikan bagi seluruh warga.',
        'Tim sukses solid dan terus bekerja untuk {P}.',
        'Doa dan dukungan warga menyertai langkah {P}.',
        'Berikut perkembangan dukungan terkini untuk {P}.',
        'Kepercayaan warga terus tumbuh. Terima kasih atas keteladanan {P}.'
      ],
      pagi: [
        'Semoga pagi ini membawa semangat dan kabar baik untuk {P}.',
        'Selamat beraktivitas, {P}. Semoga hari ini penuh berkah.'
      ],
      siang: [
        'Semoga aktivitas {P} siang ini lancar. Jangan lupa beristirahat sejenak.',
        'Semoga {P} tetap sehat dan bersemangat di tengah padatnya kegiatan.'
      ],
      sore: [
        'Semoga hari {P} berjalan dengan baik. Berikut ringkasan perkembangan dukungan.',
        'Terima kasih atas waktu dan tenaga {P} hari ini.'
      ],
      malam: [
        'Terima kasih atas perjuangan hari ini. Selamat beristirahat, {P}.',
        'Semoga {P} beristirahat dengan tenang. Tim tetap menjaga setiap dukungan.'
      ],
      data: [
        s => s.total > 0 ? 'Alhamdulillah, sudah ' + fmt(s.total) + ' warga menyatakan dukungan — ' + s.persen + '% dari target.' : '',
        s => s.pasti > 0 ? fmt(s.pasti) + ' dukungan sudah PASTI (bertanda tangan). Terima kasih atas kepercayaan warga.' : '',
        s => s.baru > 0 ? 'Hari ini bertambah ' + s.baru + ' pendukung baru untuk {P}.' : '',
        s => s.hari > 0 ? 'Tinggal ' + s.hari + ' hari menuju hari pemilihan. Tim terus bekerja maksimal.' : ''
      ]
    },
    '': {
      umum: [
        'Kelola data pendukung dengan mudah dan cepat.',
        'Semoga hari Anda menyenangkan dan produktif.',
        'Data yang rapi membantu tim bekerja lebih tepat sasaran.'
      ],
      pagi: ['Selamat beraktivitas, semoga hari ini lancar.'],
      siang: ['Tetap semangat dan jaga kesehatan.'],
      sore: ['Semoga pekerjaan hari ini berjalan baik.'],
      malam: ['Terima kasih untuk hari ini. Selamat beristirahat.'],
      data: [
        s => s.baru > 0 ? 'Hari ini ada ' + s.baru + ' pendukung baru tercatat.' : ''
      ]
    }
  };

  function fmt(n) { return Number(n || 0).toLocaleString('id-ID'); }

  /** Jam (0–23) di zona waktu tertentu (default WITA) */
  function hourIn(zone, now) {
    try {
      const h = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: zone || 'Asia/Makassar' }).format(now || new Date());
      return parseInt(h, 10) % 24;
    } catch (e) { return (now || new Date()).getHours(); }
  }

  /** Pagi 04.00–10.59 • Siang 11.00–14.59 • Sore 15.00–17.59 • Malam 18.00–03.59 */
  function periodeOf(h) {
    if (h >= 4 && h < 11) return 'pagi';
    if (h >= 11 && h < 15) return 'siang';
    if (h >= 15 && h < 18) return 'sore';
    return 'malam';
  }

  const GELAR = /^(h|hj|haji|hajjah|drs?|dra|ir|prof|ust|ustadz|ustaz|ustadzah|kh|tgh|tg|lalu|baiq|bpk|bapak|ibu|bu|pak|sdr|sdri|mas|mbak|kak)\.?$/i;
  /** Nama panggilan: kata pertama setelah gelar/sapaan (mis. "H. Ahmad Fauzi" → "Ahmad") */
  function namaPanggilan(nama) {
    const w = String(nama || '').trim().split(/\s+/).filter(Boolean);
    while (w.length > 1 && GELAR.test(w[0].replace(/,$/, ''))) w.shift();
    const n = (w[0] || '').replace(/[.,]+$/, '');
    if (!n) return '';
    return n === n.toUpperCase() && n.length > 2 ? n.charAt(0) + n.slice(1).toLowerCase() : n;
  }

  function normJabatan(j) {
    const s = String(j || '').toLowerCase().replace(/[\s_-]+/g, '');
    if (s === 'timses' || s === 'timsukses') return 'timses';
    if (s === 'cakades' || s === 'calonkades' || s === 'calonkepaladesa' || s === 'kandidat') return 'cakades';
    return '';
  }

  function pick(arr, avoid) {
    if (!arr.length) return '';
    if (arr.length === 1) return arr[0];
    let i, tries = 0;
    do { i = Math.floor(Math.random() * arr.length); tries++; } while (arr[i] === avoid && tries < 8);
    return arr[i];
  }

  /**
   * @param o { nama, jabatan, panggilan ('Bapak'|'Ibu'|''), zone, stats:{total,target,persen,pasti,baru,hari}, avoid }
   */
  function build(o) {
    o = o || {};
    const jab = normJabatan(o.jabatan);
    const per = periodeOf(hourIn(o.zone, o.now));
    const P = o.panggilan === 'Ibu' ? 'Ibu' : o.panggilan === 'Bapak' ? 'Bapak' : (jab === 'cakades' ? 'Bapak' : '');
    const sing = P === 'Ibu' ? 'Bu' : P === 'Bapak' ? 'Pak' : '';
    const nm = namaPanggilan(o.nama) || 'Anda';
    const st = o.stats || {};
    const set = PESAN[jab];

    // kumpulan kalimat: umum + sesuai waktu + berbasis data (bobot data sedikit lebih besar bila tersedia)
    const dataMsgs = (set.data || []).map(f => f(st)).filter(Boolean);
    const pool = [].concat(set.umum, set[per] || [], set[per] || [], dataMsgs, dataMsgs);
    let pesan = pick(pool, o.avoid);
    pesan = pesan
      .replace(/\{P\}/g, P || nm)
      .replace(/\{N\}/g, nm);
    pesan = pesan.charAt(0).toUpperCase() + pesan.slice(1);

    const pr = PERIODE[per];
    const judul = pr.salam + ', ' + (sing ? sing + ' ' : '') + nm + '!';
    return { periode: per, salam: pr.salam, emoji: pr.emoji, judul, pesan, jabatan: jab };
  }

  window.Sapaan = { build, periodeOf, hourIn, namaPanggilan, normJabatan, JABATAN, PANGGILAN, PERIODE };
})();
