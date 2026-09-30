/* ============================================================
 * agenda.js — Agenda & Pengingat
 *  - Banner hitung mundur Hari H + kartu "Agenda Mendatang" di dashboard
 *  - Manajemen agenda (hari pemilihan, kunjungan, rapat, dll.) dan
 *    pengaturan pengingat harian di halaman Pengaturan (admin)
 * Bergantung pada window.__app (app.js) dan google.script.run.
 * ============================================================ */
(function () {
  'use strict';
  const A = window.__app || {};
  const $ = A.$ || (id => document.getElementById(id));
  const esc = A.esc || (s => String(s == null ? '' : s));
  const toast = A.toast || (() => {});
  const ICONS = A.ICONS || {};
  const state = A.state || {};

  const CACHE_MS = 60 * 1000;
  const G = { loaded: false, at: 0, data: [], countdown: null, settings: { enabled: true }, today: '', pushEnabled: false, loading: false, waiters: [] };

  const JENIS = {
    pemilihan: { label: 'Hari Pemilihan', tone: 'navy', icon: '🗳️' },
    kunjungan: { label: 'Kunjungan', tone: 'green', icon: '🤝' },
    rapat:     { label: 'Rapat', tone: 'blue', icon: '👥' },
    lainnya:   { label: 'Lainnya', tone: 'slate', icon: '📌' }
  };

  const rpc = (fn, params) => new Promise((resolve, reject) => {
    google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[fn](params || {});
  });

  /* ---------------- util tanggal (zona WIB dari server) ---------------- */
  const dayNum = ymd => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN; };
  const fmtLong = ymd => new Date(dayNum(ymd) * 86400000).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const fmtDay = ymd => new Date(dayNum(ymd) * 86400000).toLocaleDateString('id-ID', { day: 'numeric', timeZone: 'UTC' });
  const fmtMon = ymd => new Date(dayNum(ymd) * 86400000).toLocaleDateString('id-ID', { month: 'short', timeZone: 'UTC' });
  const dayLabel = d => d < 0 ? 'Selesai' : d === 0 ? 'Hari ini' : d === 1 ? 'Besok' : d + ' hari lagi';

  /* ---------------- data ---------------- */
  function load(cb, force) {
    const fresh = G.loaded && Date.now() - G.at < CACHE_MS;
    if (fresh && !force) { cb && cb(G); return; }
    if (cb) G.waiters.push(cb);
    if (G.loading) return;
    G.loading = true;
    rpc('apiGetAgenda').then(r => {
      if (r && r.ok) {
        G.data = r.data || []; G.countdown = r.countdown || null; G.settings = r.settings || { enabled: true };
        G.today = r.today || ''; G.pushEnabled = !!r.pushEnabled; G.timezone = (r.timezone === 'Asia/Jakarta' ? 'WIB' : r.timezone) || 'WIB'; G.loaded = true; G.at = Date.now();
      }
    }).catch(() => {}).then(() => {
      G.loading = false;
      const w = G.waiters; G.waiters = [];
      w.forEach(fn => { try { fn(G); } catch (e) { console.error(e); } });
    });
  }
  const admin = () => !!(A.isAdmin && A.isAdmin());

  /* ============================================================ */
  /* DASHBOARD: banner Hari H + agenda mendatang                   */
  /* ============================================================ */
  function bannerHtml() {
    const c = G.countdown;
    if (!c) {
      if (!admin()) return '';
      return '<section class="hh-banner hh-empty">' +
        '<div class="hh-emoji">🗳️</div>' +
        '<div class="hh-body"><div class="hh-kicker">HARI PEMILIHAN</div><div class="hh-title">Tetapkan tanggal Hari H pemilihan</div>' +
        '<div class="hh-msg">Dengan tanggal Hari H, aplikasi mengirim hitung mundur penyemangat setiap pagi ke seluruh tim.</div></div>' +
        '<button type="button" class="hh-btn" id="hhSet">Atur sekarang</button></section>';
    }
    const d = c.days;
    let big, unit;
    if (d < 0) { big = '✔'; unit = 'Selesai'; }
    else if (d === 0) { big = 'H'; unit = 'HARI INI!'; }
    else if (d === 1) { big = '1'; unit = 'hari lagi — besok!'; }
    else { big = String(d); unit = 'hari lagi'; }
    return '<section class="hh-banner' + (d <= 0 ? ' hh-today' : d <= 7 ? ' hh-soon' : '') + '">' +
      '<div class="hh-count"><div class="hh-num">' + esc(big) + '</div><div class="hh-unit">' + esc(unit) + '</div></div>' +
      '<div class="hh-body">' +
        '<div class="hh-kicker">🗳️ ' + esc((c.judul || 'HARI PEMILIHAN').toUpperCase()) + '</div>' +
        '<div class="hh-title">' + esc(c.tanggalPanjang) + (c.jam ? ' • ' + esc(c.jam) + ' WIB' : '') + '</div>' +
        (c.lokasi ? '<div class="hh-loc">📍 ' + esc(c.lokasi) + '</div>' : '') +
        '<div class="hh-msg">' + esc(c.message) + '</div>' +
      '</div>' +
      (admin() ? '<button type="button" class="hh-link" id="hhManage">Kelola agenda ' + (ICONS.arrowRight || '→') + '</button>' : '') +
    '</section>';
  }

  function dashItemHtml(a) {
    const j = JENIS[a.jenis] || JENIS.lainnya;
    return '<div class="ag-item">' +
      '<div class="ag-date tone-' + j.tone + '"><b>' + esc(fmtDay(a.tanggal)) + '</b><span>' + esc(fmtMon(a.tanggal)) + '</span></div>' +
      '<div class="ag-info">' +
        '<div class="ag-title">' + esc(a.judul) + '</div>' +
        '<div class="ag-meta">' + (a.jam ? '🕒 ' + esc(a.jam) + ' WIB' : 'Sepanjang hari') + (a.lokasi ? ' • 📍 ' + esc(a.lokasi) : '') + '</div>' +
        (a.catatan ? '<div class="ag-note">' + esc(a.catatan) + '</div>' : '') +
      '</div>' +
      '<div class="ag-side"><span class="ag-kind kind-' + j.tone + '">' + esc(j.label) + '</span><span class="ag-when' + (a.days <= 1 ? ' soon' : '') + '">' + esc(dayLabel(a.days)) + '</span></div>' +
    '</div>';
  }

  function agendaCardHtml() {
    const up = G.data.filter(a => a.days >= 0).slice(0, 6);
    return '<div class="card-head"><div class="card-title"><span class="ct-ico">' + (ICONS.calendar || '') + '</span>Agenda Mendatang</div>' +
      (admin() ? '<button class="card-link" id="agAdd" type="button">+ Tambah agenda</button>' : '') + '</div>' +
      (up.length
        ? '<div class="ag-list">' + up.map(dashItemHtml).join('') + '</div>'
        : '<div class="act-empty">Belum ada agenda mendatang.' + (admin() ? ' Tambahkan jadwal kunjungan, rapat, atau hari pemilihan.' : '') + '</div>');
  }

  function mountDashboard(root) {
    const b = root.querySelector('#agendaBanner');
    const c = root.querySelector('#agendaCard');
    const paint = () => {
      if (b && b.isConnected) { b.innerHTML = bannerHtml(); bindBanner(b); }
      if (c && c.isConnected) { c.innerHTML = agendaCardHtml(); const add = c.querySelector('#agAdd'); if (add) add.addEventListener('click', () => openModal(null)); }
    };
    paint();          // tampilkan cache dulu (jika ada)
    load(paint);      // lalu segarkan
  }

  function bindBanner(b) {
    const set = b.querySelector('#hhSet');
    if (set) set.addEventListener('click', () => { A.setPage('pengaturan'); setTimeout(() => openModal(null, 'pemilihan'), 600); });
    const man = b.querySelector('#hhManage');
    if (man) man.addEventListener('click', () => A.setPage('pengaturan'));
  }

  /* ============================================================ */
  /* PENGATURAN (admin): agenda + pengingat                        */
  /* ============================================================ */
  function switchHtml(id, on, label, sub) {
    return '<div class="rm-row"><div class="rm-txt"><b>' + label + '</b><span>' + sub + '</span></div>' +
      '<button type="button" class="nt-switch' + (on ? ' on' : '') + '" id="' + id + '" role="switch" aria-checked="' + !!on + '"><i></i></button></div>';
  }

  function listRowHtml(a) {
    const j = JENIS[a.jenis] || JENIS.lainnya;
    const past = a.days < 0;
    return '<div class="ag-row' + (past ? ' past' : '') + '" data-agid="' + esc(a.id) + '">' +
      '<div class="ag-date tone-' + j.tone + '"><b>' + esc(fmtDay(a.tanggal)) + '</b><span>' + esc(fmtMon(a.tanggal)) + '</span></div>' +
      '<div class="ag-info"><div class="ag-title">' + esc(a.judul) + ' <span class="ag-kind kind-' + j.tone + '">' + esc(j.label) + '</span></div>' +
      '<div class="ag-meta">' + esc(fmtLong(a.tanggal)) + (a.jam ? ' • ' + esc(a.jam) + ' WIB' : '') + (a.lokasi ? ' • ' + esc(a.lokasi) : '') + '</div></div>' +
      '<span class="ag-when' + (a.days >= 0 && a.days <= 1 ? ' soon' : '') + '">' + esc(dayLabel(a.days)) + '</span>' +
      '<div class="cfg-kk-actions"><button class="cfg-kk-btn edit" data-agedit="' + esc(a.id) + '" title="Edit" type="button">' + (ICONS.edit || '✎') + '</button>' +
      '<button class="cfg-kk-btn del" data-agdel="' + esc(a.id) + '" title="Hapus" type="button">' + (ICONS.trash || '🗑') + '</button></div>' +
    '</div>';
  }

  function settingsHtml() {
    const s = G.settings || {};
    const upcoming = G.data.filter(a => a.days >= 0);
    const past = G.data.filter(a => a.days < 0).reverse();
    const pushNote = G.pushEnabled ? '' : '<div class="cfg-info warn">' + (ICONS.info || '') + '<div>Notifikasi push belum aktif di server (kunci VAPID belum diisi). Pengingat tetap muncul di lonceng aplikasi.</div></div>';
    return '<div class="cfg-section" id="agendaSection">' +
      '<div class="cfg-section-head"><div class="cfg-section-ico">' + (ICONS.calendar || '') + '</div>' +
        '<div><div class="cfg-section-title">Agenda &amp; Hari H Pemilihan</div><div class="cfg-section-sub">Jadwal pemilihan, kunjungan, dan rapat</div></div>' +
        '<button class="cfg-kk-btn edit" id="agNew" type="button" style="width:auto;padding:0 12px;height:36px;border-radius:10px">' + (ICONS.plus || '+') + ' Tambah</button></div>' +
      (G.countdown ? '' : '<div class="cfg-info warn">' + (ICONS.info || '') + '<div>Belum ada agenda <b>Hari Pemilihan</b>. Tambahkan agar hitung mundur harian aktif. <button type="button" class="nt-link-btn" id="agSetH" style="margin:0 0 0 6px">Tetapkan Hari H</button></div></div>') +
      (upcoming.length ? '<div class="ag-rows">' + upcoming.map(listRowHtml).join('') + '</div>' : '<div class="cfg-empty"><div class="ico">🗓️</div><p>Belum ada agenda mendatang.</p></div>') +
      (past.length ? '<details class="ag-past"><summary>Agenda yang sudah lewat (' + past.length + ')</summary><div class="ag-rows">' + past.map(listRowHtml).join('') + '</div></details>' : '') +
    '</div>' +

    '<div class="cfg-section" id="reminderSection">' +
      '<div class="cfg-section-head"><div class="cfg-section-ico">' + (ICONS.bell || '🔔') + '</div>' +
        '<div><div class="cfg-section-title">Pengingat Otomatis</div><div class="cfg-section-sub">Notifikasi penyemangat &amp; hitung mundur ke seluruh tim</div></div></div>' +
      switchHtml('rmEnabled', s.enabled !== false, 'Aktifkan pengingat', 'Kirim notifikasi harian otomatis ke semua user') +
      '<div class="rm-row"><div class="rm-txt"><b>Jam pengingat</b><span>Waktu kirim setiap hari (zona ' + esc(G.timezone || 'WIB') + ')</span></div>' +
        '<input type="time" class="form-input rm-time" id="rmTime" value="' + esc(s.time || '06:00') + '"></div>' +
      switchHtml('rmCountdown', s.countdown !== false, 'Hitung mundur Hari H', 'Tiap pagi: “12 hari lagi menuju pemilihan” + semangat & progres suara PASTI') +
      switchHtml('rmAgenda', s.agendaReminders !== false, 'Ingatkan agenda lain', 'Kunjungan / rapat diingatkan H-1 dan di hari-H agenda') +
      pushNote +
      '<div class="rm-actions">' +
        '<button type="button" class="btn btn-primary" id="rmSave">' + (ICONS.save || '') + ' Simpan Pengingat</button>' +
        '<button type="button" class="btn btn-outline" id="rmTest">Kirim contoh ke saya</button>' +
        '<button type="button" class="btn btn-outline" id="rmNow">Kirim pengingat hari ini sekarang</button>' +
      '</div>' +
      '<div class="rm-preview" id="rmPreview" style="display:none"></div>' +
    '</div>';
  }

  function mountSettings(pageRoot) {
    if (!admin() || !pageRoot) return;
    let box = pageRoot.querySelector('#agendaMount');
    if (!box) {
      box = document.createElement('div');
      box.id = 'agendaMount';
      const bar = pageRoot.querySelector('.cfg-save-bar');
      if (bar) pageRoot.insertBefore(box, bar); else pageRoot.appendChild(box);
    }
    const paint = () => { if (box.isConnected) { box.innerHTML = settingsHtml(); bindSettings(box); } };
    if (G.loaded) paint();
    else box.innerHTML = '<div class="cfg-section"><div class="page-loading" style="padding:30px"><div class="spinner"></div><p>Memuat agenda…</p></div></div>';
    load(paint, true);
  }

  function bindSettings(box) {
    const on = (sel, fn) => box.querySelectorAll(sel).forEach(el => el.addEventListener('click', () => fn(el)));
    on('#agNew', () => openModal(null));
    on('#agSetH', () => openModal(null, 'pemilihan'));
    on('[data-agedit]', el => { const a = G.data.find(x => x.id === el.getAttribute('data-agedit')); if (a) openModal(a); });
    on('[data-agdel]', el => { const a = G.data.find(x => x.id === el.getAttribute('data-agdel')); if (a) confirmDelete(a); });
    box.querySelectorAll('.nt-switch').forEach(sw => sw.addEventListener('click', () => {
      const v = !sw.classList.contains('on');
      sw.classList.toggle('on', v); sw.setAttribute('aria-checked', v);
    }));
    const val = id => { const el = box.querySelector('#' + id); return el ? el.classList.contains('on') : true; };
    const collect = () => ({ enabled: val('rmEnabled'), countdown: val('rmCountdown'), agendaReminders: val('rmAgenda'), time: box.querySelector('#rmTime').value });

    const save = box.querySelector('#rmSave');
    if (save) save.addEventListener('click', async () => {
      const s = collect();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) { toast('Isi jam pengingat dengan benar', 'error'); return; }
      save.disabled = true;
      try {
        const r = await rpc('apiSaveReminderSettings', { settings: s });
        if (r && r.ok) { G.settings = r.settings; toast('✅ Pengingat tersimpan — kirim tiap ' + r.settings.time + ' WIB', 'success'); }
        else toast('❌ ' + ((r && r.message) || 'Gagal menyimpan'), 'error');
      } catch (e) { toast('Gagal: ' + e.message, 'error'); }
      save.disabled = false;
    });

    const test = box.querySelector('#rmTest');
    if (test) test.addEventListener('click', async () => {
      test.disabled = true;
      try {
        const r = await rpc('apiReminderTest');
        const pv = box.querySelector('#rmPreview');
        if (r && r.ok) {
          pv.style.display = 'flex';
          pv.innerHTML = '<b>' + esc(r.title) + '</b><span>' + esc(r.message) + '</span><em>' +
            (r.pushed ? 'Push terkirim ke ' + r.pushed + ' perangkat Anda.' : 'Contoh tampilan pesan (aktifkan push di halaman Akun untuk menerimanya di perangkat).') + '</em>';
          toast(r.pushed ? '📨 Contoh dikirim ke perangkat Anda' : 'Contoh pesan ditampilkan di bawah', 'success');
        } else toast('❌ ' + ((r && r.message) || 'Gagal'), 'error');
      } catch (e) { toast('Gagal: ' + e.message, 'error'); }
      test.disabled = false;
    });

    const now = box.querySelector('#rmNow');
    if (now) now.addEventListener('click', () => {
      confirmBox('Kirim Pengingat Sekarang?', 'Pengingat hari ini (hitung mundur & agenda H-1/hari-H) akan langsung dikirim ke <b>semua user</b> jika belum terkirim hari ini.', 'Ya, Kirim', async () => {
        try {
          const r = await rpc('apiRunReminders');
          toast(r && r.ok ? '📨 ' + r.message : '❌ ' + ((r && r.message) || 'Gagal'), r && r.ok ? 'success' : 'error');
        } catch (e) { toast('Gagal: ' + e.message, 'error'); }
      });
    });
  }

  /* ---------------- konfirmasi (memakai modalConfirm bawaan) ---------------- */
  function confirmBox(title, html, yes, cb) {
    $('confirmTitle').textContent = title;
    $('confirmMsg').innerHTML = html;
    $('confirmYes').textContent = yes;
    state.confirmCb = () => { $('modalConfirm').classList.remove('show'); state.confirmCb = null; cb(); };
    $('modalConfirm').classList.add('show');
  }

  function confirmDelete(a) {
    confirmBox('Hapus Agenda?', 'Agenda <b>' + esc(a.judul) + '</b> (' + esc(fmtLong(a.tanggal)) + ') akan dihapus dan seluruh user diberi tahu.', 'Ya, Hapus', async () => {
      try {
        const r = await rpc('apiDeleteAgenda', { id: a.id });
        if (r && r.ok) { toast('🗑️ Agenda dihapus', 'success'); refreshAll(); }
        else toast('❌ ' + ((r && r.message) || 'Gagal'), 'error');
      } catch (e) { toast('Gagal: ' + e.message, 'error'); }
    });
  }

  /* ---------------- modal tambah / edit ---------------- */
  function openModal(a, presetJenis) {
    const m = $('modalAgenda');
    if (!m) return;
    const isEdit = !!(a && a.id);
    const today = G.today || new Date().toISOString().slice(0, 10);
    $('agTitle').textContent = isEdit ? 'Edit Agenda' : 'Tambah Agenda';
    $('agJudul').value = isEdit ? a.judul : (presetJenis === 'pemilihan' ? 'Pemilihan Kepala Desa' : '');
    $('agJenis').value = isEdit ? a.jenis : (presetJenis || 'kunjungan');
    $('agTanggal').value = isEdit ? a.tanggal : '';
    $('agTanggal').min = '';
    $('agJam').value = isEdit ? (a.jam || '') : '';
    $('agLokasi').value = isEdit ? (a.lokasi || '') : '';
    $('agCatatan').value = isEdit ? (a.catatan || '') : '';
    $('agErr').textContent = '';
    m.dataset.id = isEdit ? a.id : '';
    m.classList.add('show');
    setTimeout(() => $('agJudul').focus(), 50);
    void today;
  }
  function closeModal() { const m = $('modalAgenda'); if (m) m.classList.remove('show'); }

  async function submitModal() {
    const m = $('modalAgenda');
    const agenda = {
      id: m.dataset.id || '',
      judul: $('agJudul').value.trim(), jenis: $('agJenis').value, tanggal: $('agTanggal').value,
      jam: $('agJam').value, lokasi: $('agLokasi').value.trim(), catatan: $('agCatatan').value.trim()
    };
    if (!agenda.judul) { $('agErr').textContent = 'Judul wajib diisi'; $('agJudul').focus(); return; }
    if (!agenda.tanggal) { $('agErr').textContent = 'Pilih tanggal'; $('agTanggal').focus(); return; }
    const btn = $('agSave');
    btn.disabled = true;
    try {
      const r = await rpc('apiSaveAgenda', { agenda });
      if (r && r.ok) {
        closeModal();
        toast(r.isNew ? '✅ Agenda ditambahkan & tim diberi tahu' : '✅ Agenda diperbarui & tim diberi tahu', 'success');
        refreshAll();
      } else $('agErr').textContent = (r && r.message) || 'Gagal menyimpan';
    } catch (e) { $('agErr').textContent = 'Gagal: ' + e.message; }
    btn.disabled = false;
  }

  // muat ulang agenda lalu segarkan tampilan yang sedang terbuka
  function refreshAll() {
    load(() => {
      const box = document.getElementById('agendaMount');
      if (box && box.isConnected) { box.innerHTML = settingsHtml(); bindSettings(box); }
      const c = $('appContent');
      if (c && state.page === 'dashboard') mountDashboard(c);
    }, true);
    if (window.__notif) setTimeout(() => window.__notif.refresh({ silent: true }), 400);
  }

  /* ---------------- pemasangan event statis ---------------- */
  function wire() {
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('agCancel', closeModal);
    on('agSave', submitModal);
    const m = $('modalAgenda');
    if (m) m.addEventListener('click', e => { if (e.target === m) closeModal(); });
    const jenis = $('agJenis');
    if (jenis) jenis.addEventListener('change', () => {
      if (jenis.value === 'pemilihan' && !$('agJudul').value.trim()) $('agJudul').value = 'Pemilihan Kepala Desa';
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  window.__agenda = { load, mountDashboard, mountSettings, openModal, reset() { G.loaded = false; G.at = 0; G.data = []; G.countdown = null; } };
})();
