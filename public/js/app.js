(function(){
  // ============================================================ //
  // KONFIGURASI                                                   //
  // ============================================================ //
  const RT_LIST = ['001','002','003','004','005','006','007','008','009','010','UMUM'];
  const RT_UMUM = 'UMUM';
  const STATUS_KAWIN_LIST = ['Belum Kawin', 'Kawin', 'Cerai Hidup', 'Cerai Mati'];
  const MAX_TEMPAT_LAHIR = 60;
  const POLL_INTERVAL = 4000;  // cek sinyal perubahan (/api/rev, di-cache CDN ±2 dtk → hemat kuota Google Sheets)
  const PER_PAGE = 15;

  let KAMPUNG_LIST = ['Sasak', 'Mandar', 'Barantapen Asri', 'Dames'];
  let TARGET_PER_KAMPUNG = {};
  let TARGET_TOTAL = 500;
  let NAMA_PILKADES = 'Pilkades Seruni Mumbul 2026';
  let NAMA_KANDIDAT = 'Pak Muhaimin (Pak Emen)';
  let STATS_PER_KAMPUNG = {};
  let STATS_VERIFIED_PER_KAMPUNG = {};
  let KAMPUNG_DIRTY = false; // daftar kampung diubah di layar tapi belum disimpan
  let HARI_H = null; // { tanggal, judul, jam, lokasi } — jadwal Hari H pemilihan (atau null)

  // ============================================================ //
  // STATE                                                         //
  // ============================================================ //
  const state = {
    page: 'dashboard',
    pageToken: 0,
    detailKampung: null,
    detailFilterRT: '',
    detailFilterVerif: '',
    detailSortAZ: 'asc',   // ⭐ NEW: 'asc' | 'desc' | 'default'
    detailLoading: false,
    filter: { q: '', kampung: '', rt: '', verified: '', dicetak: '', sortAz: 'default' },
    currentPage: 1,
    fotoBase64: null,
    fotoMime: null,
    fotoSrc: null,
    fotoOcr: null,
    ocrToken: 0,
    editId: null,
    confirmCb: null,
    allData: null,
    loadedAt: 0,
    version: '0|empty',
    pollTimer: null,
    isFetching: false,
    isOnline: true,
    prevIds: {},
    nikCheckTimer: null,
    nikLastChecked: '',
    nikIsDup: false,
    dupData: null,
    configLoaded: false,
    scanResult: null,
    dashboardCache: null,
    cfgCache: null,
    pdfGenerating: false,
    xlsxGenerating: false,
    massalPdfGenerating: false,
    massalXlsxGenerating: false,
    ktpPdfGenerating: false,
    detailWargaId: null,
    verifyId: null,
    verifyFotoTTDBase64: null,
    verifyFotoTTDMime: null,
    editFotoTTDBase64: null,
    editFotoTTDMime: null,
    editHapusTTD: false,
    // ⭐ Ceklist massal status cetak: ids = { id: true }, pageIds = id kartu di halaman aktif
    sel: { on: false, ids: {}, pageIds: [], busy: false },
    user: null,               // { username, nama, role } dari /api/auth
    usersCache: null,         // daftar user (halaman Kelola User, admin)
    logsCache: null,          // daftar log (halaman Log, admin)
    dashLogs: null,           // 8 log terbaru untuk kartu Aktivitas Terbaru (dashboard, admin)
    dashLogsAt: 0
  };

  // ============================================================ //
  // ROLE & MENU                                                   //
  // ============================================================ //
  // Peran: admin = Super Admin (penuh) • operator = input, status suara/cetak, download • user = lihat saja
  const ROLE_LABEL = { admin: 'Super Admin', operator: 'Operator', user: 'User' };
  function userRole() { const r = state.user && state.user.role; return r === 'admin' || r === 'operator' ? r : 'user'; }
  function isAdmin() { return userRole() === 'admin'; }                 // Super Admin
  function roleOperate() { return userRole() !== 'user'; }              // peran Super Admin / Operator (tanpa melihat koneksi)
  function canOperate() { return roleOperate() && !state.offline; }     // boleh MENGUBAH data sekarang (Mode Offline = hanya lihat)
  function adminWrite() { return isAdmin() && !state.offline; }

  // ============================================================ //
  // MODE OFFLINE: salinan data terakhir disimpan permanen di HP   //
  // → aplikasi tetap bisa DIBUKA & DILIHAT tanpa internet selama  //
  //   maks. 3 hari sejak terakhir terhubung. Semua aksi ubah data  //
  //   dimatikan; begitu internet kembali, otomatis sinkron.        //
  // ============================================================ //
  const OFF_KEY = 'pendukung_offline_v1';
  const OFF_AT_KEY = 'pendukung_online_at';
  const OFF_MAX_AGE = 3 * 24 * 3600 * 1000;
  function offRead() { try { return JSON.parse(localStorage.getItem(OFF_KEY) || 'null'); } catch (e) { return null; } }
  function offOnlineAt() { try { return Number(localStorage.getItem(OFF_AT_KEY)) || 0; } catch (e) { return 0; } }
  function offTouch(force) {               // server baru saja terhubung (dibatasi 1x/menit agar ringan)
    const now = Date.now();
    if (!force && now - (state._offTouchAt || 0) < 60000) return;
    state._offTouchAt = now;
    try { localStorage.setItem(OFF_AT_KEY, String(now)); } catch (e) {}
  }
  function offSave(part) {
    if (state.offline || !state.user) return;
    try {
      const cur = offRead() || {};
      const next = Object.assign({}, cur.user && cur.user.username === state.user.username ? cur : {}, part, { user: state.user, savedAt: Date.now() });
      localStorage.setItem(OFF_KEY, JSON.stringify(next));
      offTouch(true);
    } catch (e) { /* penyimpanan penuh → abaikan, mode online tetap jalan */ }
  }
  function offClear() { try { localStorage.removeItem(OFF_KEY); localStorage.removeItem(OFF_AT_KEY); } catch (e) {} }
  /** Salinan yang masih boleh dipakai (≤ 3 hari sejak terakhir online) atau null */
  function offLoad() {
    const snap = offRead();
    if (!snap || !snap.user || !snap.boot) return null;
    const at = Math.max(offOnlineAt(), snap.savedAt || 0);
    if (!at || Date.now() - at > OFF_MAX_AGE) { offClear(); return null; }
    snap.onlineAt = at;
    return snap;
  }
  function fmtOffAt(t) {
    try {
      const d = new Date(t);
      return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'Asia/Makassar' }) + ', ' +
        d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Makassar' }).replace('.', ':');
    } catch (e) { return ''; }
  }
  function setOfflineUI(on) {
    window.__offlineMode = !!on;
    document.body.classList.toggle('is-offline', !!on);
    let bar = $('offlineBar');
    if (on) {
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'offlineBar';
        bar.className = 'offline-bar';
        bar.setAttribute('role', 'status');
        const main = document.querySelector('.app-main');
        if (main && $('appContent')) main.insertBefore(bar, $('appContent')); else document.body.prepend(bar);
        const fit = () => { const tb = document.querySelector('.topbar'); if (tb && bar.isConnected) bar.style.top = Math.round(tb.getBoundingClientRect().height) + 'px'; };
        fit(); window.addEventListener('resize', fit);
      }
      bar.innerHTML = '<span class="ob-ico">📴</span><span class="ob-txt"><b>Mode Offline</b> · hanya lihat · data per ' +
        esc(fmtOffAt(state.offlineAt || offOnlineAt() || Date.now())) + ' WITA</span>' +
        '<button type="button" class="ob-retry" id="offlineRetry">Coba sambung</button>';
      const rb = $('offlineRetry');
      if (rb) rb.onclick = () => { rb.disabled = true; rb.textContent = 'Menyambung…'; tryReconnect(true).finally(() => { const x = $('offlineRetry'); if (x) { x.disabled = false; x.textContent = 'Coba sambung'; } }); };
    } else if (bar) bar.remove();
    setSyncStatus(on ? 'offline' : 'online');
  }

  /** Masuk Mode Offline (saat membuka aplikasi tanpa internet, atau internet putus saat dipakai) */
  function enterOffline(reason) {
    if (state.offline) return;
    state.offline = true;
    state.offlineAt = offOnlineAt() || state.loadedAt || Date.now();
    stopPolling();
    closeWriteModals();
    setOfflineUI(true);
    applyRoleUI();
    if (state.page === 'input' || state.page === 'pengaturan') { state.page = 'dashboard'; state.pageToken++; markNav('dashboard'); }
    renderCurrentPage();
    if (reason !== 'boot') toast('📴 Internet terputus — Mode Offline (hanya lihat)', 'warn');
    startReconnectLoop();
  }

  function closeWriteModals() {
    ['modalEdit', 'modalVerify', 'modalUser', 'modalPass', 'modalBulkKtp', 'modalCropFoto', 'modalConfirm', 'modalScan'].forEach(id => {
      const m = $(id); if (m) m.classList.remove('show');
    });
    if (state.sel && state.sel.on) exitSelMode(false);
  }

  function markNav(p) { document.querySelectorAll('[data-nav]').forEach(el => el.classList.toggle('active', el.getAttribute('data-nav') === p)); }

  function startReconnectLoop() {
    clearInterval(state.reconnTimer);
    state.reconnTimer = setInterval(() => {
      if (!state.offline) { clearInterval(state.reconnTimer); return; }
      // batas 3 hari terlewati saat aplikasi tetap terbuka → kunci
      if (Date.now() - (offOnlineAt() || state.offlineAt || 0) > OFF_MAX_AGE) { offClear(); location.reload(); return; }
      if (!document.hidden && navigator.onLine !== false) tryReconnect(false);
    }, 10000);
  }

  /** Cek server; bila tersambung → keluar Mode Offline & sinkron. Sesi tidak berlaku → ke halaman login. */
  async function tryReconnect(manual) {
    if (state._reconnBusy) return;
    state._reconnBusy = true;
    try {
      const sesi = await fetchJsonTimeout('/api/auth', 8000);
      if (sesi && sesi.ok && sesi.user) { goOnline(sesi.user); return; }
      if (sesi && sesi.ok === false) {                 // server terjangkau tapi sesi habis / akun nonaktif
        offClear();
        alert('Sesi login sudah berakhir. Silakan login kembali.');
        location.reload();
        return;
      }
      if (manual) toast('Masih belum ada internet', 'warn');
    } catch (e) {
      if (manual) toast('Masih belum ada internet', 'warn');
    } finally { state._reconnBusy = false; }
  }

  function goOnline(user) {
    const wasBoot = !!state.offlineBoot;
    state.offline = false;
    state.offlineBoot = false;
    clearInterval(state.reconnTimer);
    state.user = Object.assign({}, state.user, user);
    try { sessionStorage.setItem('pendukung_user', JSON.stringify(state.user)); } catch (e) {}
    offTouch(true);
    setOfflineUI(false);
    applyRoleUI();
    state.usersCache = null; state.logsCache = null;       // muat ulang yang terbaru saat dibuka
    renderCurrentPage();                                   // tombol ubah data muncul kembali
    toast('✅ Kembali online — data diperbarui', 'success');
    state.isFetching = true;
    fetchAndReplace(true, () => { renderCurrentPage(); startPolling(true); if (wasBoot) watchModals(); if (window.Notif) window.Notif.onAppReady(); }, {});
  }

  async function fetchJsonTimeout(url, ms) {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: ctl.signal });
      if (r.status >= 500) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(tm); }
  }

  /** Buka aplikasi dari salinan di HP (tanpa internet) */
  function startOffline(snap) {
    state.offline = true;
    state.offlineBoot = true;
    state.offlineAt = snap.onlineAt;
    state.user = snap.user;
    $('loginScreen').style.display = 'none';
    $('mainApp').style.removeProperty('display');
    if (Array.isArray(snap.users)) state.usersCache = snap.users;
    if (Array.isArray(snap.logs)) state.logsCache = snap.logs;
    applyBootstrap(snap.boot);
    state.page = 'dashboard';
    state.pageToken++;
    markNav('dashboard');
    setOfflineUI(true);
    applyRoleUI();
    renderCurrentPage();
    startReconnectLoop();
  }
  window.addEventListener('online', () => { if (state.offline) setTimeout(() => tryReconnect(false), 800); });

  function applyRoleUI() {
    const admin = isAdmin();
    const staff = canOperate();
    // Menu bawah (mobile): tombol + menonjol hanya untuk Super Admin (5 menu). Operator memakai tombol
    // mengambang kanan bawah (#fabInput) supaya menu bawahnya 3 item sejajar & rapi.
    document.querySelectorAll('[data-nav="input"]').forEach(el => {
      const inBottom = !!el.closest('.bottom-nav');
      el.style.display = (inBottom ? admin && !state.offline : staff) ? '' : 'none';
    });
    const fabIn = $('fabInput');
    if (fabIn) fabIn.classList.toggle('show', staff && !isAdmin());
    document.querySelectorAll('[data-nav="pengaturan"]').forEach(el => { el.style.display = admin && !state.offline ? '' : 'none'; });
    // Nav admin: Kelola User & Log Aktivitas (+ judul grup-nya)
    document.querySelectorAll('[data-nav="users"], [data-nav="logs"], .admin-only').forEach(el => {
      el.style.display = admin ? '' : 'none';
    });
    const fab = $('fabScan');
    if (fab) { fab.style.display = admin && !state.offline ? '' : 'none'; if (admin && !state.offline) fab.classList.add('show'); }

    // Identitas user (sidebar, topbar, avatar)
    const u = state.user || {};
    const nama = u.nama || u.username || 'Pengguna';
    document.querySelectorAll('.js-user-name').forEach(el => { el.textContent = nama; });
    document.querySelectorAll('.js-user-role').forEach(el => { el.textContent = ROLE_LABEL[userRole()]; });
    document.querySelectorAll('.js-user-initials').forEach(el => { el.textContent = initialsOf(nama); });
    document.body.classList.toggle('role-admin', admin);
    document.body.classList.toggle('role-operator', userRole() === 'operator');
    document.body.classList.toggle('role-user', !staff);
  }

  // Peran diubah Super Admin saat user ini sedang membuka aplikasi → terapkan tanpa login ulang
  function applyMe(me) {
    if (!me || !state.user || !me.role) return false;
    const changed = me.role !== state.user.role;
    state.user = Object.assign({}, state.user, me);
    if (!changed) { applyRoleUI(); return false; }
    applyRoleUI();
    const locked = (state.page === 'input' && !canOperate()) ||
      (['pengaturan', 'users', 'logs'].indexOf(state.page) !== -1 && !isAdmin());
    if (locked) { state.page = 'dashboard'; state.pageToken++; document.querySelectorAll('[data-nav]').forEach(el => el.classList.toggle('active', el.getAttribute('data-nav') === 'dashboard')); }
    toast('🔑 Hak akses Anda diubah menjadi ' + ROLE_LABEL[userRole()], 'info');
    return true;
  }

  /* ---- Perlindungan layar (sebatas yang bisa dilakukan aplikasi web) ----
     1) Aplikasi ke latar belakang / pindah aplikasi → isi layar ditutup (pratinjau "Aplikasi terbaru" tidak menampilkan data)
     2) Tombol PrintScreen (Windows) → isi clipboard ditimpa sehingga tangkapan layar tidak tersimpan
     3) Cetak halaman dari browser (Ctrl+P) → hanya tampil pemberitahuan (lihat CSS @media print) */
  (function screenGuard() {
    let shield = null;
    const show = on => {
      if (!shield) {
        shield = document.createElement('div');
        shield.id = 'privacyShield';
        shield.innerHTML = '<div><img src="/icons/logo-64.png" alt="" width="54" height="54"><b>Suara Pendukung</b><span>Data dilindungi</span></div>';
        document.body.appendChild(shield);
      }
      shield.classList.toggle('on', !!on);
    };
    document.addEventListener('visibilitychange', () => show(document.hidden));
    window.addEventListener('pagehide', () => show(true));
    window.addEventListener('pageshow', () => show(false));
    window.addEventListener('focus', () => show(false));
    document.addEventListener('keyup', e => {
      if (e.key !== 'PrintScreen') return;
      try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText('Tangkapan layar Suara Pendukung tidak diizinkan').catch(() => {}); } catch (x) {}
      toast('🔒 Tangkapan layar tidak diizinkan untuk data ini', 'warn');
    });
  })();

  // Catat download (dibuat di perangkat) ke Log Aktivitas — tidak menghambat download
  function logDownload(jenis, keterangan) {
    try {
      google.script.run.withSuccessHandler(() => {}).withFailureHandler(() => {})
        .apiLogDownload({ jenis, keterangan: String(keterangan || '').slice(0, 300) });
    } catch (e) { /* abaikan */ }
  }

  function startAppAfterLogin() {
    try { sessionStorage.setItem('pendukung_auth', '1'); } catch (e) {}
    // minta browser menyimpan data aplikasi secara permanen (salinan Mode Offline & foto tidak mudah dihapus)
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) {}
    $('loginScreen').style.display = 'none';
    $('mainApp').style.removeProperty('display');
    const fab = $('fabScan');
    if (fab && isAdmin()) fab.classList.add('show');
    applyRoleUI();
    state.page = 'dashboard';
    state.pageToken++;
    document.querySelectorAll('[data-nav]').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-nav') === 'dashboard');
    });
    const c = $('appContent');
    if (c) c.innerHTML = '<div class="page-loading"><div class="spinner"></div><p>Memuat data...</p></div>';
    // SATU permintaan untuk semua data awal (config + dashboard + daftar + versi + badge duplikat)
    google.script.run
      .withSuccessHandler(r => {
        if (!r || !r.ok) { legacyStart(); return; }
        applyBootstrap(r);
        renderCurrentPage();
        startPolling(true);          // data baru saja dimuat → cek perubahan berikutnya sesuai interval
        watchModals();
        if (window.Notif) window.Notif.onAppReady();
      })
      .withFailureHandler(() => legacyStart())
      .apiGetBootstrap();
  }

  function applyBootstrap(r) {
    if (r.me && applyMe(r.me)) setTimeout(renderCurrentPage, 0);
    if (r.config) {
      applyConfig(r.config);
      try { sessionStorage.setItem('pendukung_config', JSON.stringify(r.config)); } catch (e) {}
    }
    if (Array.isArray(r.logs)) { state.dashLogs = r.logs; state.dashLogsAt = Date.now(); }
    if (r.dashboard) {
      state.dashboardCache = r.dashboard;
      state.dashboardAt = Date.now();
      STATS_PER_KAMPUNG = r.dashboard.perKampung || {};
      STATS_VERIFIED_PER_KAMPUNG = r.dashboard.kampungVerified || {};
    }
    if (Array.isArray(r.list)) {
      // notifikasi dalam aplikasi: bandingkan dengan data sebelumnya (tanpa permintaan tambahan ke server)
      if (!state.offline && state._notifBase && window.Notif) { try { window.Notif.onData(state._notifBase, r.list); } catch (e) {} }
      state._notifBase = r.list;
      state.allData = r.list;
      state.loadedAt = Date.now();
      state.version = r.version || '0|empty';
      if (r.rev) state.rev = r.rev;
      try {
        sessionStorage.setItem('pendukung_cache_v1', JSON.stringify(r.list));
        sessionStorage.setItem('pendukung_cache_at', String(state.loadedAt));
        sessionStorage.setItem('pendukung_cache_version', state.version);
      } catch (e) {}
    }
    state._lastDupCheck = Date.now();
    if (isAdmin()) updateFabBadge(r.dupGroups || 0);
    if (state.offline) return;
    setSyncStatus('online');
    // salinan permanen untuk Mode Offline (config + dashboard + daftar + log ringkas)
    offSave({ boot: { ok: true, config: r.config || null, dashboard: r.dashboard || state.dashboardCache, list: r.list || state.allData,
      version: r.version, rev: r.rev, dupGroups: r.dupGroups || 0, logs: Array.isArray(r.logs) ? r.logs : (state.dashLogs || null), me: r.me || null } });
  }

  // Cadangan bila bootstrap gagal (mis. server lama): alur lama per bagian
  function legacyStart() {
    loadConfig(() => {
      renderCurrentPage();
      startPolling();
      watchModals();
    });
  }

  // ============================================================ //
  // HELPERS                                                       //
  // ============================================================ //
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));

  function normRT(v) {
    if (v == null) return '001';
    let s = String(v).trim();
    s = s.replace(/^['"]+/, '').replace(/['"]+$/, '');
    if (!s) return '001';
    const lower = s.toLowerCase();
    if (lower === 'umum' || lower === 'u' || lower === 'um') {
      return RT_UMUM;
    }
    if (/^\d{1,2}$/.test(s)) return s.padStart(3, '0');
    if (/^\d{3,}$/.test(s)) return s.slice(-3);
    const n = parseInt(s, 10);
    if (!isNaN(n) && n > 0 && n < 1000) return String(n).padStart(3, '0');
    return s;
  }

  function fmtNum(n) {
    return String(parseInt(n, 10) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function initialsOf(str) {
    if (!str) return '?';
    const words = String(str).trim().split(/\s+/).slice(0, 2);
    return words.map(w => (w[0] || '').toUpperCase()).join('') || '?';
  }

  function rtLabel(rt) {
    const n = normRT(rt);
    return n === RT_UMUM ? 'UMUM' : ('RT ' + n);
  }

  // ============================================================ //
  // ICONS                                                         //
  // ============================================================ //
  const ICONS = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    male: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="14" r="5"/><line x1="19" y1="5" x2="13.6" y2="10.4"/><polyline points="19 5 14 5 19 10"/></svg>',
    female: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="5"/><line x1="12" y1="14" x2="12" y2="22"/><line x1="8" y1="18" x2="16" y2="18"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    gallery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
    card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
    dupScan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    first: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>',
    last: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    arrowLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
    arrowRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    ttd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c2 0 4-1 6-4s4-8 6-8 3 3 3 5-1 3-3 3"/><path d="M21 21H3"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    // ⭐ ICON SORT
    sortAZ: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h10"/><path d="M3 12h7"/><path d="M3 18h4"/><path d="M17 4v16"/><polyline points="13 16 17 20 21 16"/></svg>',
    sortZA: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h4"/><path d="M3 12h7"/><path d="M3 18h10"/><path d="M17 20V4"/><polyline points="13 8 17 4 21 8"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
    // ⭐ ICON status cetak
    printer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>'
  };

  function toast(msg, type) {
    const t = $('toast');
    if (!t) return;
    let ico = ICONS.check;
    if (type === 'error') ico = ICONS.warn;
    if (type === 'warn') ico = ICONS.warn;
    if (type === 'verified') ico = ICONS.shield;
    t.innerHTML = ico + '<span>' + esc(msg) + '</span>';
    t.className = 'toast show ' + (type || '');
    clearTimeout(t._tm);
    t._tm = setTimeout(() => t.className = 'toast ' + (type || ''), 3200);
  }

  function setSyncStatus(status) {
    const dot = $('syncDot');
    const txt = $('headerStatus');
    if (!dot || !txt) return;
    if (status === 'syncing') {
      dot.className = 'sync-dot syncing';
      txt.textContent = 'Sinkronisasi...';
    } else if (status === 'offline') {
      dot.className = 'sync-dot offline';
      txt.textContent = 'Offline';
    } else {
      dot.className = 'sync-dot';
      txt.textContent = 'Live';
    }
  }

  function showPullIndicator() {
    const el = $('pullIndicator');
    if (!el) return;
    el.classList.add('show');
    clearTimeout(el._tm);
    el._tm = setTimeout(() => el.classList.remove('show'), 800);
  }

  function parseNIK(nik) {
    nik = String(nik || '').trim();
    if (!/^\d{16}$/.test(nik)) return { valid: false, msg: 'NIK harus 16 digit angka' };
    let dd = parseInt(nik.substring(6, 8), 10);
    const mm = parseInt(nik.substring(8, 10), 10);
    const yy = parseInt(nik.substring(10, 12), 10);
    let jk = 'Laki-laki';
    if (dd > 40) { jk = 'Perempuan'; dd -= 40; }
    const nowYY = new Date().getFullYear() % 100;
    const tahun = (yy > nowYY) ? 1900 + yy : 2000 + yy;
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return { valid: false, msg: 'NIK tidak valid' };
    const tgl = new Date(tahun, mm - 1, dd);
    const today = new Date();
    let usia = today.getFullYear() - tgl.getFullYear();
    const mD = today.getMonth() - tgl.getMonth();
    if (mD < 0 || (mD === 0 && today.getDate() < tgl.getDate())) usia--;
    const bulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
    return { valid: true, jenisKelamin: jk, usia, tglText: dd + ' ' + bulan[mm-1] + ' ' + tahun };
  }

  function compressImage(file, cb) {
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1280;
        let w = img.width, h = img.height;
        if (w > h && w > MAX) { h = h * MAX / w; w = MAX; }
        else if (h > MAX) { w = w * MAX / h; h = MAX; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        cb(canvas.toDataURL('image/jpeg', 0.82), 'image/jpeg');
      };
      img.onerror = () => cb(null, null);
      img.src = ev.target.result;
    };
    reader.onerror = () => cb(null, null);
    reader.readAsDataURL(file);
  }

  // ============================================================ //
  // NAVIGASI                                                      //
  // ============================================================ //
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => {
      const target = el.getAttribute('data-nav');
      state.detailKampung = null;
      state.detailFilterRT = '';
      state.detailFilterVerif = '';
      state.detailSortAZ = 'asc';
      if (target === state.page && !state.detailKampung) return;
      setPage(target);
    });
  });

  function setPage(p) {
    exitSelMode(false);
    state.page = p;
    state.pageToken++;
    document.querySelectorAll('[data-nav]').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-nav') === p);
    });
    updateFabVisibility();
    renderCurrentPage();
  }

  // Pencarian global di topbar → buka halaman Data dengan kata kunci tsb
  (function initGlobalSearch() {
    const inp = document.getElementById('globalSearch');
    const form = document.getElementById('globalSearchForm');
    if (!inp || !form) return;
    form.addEventListener('submit', e => {
      e.preventDefault();
      const q = inp.value.trim();
      state.detailKampung = null;
      state.filter.q = q;
      state.currentPage = 1;
      if (state.page === 'data') { renderData(); } else { setPage('data'); }
      inp.blur();
    });
    // Sinkron: kalau kata kunci dikosongkan di halaman Data, kosongkan juga di topbar
    inp.addEventListener('search', () => { if (!inp.value && state.filter.q) { state.filter.q = ''; if (state.page === 'data') renderData(); } });
  })();

  function openDetailKampung(namaKampung) {
    state.detailKampung = namaKampung;
    state.detailFilterRT = '';
    state.detailFilterVerif = '';
    state.detailSortAZ = 'asc';
    state.page = 'detail-kampung';
    state.pageToken++;
    document.querySelectorAll('[data-nav]').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-nav') === 'dashboard');
    });
    updateFabVisibility();

    if (!state.allData) {
      const c = $('appContent');
      if (c) c.innerHTML = '<div class="page-loading"><div class="spinner"></div><p>Memuat data...</p></div>';
      state.detailLoading = true;
      const token = state.pageToken;
      fetchAndReplace(false, () => {
        state.detailLoading = false;
        if (isStillOn(token, 'detail-kampung')) renderDetailKampung();
      });
      return;
    }
    renderDetailKampung();
  }

  function closeDetailKampung() {
    state.detailKampung = null;
    state.detailFilterRT = '';
    state.detailFilterVerif = '';
    state.detailSortAZ = 'asc';
    setPage('dashboard');
  }

  function renderCurrentPage() {
    document.body.classList.toggle('page-input', state.page === 'input');
    if (state.page === 'dashboard') renderDashboard();
    else if (state.page === 'input') renderInput();
    else if (state.page === 'data') renderData();
    else if (state.page === 'pengaturan') renderPengaturan();
    else if (state.page === 'detail-kampung') renderDetailKampung();
    else if (state.page === 'users') renderUsers();
    else if (state.page === 'logs') renderLogs();
    else if (state.page === 'profil') renderProfil();
  }

  function isStillOn(token, page) {
    return state.pageToken === token && state.page === page;
  }

  // Tombol scan duplikat kini ikon lonceng di topbar (tertutup overlay modal
  // dengan sendirinya), jadi tidak perlu disembunyikan secara manual lagi.
  function updateFabVisibility() {}

  function watchModals() {}

  // ============================================================ //
  // CONFIG LOADER                                                 //
  // ============================================================ //
  function applyConfig(cfg) {
    if (!cfg) return;
    // Jangan timpa perubahan daftar kampung yang belum disimpan (mis. saat sinkron data di latar belakang)
    if (!KAMPUNG_DIRTY) {
      KAMPUNG_LIST = (cfg.kampungList || []).slice();
      TARGET_PER_KAMPUNG = cfg.targetPerKampung || {};
    }
    TARGET_TOTAL = parseInt(cfg.targetTotal, 10) || 500;
    NAMA_PILKADES = cfg.namaPilkades || 'Pilkades Seruni Mumbul 2026';
    NAMA_KANDIDAT = cfg.namaKandidat || 'Pak Muhaimin (Pak Emen)';
    HARI_H = cfg.hariH || null;
    state.configLoaded = true;
    state.cfgCache = cfg;
    const sub = $('loginSub');
    if (sub) sub.textContent = NAMA_PILKADES;
    document.title = 'Suara Pendukung — ' + NAMA_KANDIDAT;
  }

  function loadConfig(cb) {
    if (state.cfgCache) {
      if (typeof cb === 'function') cb(state.cfgCache);
      return;
    }
    google.script.run
      .withSuccessHandler(r => {
        if (r.ok) {
          applyConfig(r.data);
          try { sessionStorage.setItem('pendukung_config', JSON.stringify(r.data)); } catch(e){}
        }
        if (typeof cb === 'function') cb(state.cfgCache);
      })
      .withFailureHandler(() => { if (typeof cb === 'function') cb(state.cfgCache); })
      .apiGetConfig();
  }

  try {
    const sc = sessionStorage.getItem('pendukung_config');
    if (sc) applyConfig(JSON.parse(sc));
  } catch (e) {}

  // ============================================================ //
  // LOGIN                                                         //
  // ============================================================ //
  $('loginBtn').addEventListener('click', doLogin);
  $('loginPass').addEventListener('keypress', e => { if (e.key === 'Enter') doLogin(); });
  $('loginUser').addEventListener('keypress', e => { if (e.key === 'Enter') { e.preventDefault(); if ($('loginPass').value) doLogin(); else $('loginPass').focus(); } });

  // Tampilkan / sembunyikan password
  $('loginEye').addEventListener('click', () => {
    const inp = $('loginPass');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('loginEyeUse').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
    $('loginEye').title = show ? 'Sembunyikan password' : 'Tampilkan password';
  });

  function doLogin() {
    const uname = $('loginUser').value.trim();
    const pw = $('loginPass').value;
    if (!uname) { $('loginErr').textContent = 'Username wajib diisi'; return; }
    if (!pw) { $('loginErr').textContent = 'Password wajib diisi'; return; }
    $('loginBtn').disabled = true;
    $('loginBtn').innerHTML = '<div class="spinner" style="width:20px;height:20px;border-width:2px;margin:0;border-color:rgba(255,255,255,.4);border-top-color:#fff"></div>';
    fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ op: 'login', username: uname, password: pw })
    })
      .then(async res => {
        const txt = await res.text();
        try { return JSON.parse(txt); }
        catch (e) {
          // halaman error Vercel (bukan JSON) → pesan yang bisa dipahami
          return { ok: false, message: res.status === 504 || /timeout/i.test(txt)
            ? 'Server terlalu lama merespons. Coba lagi sebentar.'
            : 'Server sedang bermasalah (HTTP ' + res.status + '). Coba lagi sebentar.' };
        }
      })
      .then(r => {
        $('loginBtn').disabled = false;
        $('loginBtn').innerHTML = '<span class="btn-text">Masuk</span>';
        if (r.ok) {
          state.user = r.user || { username: uname, nama: uname, role: 'user' };
          try { sessionStorage.setItem('pendukung_user', JSON.stringify(state.user)); } catch (e) {}
          $('loginErr').textContent = '';
          $('loginPass').value = '';
          startAppAfterLogin();
        } else {
          $('loginErr').textContent = r.message || 'Login gagal';
        }
      })
      .catch(e => {
        $('loginBtn').disabled = false;
        $('loginBtn').innerHTML = '<span class="btn-text">Masuk</span>';
        $('loginErr').textContent = 'Gagal: ' + e.message;
      });
  }

  $('logoutBtn').addEventListener('click', () => {
    stopPolling();
    offClear();
    try {
      ['pendukung_auth', 'pendukung_user', 'pendukung_cache_v1', 'pendukung_cache_at', 'pendukung_cache_version', 'pendukung_config'].forEach(k => sessionStorage.removeItem(k));
    } catch (e) {}
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'clear-photos' });
      if (window.caches) caches.delete('pendukung-foto-v1');
    } catch (e) {}
    // perangkat ini berhenti menerima push untuk akun yang keluar, lalu logout
    Promise.race([Promise.resolve(window.Notif && window.Notif.onLogout()), new Promise(r => setTimeout(r, 2500))])
      .then(() => fetch('/api/auth', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'logout' }) }))
      .catch(() => {})
      .then(() => location.reload());
  });

  // ============================================================ //
  // BOOT: cek sesi ke server (auto-login & role)                  //
  // ============================================================ //
  (async function bootSession() {
    // tunggu seluruh app.js selesai dieksekusi (konstanta di bawah sudah siap) — penting bila offline (tanpa await jaringan)
    await new Promise(r => setTimeout(r, 0));
    let sesi = null, netFail = false;
    if (navigator.onLine === false) netFail = true;
    else {
      try { sesi = await fetchJsonTimeout('/api/auth', 8000); }
      catch (e) { sesi = null; netFail = true; }        // tidak ada internet / server tak terjangkau / timeout
    }
    if (sesi && sesi.ok && sesi.user) {
      state.user = sesi.user;
      try { sessionStorage.setItem('pendukung_user', JSON.stringify(sesi.user)); } catch (e) {}
      offTouch(true);
      startAppAfterLogin();
      return;
    }
    const hadSnap = !!offRead();
    if (netFail) {
      const snap = offLoad();
      if (snap) { startOffline(snap); return; }        // ✅ tetap bisa dibuka & dilihat tanpa internet
    } else offClear();                                  // server menyatakan belum/tidak login → hapus salinan
    try {
      ['pendukung_auth', 'pendukung_user'].forEach(k => sessionStorage.removeItem(k));
    } catch (e) {}
    $('loginScreen').style.display = 'flex';
    if (netFail) {
      const le = $('loginErr');
      if (le) le.textContent = hadSnap
        ? '📴 Tidak ada internet. Data offline di perangkat ini sudah lebih dari 3 hari — sambungkan internet lalu login.'
        : '📴 Tidak ada internet. Login sekali saat online agar aplikasi bisa dibuka tanpa internet.';
      window.addEventListener('online', () => { if (le) le.textContent = ''; }, { once: true });
    }
    const lu = $('loginUser');
    if (lu) lu.focus();
  })();

  // ============================================================ //
  // POLLING                                                       //
  // ============================================================ //
  // ============================================================ //
  // REALTIME: semua perangkat melihat perubahan dalam ±5 detik     //
  // 1) cek sinyal /api/rev tiap 4 dtk (sangat ringan, cache CDN)   //
  // 2) bila berubah → ambil data terbaru dalam SATU permintaan     //
  // 3) perbarui halaman yang sedang dilihat tanpa refresh          //
  // ============================================================ //
  window.addEventListener('offline', () => { if (state.user && state.allData && $('mainApp') && $('mainApp').style.display !== 'none') enterOffline('drop'); });

  function startPolling(skipFirst) {
    stopPolling();
    if (!skipFirst) syncData(true);
    state.pollTimer = setInterval(() => {
      if (!document.hidden && navigator.onLine !== false) syncData(true);
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  function syncData(silent) {
    if (state.isFetching || state.isRevChecking) return;
    state.isRevChecking = true;
    if (!silent) setSyncStatus('syncing');
    fetch('/api/rev', { credentials: 'same-origin', cache: 'no-cache' })
      .then(r => r.ok ? r.json() : null)
      .then(r => {
        state.isRevChecking = false;
        if (!r || !r.ok) { if (!silent) setSyncStatus('offline'); return; }
        state._revFail = 0;
        offTouch(false);
        setSyncStatus('online');
        if (state.rev && r.rev === state.rev && state.allData) return;       // tidak ada perubahan
        state.isFetching = true;
        fetchAndReplace(true, null, { fromRemote: !!state.rev });
      })
      .catch(() => {
        state.isRevChecking = false;
        if (!silent) setSyncStatus('offline');
        // 2x berturut-turut gagal terhubung (±8 dtk) → Mode Offline (hanya lihat) sampai internet kembali
        state._revFail = (state._revFail || 0) + 1;
        if (state._revFail >= 2 && state.allData) enterOffline('drop');
      });
  }

  // Ambil data terbaru (satu permintaan) lalu perbarui tampilan yang sedang dibuka
  function fetchAndReplace(silent, callback, opts) {
    const token = state.pageToken;
    const prevRev = state.rev;
    google.script.run
      .withSuccessHandler(r => {
        state.isFetching = false;
        if (!r || !r.ok) { if (typeof callback === 'function') callback(false); return; }
        const changed = !prevRev || r.rev !== prevRev;
        applyBootstrap(r);
        state.dataVersion = (state.dataVersion || 0) + 1;
        if (isStillOn(token, 'data') && $('dataGridWrap')) renderFilteredGrid(true);
        else if (isStillOn(token, 'dashboard') && $('appContent')) renderDashboardData();
        else if (isStillOn(token, 'detail-kampung') && $('appContent')) renderDetailKampung();
        refreshOpenDetail();
        if (silent && changed) {
          showPullIndicator();
          if (opts && opts.fromRemote && Date.now() > (state.quietSyncUntil || 0) && Date.now() - (window.__notifToastAt || 0) > 2000) toast('🔄 Data diperbarui', 'info');
        }
        if (typeof callback === 'function') callback(true);
      })
      .withFailureHandler(() => {
        state.isFetching = false;
        setSyncStatus('offline');
        if (typeof callback === 'function') callback(false);
      })
      .apiGetBootstrap({ fresh: true });
  }

  // Modal detail yang sedang terbuka ikut diperbarui (atau ditutup bila datanya dihapus perangkat lain)
  function refreshOpenDetail() {
    const id = state.detailWargaId;
    if (!id || !$('modalDetailWarga') || !$('modalDetailWarga').classList.contains('show')) return;
    const p = (state.allData || []).find(x => String(x.id) === String(id));
    if (!p) {
      $('modalDetailWarga').classList.remove('show');
      state.detailWargaId = null;
      toast('Data ini baru saja dihapus', 'warn');
      return;
    }
    const sig = JSON.stringify(p);
    if (state._detailSig === sig) return;
    state._detailSig = sig;
    renderModalDetailWarga(p);
  }

  function checkDupBadge() {
    state._lastDupCheck = Date.now();
    google.script.run
      .withSuccessHandler(r => { if (r.ok) updateFabBadge(r.totalGroup || 0); })
      .withFailureHandler(() => {})
      .apiScanDuplikat();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.pollTimer) syncData(true);       // kembali ke aplikasi → langsung cek perubahan
  });
  window.addEventListener('focus', () => {
    if (state.pollTimer) syncData(true);
  });
  window.addEventListener('online', () => { setSyncStatus('online'); syncData(true); });
  window.addEventListener('offline', () => setSyncStatus('offline'));

  // ============================================================ //
  // DASHBOARD                                                     //
  // ============================================================ //
  function renderDashboard() {
    const c = $('appContent');
    if (!c) return;
    state.greet = null;          // membuka Dashboard → pilih kalimat sapaan baru
    if (state.dashboardCache) {
      renderDashboardData();
      if (Date.now() - (state.dashboardAt || 0) < 30000) return;   // baru dimuat → tak perlu minta ulang
      const token = state.pageToken;
      google.script.run
        .withSuccessHandler(r => {
          if (r.ok && isStillOn(token, 'dashboard')) {
            state.dashboardCache = r.data;
            state.dashboardAt = Date.now();
            STATS_PER_KAMPUNG = r.data.perKampung || {};
            STATS_VERIFIED_PER_KAMPUNG = r.data.kampungVerified || {};
            if (r.data.kampungList) applyConfig(r.data);
            renderDashboardData();
          }
        })
        .withFailureHandler(() => { if (isStillOn(token, 'dashboard')) setSyncStatus('offline'); })
        .apiGetDashboard();
      return;
    }
    c.innerHTML = '<div class="page-loading"><div class="spinner"></div><p>Memuat data...</p></div>';
    const token = state.pageToken;
    google.script.run
      .withSuccessHandler(r => {
        if (!isStillOn(token, 'dashboard')) return;
        if (!r.ok) { c.innerHTML = emptyState('⚠️', 'Gagal', r.message); return; }
        state.dashboardCache = r.data;
        STATS_PER_KAMPUNG = r.data.perKampung || {};
        STATS_VERIFIED_PER_KAMPUNG = r.data.kampungVerified || {};
        if (r.data.kampungList) applyConfig(r.data);
        renderDashboardData();
      })
      .withFailureHandler(e => {
        if (!isStillOn(token, 'dashboard')) return;
        c.innerHTML = emptyState('⚠️', 'Gagal memuat', e.message);
      })
      .apiGetDashboard();
  }

  // ---------- helper tampilan bersama ---------- //
  function pageHead(title, sub, rightHtml) {
    return '<div class="page-head">' +
      '<div class="ph-txt"><h1 class="ph-title">' + title + '</h1>' + (sub ? '<p class="ph-sub">' + sub + '</p>' : '') + '</div>' +
      (rightHtml ? '<div class="ph-right">' + rightHtml + '</div>' : '') +
    '</div>';
  }

  function timeAgo(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'baru saja';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' menit lalu';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' jam lalu';
    const d = Math.round(h / 24);
    if (d < 30) return d + ' hari lalu';
    return new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // aksi log → { teks ramah, ikon, warna }
  function logMeta(aksi) {
    const a = String(aksi || '');
    const M = {
      ADD:            ['Data pendukung baru ditambahkan', 'users', 'green'],
      UPDATE:         ['Data pendukung diperbarui', 'edit', 'blue'],
      DELETE:         ['Data pendukung dihapus', 'trash', 'red'],
      VERIFY_TTD:     ['Suara diverifikasi (bukti TTD)', 'shield', 'green'],
      UNVERIFY:       ['Verifikasi dibatalkan', 'clock', 'amber'],
      TOGGLE_CETAK:   ['Status cetak diubah', 'printer', 'blue'],
      CETAK_MASSAL:   ['Status cetak massal diubah', 'printer', 'blue'],
      SAVE_CONFIG:    ['Pengaturan aplikasi disimpan', 'settings', 'slate'],
      RENAME_KAMPUNG: ['Nama kampung diperbarui', 'home', 'amber'],
      USER_ADD:       ['User baru ditambahkan', 'users', 'green'],
      USER_UPDATE:    ['Data user diperbarui', 'edit', 'blue'],
      USER_RESET_PASS:['Password user direset', 'shield', 'amber'],
      GANTI_PASSWORD: ['Password diganti', 'shield', 'slate'],
      HARI_H:         ['Jadwal Hari H pemilihan diperbarui', 'calendar', 'blue'],
      AKSES_DITOLAK:  ['Akses ditolak', 'warn', 'red'],
      DOWNLOAD_KTP:   ['KTP di-download (PDF A4)', 'download', 'blue'],
      DOWNLOAD_KTP_MASSAL: ['KTP massal di-download', 'download', 'blue'],
      DOWNLOAD_PDF:   ['PDF data kampung di-download', 'download', 'blue'],
      DOWNLOAD_KTP_TTD: ['KTP + TTD digital di-download (PDF A4)', 'download', 'blue']
    };
    if (M[a]) return { text: M[a][0], ico: M[a][1], tone: M[a][2] };
    if (/LOGIN/.test(a)) return { text: /GAGAL/.test(a) ? 'Percobaan login gagal' : 'Login berhasil', ico: 'shield', tone: /GAGAL/.test(a) ? 'red' : 'slate' };
    if (/LOGOUT/.test(a)) return { text: 'Logout', ico: 'close', tone: 'slate' };
    return { text: a.replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase()), ico: 'info', tone: 'slate' };
  }

  function dashActivityHtml() {
    const logs = state.dashLogs;
    if (!logs) return '<div class="act-loading"><div class="spinner" style="width:22px;height:22px;border-width:2px;margin:0 auto 8px"></div>Memuat aktivitas…</div>';
    if (!logs.length) return '<div class="act-empty">Belum ada aktivitas tercatat.</div>';
    return logs.slice(0, 5).map(l => {
      const m = logMeta(l.aksi);
      const who = (l.nama || l.username) ? 'oleh ' + esc(l.nama || l.username) + (l.peran ? ' (' + esc(l.peran) + ')' : '') : '';
      return '<div class="act-item">' +
        '<div class="act-ico tone-' + m.tone + '">' + (ICONS[m.ico] || ICONS.info) + '</div>' +
        '<div class="act-txt"><div class="act-title">' + esc(m.text) + '</div>' +
        (l.keterangan && !/LOGIN|LOGOUT/.test(l.aksi) ? '<div class="act-det">' + esc(String(l.keterangan).slice(0, 90)) + '</div>' : '') +
        '<div class="act-meta">' + who + (who ? ' • ' : '') + esc(timeAgo(l.timestamp)) + '</div></div>' +
      '</div>';
    }).join('');
  }

  function loadDashLogs(force) {
    if (!isAdmin() || state.offline) return;
    if (!force && state.dashLogs && Date.now() - (state.dashLogsAt || 0) < 30000) return;
    state.dashLogsAt = Date.now();
    google.script.run
      .withSuccessHandler(r => {
        if (!r || !r.ok) return;
        state.dashLogs = r.data || [];
        const box = $('dashActivity');
        if (box) box.innerHTML = dashActivityHtml();
      })
      .withFailureHandler(() => { if (!state.dashLogs) state.dashLogs = []; const box = $('dashActivity'); if (box) box.innerHTML = dashActivityHtml(); })
      .apiGetLogs({ limit: 8 });
  }

  const CHART_COLORS = ['#3b82f6', '#34d399', '#fbbf24', '#a78bfa', '#f472b6', '#22d3ee', '#fb923c', '#84cc16'];

  function niceAxis(max) {
    if (max <= 0) return { step: 1, top: 4 };
    const raw = max / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    return { step, top: step * 4 };
  }

  function kampungChartHtml(list, perKampung) {
    if (!list.length) return '<div class="act-empty">Belum ada kampung. Tambahkan di menu Atur.</div>';
    const vals = list.map(k => perKampung[k] || 0);
    const ax = niceAxis(Math.max.apply(null, vals));
    let lines = '';
    for (let i = 4; i >= 0; i--) {
      lines += '<div class="bc-line"><span>' + (ax.step * i) + '</span></div>';
    }
    let cols = '';
    list.forEach((k, i) => {
      const v = vals[i];
      const h = ax.top > 0 ? Math.max(v > 0 ? 2 : 0, (v / ax.top) * 100) : 0;
      cols +=
        '<button class="bc-col" type="button" data-kampung="' + esc(k) + '" title="' + esc(k) + ': ' + v + ' orang — klik untuk detail">' +
          '<span class="bc-barwrap"><span class="bc-val">' + v + '</span><span class="bc-bar" style="height:' + h.toFixed(1) + '%;--c:' + CHART_COLORS[i % CHART_COLORS.length] + '"></span></span>' +
          '<span class="bc-lbl">' + esc(k) + '</span>' +
        '</button>';
    });
    return '<div class="bc-scroll"><div class="bc" style="--n:' + list.length + '"><div class="bc-lines">' + lines + '</div><div class="bc-cols">' + cols + '</div></div></div>';
  }

  function statCard(cls, icoTone, ico, label, value, sub, extra) {
    return '<div class="stat-card ' + cls + '">' +
      '<div class="sc-ico ico-' + icoTone + '">' + ico + '</div>' +
      '<div class="stat-label">' + label + '</div>' +
      '<div class="stat-value">' + value + '</div>' +
      '<div class="stat-sub">' + sub + '</div>' + (extra || '') +
    '</div>';
  }

  // ---------- Hari H pemilihan: hitung mundur di dashboard (tanpa notifikasi) ---------- //
  const HH_ZONE = 'Asia/Makassar';   // jadwal & tanggal dashboard memakai WITA
  const HH_LABEL = 'WITA';
  const hhDayNum = ymd => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN; };
  const hhToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: HH_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const hhFmtLong = ymd => new Date(hhDayNum(ymd) * 86400000).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

  function hhMessage(days) {
    const pick = arr => arr[Math.abs(days) % arr.length];
    if (days < 0) return 'Pemilihan telah dilaksanakan. Terima kasih atas kerja keras, doa, dan semangat seluruh tim. 🙏';
    if (days === 0) return 'Hari H telah tiba! Bismillah — ajak keluarga & tetangga datang ke TPS dan gunakan hak pilihnya. 💪';
    if (days === 1) return 'Besok Hari H. Istirahat cukup, pastikan logistik siap, dan ingatkan semua pendukung datang ke TPS.';
    if (days <= 7) return pick(['Tinggal ' + days + ' hari lagi! Saatnya merapatkan barisan dan memastikan semua pendukung tahu lokasi TPS-nya.', 'H-' + days + '! Fokus ke pendukung yang masih belum pasti — satu kunjungan bisa menambah satu suara.', 'Sebentar lagi! Jaga kekompakan dan semangat tim. 🤝']);
    if (days <= 30) return pick(['Waktu terus berjalan — ' + days + ' hari lagi. Yuk percepat verifikasi suara dan kunjungi warga di tiap kampung.', 'Setiap hari berarti. Hari ini, sapa satu keluarga lagi dan pastikan suaranya PASTI.', 'Tetap semangat, tetap santun, tetap konsisten! 🌱']);
    return pick(['Masih ' + days + ' hari. Waktu yang cukup untuk membangun kepercayaan warga — mulai dari hal kecil, konsisten tiap hari.', 'Semangat, Tim Pendukung! Mari kerja cerdas dan ikhlas. ☀️']);
  }

  /* Kartu hitung mundur Hari H. slot: 'top' (desktop, di atas kartu statistik) | 'mid' (HP, di atas grafik per kampung) */
  function hariHBannerHtml(h, slot) {
    const where = slot === 'mid' ? ' hh-slot-mid' : ' hh-slot-top';
    if (!h) {
      if (!adminWrite()) return '';
      return '<section class="hh-banner hh-empty' + where + '"><div class="hh-emoji">🗳️</div>' +
        '<div class="hh-body"><div class="hh-kicker">HARI PEMILIHAN</div><div class="hh-title">Tetapkan tanggal Hari H pemilihan</div>' +
        '<div class="hh-msg">Tanggal Hari H akan tampil sebagai hitung mundur di Dashboard untuk seluruh tim.</div></div>' +
        '<button type="button" class="hh-btn js-hh-manage">Atur sekarang</button></section>';
    }
    const days = Math.round(hhDayNum(h.tanggal) - hhDayNum(hhToday()));
    let big, unit;
    if (days < 0) { big = '✔'; unit = 'Selesai'; }
    else if (days === 0) { big = 'H'; unit = 'Hari ini'; }
    else if (days === 1) { big = '1'; unit = 'Hari lagi'; }
    else { big = String(days); unit = 'Hari lagi'; }
    // rincian ringkas: "± 16 minggu 6 hari" / "Besok" / "Hari ini"
    let rinci = '';
    if (days >= 14) { const w = Math.floor(days / 7), r = days % 7; rinci = '± ' + w + ' minggu' + (r ? ' ' + r + ' hari' : ''); }
    else if (days > 1) rinci = days + ' hari lagi';
    else if (days === 1) rinci = 'Besok!';
    else if (days === 0) rinci = 'Hari ini!';
    else rinci = 'Pemilihan telah berlangsung';
    const info = [];
    if (h.jam) info.push('<span class="hh-chip">⏰ ' + esc(h.jam) + ' ' + HH_LABEL + '</span>');
    if (h.lokasi) info.push('<span class="hh-chip">📍 ' + esc(h.lokasi) + '</span>');
    info.push('<span class="hh-chip hh-chip-soft">' + esc(rinci) + '</span>');
    return '<section class="hh-banner' + where + (days <= 0 ? ' hh-today' : days <= 7 ? ' hh-soon' : '') + '">' +
      '<div class="hh-head">' +
        '<div class="hh-kicker">🗳️ ' + esc(String(h.judul || 'Hari Pemilihan').toUpperCase()) + '</div>' +
        (adminWrite() ? '<button type="button" class="hh-link js-hh-manage" aria-label="Ubah jadwal">Ubah ' + ICONS.arrowRight + '</button>' : '') +
      '</div>' +
      '<div class="hh-main">' +
        '<div class="hh-count"><div class="hh-num">' + esc(big) + '</div><div class="hh-unit">' + esc(unit) + '</div></div>' +
        '<div class="hh-when">' +
          '<div class="hh-label">Hari H pemilihan</div>' +
          '<div class="hh-title">' + esc(hhFmtLong(h.tanggal)) + '</div>' +
          '<div class="hh-chips">' + info.join('') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="hh-msg">' + esc(hhMessage(days)) + '</div>' +
    '</section>';
  }

  /* Sapaan dashboard: sesuai waktu (WITA) & jabatan user; kalimat tetap selama halaman dibuka
     (sinkron realtime tidak membuatnya berganti), berganti saat Dashboard dibuka lagi / periode waktu berubah / diketuk */
  function greetStats(d) {
    const total = d.total || 0, target = d.target || 0;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: HH_ZONE });
    const baru = (state.allData || []).filter(x => {
      const t = Date.parse(x.timestamp || x.createdAt || '');
      return t && new Date(t).toLocaleDateString('en-CA', { timeZone: HH_ZONE }) === today;
    }).length;
    let hari = 0;
    if (d.hariH && d.hariH.tanggal) { const n = Math.round(hhDayNum(d.hariH.tanggal) - hhDayNum(hhToday())); if (n > 0) hari = n; }
    return { total, target, persen: target > 0 ? Math.round(total / target * 100) : 0, pasti: d.verified || 0, baru, hari };
  }

  function greetingFor(d, rotate) {
    const u = state.user || {};
    const S = window.Sapaan;
    if (!S) return { judul: 'Selamat Datang, ' + (u.nama || u.username || ''), emoji: '👋', pesan: 'Kelola data pendukung dengan mudah dan cepat.' };
    const per = S.periodeOf(S.hourIn(HH_ZONE));
    const key = [u.username, u.nama, u.jabatan, u.panggilan, per].join('|');
    if (!rotate && state.greet && state.greet.key === key) return state.greet.g;
    let last = '';
    try { last = localStorage.getItem('pendukung_greet_last') || ''; } catch (e) {}
    const g = S.build({ nama: u.nama || u.username, jabatan: u.jabatan, panggilan: u.panggilan, zone: HH_ZONE,
      stats: greetStats(d || state.dashboardCache || {}), avoid: rotate && state.greet ? state.greet.g.pesan : last });
    state.greet = { key, g };
    try { localStorage.setItem('pendukung_greet_last', g.pesan); } catch (e) {}
    return g;
  }

  // ketuk kalimat sapaan → ganti kalimat (delegasi; elemen dibuat ulang tiap render)
  document.addEventListener('click', e => {
    const el = e.target.closest && e.target.closest('.js-greet');
    if (!el) return;
    const g = greetingFor(state.dashboardCache, true);
    el.classList.remove('greet-in'); void el.offsetWidth;
    el.textContent = g.pesan;
    el.classList.add('greet-in');
  });

  function renderDashboardData() {
    const c = $('appContent');
    const d = state.dashboardCache;
    if (!d || !c) return;
    const isUpdate = c.querySelector('.js-total') !== null;
    const persen = Math.min(100, Math.round((d.total / (d.target || 500)) * 100));
    STATS_PER_KAMPUNG = d.perKampung || {};
    STATS_VERIFIED_PER_KAMPUNG = d.kampungVerified || {};
    const totalVerified = d.verified || 0;
    const totalUnverified = d.unverified || 0;
    const totalAll = d.total || 0;
    const pct = n => totalAll > 0 ? Math.round((n / totalAll) * 100) : 0;
    const pctVerified = pct(totalVerified);
    const pctUnverified = totalAll > 0 ? (100 - pctVerified) : 0;
    const totalDicetak = d.dicetak || 0;
    const totalBelumCetak = d.belumCetak || 0;
    const pctDicetak = pct(totalDicetak);
    const pctBelumCetak = totalAll > 0 ? (100 - pctDicetak) : 0;

    const list = d.kampungList || KAMPUNG_LIST;
    const targetMap = d.targetPerKampung || TARGET_PER_KAMPUNG;
    const verifiedMap = d.kampungVerified || {};

    let kampungHtml = '';
    list.forEach((k, i) => {
      const jml = (d.perKampung || {})[k] || 0;
      const verifCount = verifiedMap[k] || 0;
      const target = parseInt(targetMap[k] || 0, 10);
      const p = target > 0 ? Math.min(100, Math.round((jml / target) * 100)) : 0;
      const detail = (target > 0 ? (jml + ' / ' + target + ' • ' + p + '%') : (jml + ' orang')) +
        (jml > 0 ? ' • ✅ ' + verifCount + ' (' + Math.round((verifCount / jml) * 100) + '%)' : '');
      kampungHtml +=
        '<div class="kampung-item" data-kampung="' + esc(k) + '" style="--c:' + CHART_COLORS[i % CHART_COLORS.length] + '">' +
          '<div class="kampung-info">' +
            '<div class="kampung-ico">' + ICONS.home + '</div>' +
            '<div class="kampung-txt">' +
              '<div class="kampung-name">' + esc(k) + '</div>' +
              '<div class="kampung-detail">' + detail + '</div>' +
              (target > 0 ? '<div class="kampung-bar"><div style="width:' + p + '%"></div></div>' : '') +
            '</div>' +
          '</div>' +
          '<div class="kampung-badge">' + jml + '<span class="arrow">' + ICONS.arrowRight + '</span></div>' +
        '</div>';
    });

    let warnHtml = '';
    if (d.unknownKampung && d.unknownKampung > 0) {
      warnHtml = '<div class="alert alert-danger">' + ICONS.warn + '<div>Ada <b>' + d.unknownKampung + '</b> kampung di database yang tidak ada di daftar pengaturan. Buka <b>Atur</b> untuk memperbarui.</div></div>';
    }

    const zn = { iana: HH_ZONE, label: HH_LABEL };
    const now = new Date();
    const tgl = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: zn.iana });
    const jam = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: zn.iana }).replace('.', ':');
    const greet = greetingFor(d);

    const dateCard =
      '<div class="date-chip">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' +
        '<div><div class="dc-d">' + esc(tgl) + '</div><div class="dc-t">' + esc(jam) + ' ' + esc(zn.label) + '</div></div>' +
      '</div>';

    const totalCard =
      '<div class="stat-card sc-total">' +
        '<div class="sc-ico ico-blue">' + ICONS.users + '</div>' +
        '<div class="stat-label">Total Pendukung</div>' +
        '<div class="stat-value js-total hero-number' + (isUpdate ? ' bump' : '') + '">' + fmtNum(d.total) + '</div>' +
        '<div class="stat-sub">Target: ' + fmtNum(d.target || 500) + ' orang</div>' +
        '<div class="sc-progress"><div style="width:' + persen + '%"></div></div>' +
        '<div class="sc-pct">' + persen + '% tercapai</div>' +
      '</div>';

    // Keterangan PASTI/BELUM selalu tepat di atas kartu hitung mundur Hari H
    // (slot 'top' tampil di desktop, slot 'mid' di HP — sama seperti kartu hitung mundur)
    const legendHtml = slot =>
      '<div class="legend-note legend-slot-' + slot + '">' +
        '<span><i class="lg-dot lg-verified"></i><b>PASTI</b> = Fotokopi KTP ber-TTD / TTD digital</span>' +
        '<span><i class="lg-dot lg-unverified"></i><b>BELUM</b> = Belum TTD</span>' +
      '</div>';

    c.innerHTML =
      pageHead(esc(greet.judul) + ' <span class="wave">' + greet.emoji + '</span>',
        '<span class="greet-msg js-greet" title="Ketuk untuk kalimat lain">' + esc(greet.pesan) + '</span>', dateCard) +
      warnHtml +
      legendHtml('top') +
      hariHBannerHtml(d.hariH, 'top') +
      // 7 kartu dalam satu grid: Total melebar 2 kolom (desktop: Total+Laki-laki+Perempuan | 4 kartu status; HP: Total 1 baris, sisanya 2 per baris)
      '<div class="stat-grid">' +
        totalCard +
        statCard('sc-laki', 'blue', ICONS.male, 'Laki-laki', fmtNum(d.laki), pct(d.laki) + '% dari total') +
        statCard('sc-perempuan', 'pink', ICONS.female, 'Perempuan', fmtNum(d.perempuan), pct(d.perempuan) + '% dari total') +
        statCard('verified-card', 'green', ICONS.shield, 'Suara PASTI', fmtNum(totalVerified), pctVerified + '% sudah verifikasi TTD') +
        statCard('unverified-card', 'slate', ICONS.clock, 'Suara Belum Pasti', fmtNum(totalUnverified), pctUnverified + '% belum verifikasi') +
        statCard('printed-card', 'indigo', ICONS.printer, 'Sudah Dicetak', fmtNum(totalDicetak), pctDicetak + '% sudah print out') +
        statCard('unprinted-card', 'amber', ICONS.printer, 'Belum Dicetak', fmtNum(totalBelumCetak), pctBelumCetak + '% belum print out') +
      '</div>' +
      legendHtml('mid') +
      hariHBannerHtml(d.hariH, 'mid') +            // HP: hitung mundur tepat di atas grafik per kampung

      // Urutan: grafik per kampung → rincian per kampung → aktivitas terbaru (paling bawah, khusus Super Admin)
      '<div class="dash-cols single">' +
        '<section class="card chart-card">' +
          '<div class="card-head">' +
            '<div class="card-title"><span class="ct-ico">' + ICONS.home + '</span>Data Pendukung per Kampung</div>' +
            '<span class="card-hint">Klik batang untuk detail</span>' +
          '</div>' +
          kampungChartHtml(list, d.perKampung || {}) +
        '</section>' +
      '</div>' +

      '<div class="section-title">Rincian per Kampung <span class="st-hint">Klik untuk detail</span></div>' +
      '<div class="kampung-list">' + kampungHtml + '</div>' +

      (isAdmin() ?
      '<div class="dash-cols single dash-activity">' +
        '<section class="card activity-card">' +
          '<div class="card-head">' +
            '<div class="card-title"><span class="ct-ico">' + ICONS.clock + '</span>Aktivitas Terbaru</div>' +
            '<button class="card-link" id="btnAllLogs" type="button">Lihat Semua ' + ICONS.arrowRight + '</button>' +
          '</div>' +
          '<div id="dashActivity">' + dashActivityHtml() + '</div>' +
        '</section>' +
      '</div>' : '');

    c.querySelectorAll('[data-kampung]').forEach(el => {
      el.addEventListener('click', () => {
        const k = el.getAttribute('data-kampung');
        if (k) openDetailKampung(k);
      });
    });
    const allLogs = $('btnAllLogs');
    if (allLogs) allLogs.addEventListener('click', () => setPage('logs'));
    loadDashLogs(false);
    c.querySelectorAll('.js-hh-manage').forEach(b => b.addEventListener('click', () => setPage('pengaturan')));
  }

  // ============================================================ //
  // ⭐ HALAMAN DETAIL KAMPUNG (dengan Sort A-Z)                   //
  // ============================================================ //

  /** Judul kolom tabel detail kampung — dipakai tabel di layar DAN PDF agar selalu sama */
  const DETAIL_KAMPUNG_COLS = ['NO', 'NIK', 'NAMA', 'TEMPAT LAHIR', 'TANGGAL LAHIR', 'UMUR', 'STATUS PERKAWINAN', 'JENIS KELAMIN', 'ALAMAT', 'STATUS'];

  /** "1990-03-25" → "25-03-1990" (format ringkas untuk tabel); kosong → '-' */
  function formatTglTabel(ymd) {
    const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return m[3] + '-' + m[2] + '-' + m[1];
    return ymd ? String(ymd) : '-';
  }

  /**
   * Isi satu baris tabel detail kampung (urutan = DETAIL_KAMPUNG_COLS).
   * @returns {{no: string, nik: string, nama: string, tempatLahir: string, tanggalLahir: string, umur: string,
   *   statusPerkawinan: string, jenisKelamin: string, alamat: string, status: string, verified: boolean}}
   */
  function detailKampungRow(p, idx) {
    const dash = v => (String(v == null ? '' : v).trim() || '-');
    const rt = normRT(p.rt);
    const kampung = String(p.kampung || '').trim();
    return {
      no: String(idx + 1),
      nik: dash(p.nik),
      nama: dash(p.nama),
      tempatLahir: dash(p.tempatLahir),
      tanggalLahir: formatTglTabel(p.tanggalLahir),
      umur: p.usia ? String(p.usia) : '-',
      statusPerkawinan: dash(p.statusPerkawinan),
      jenisKelamin: dash(p.jenisKelamin),
      alamat: kampung ? 'Kp. ' + kampung + ' ' + rtLabel(rt) : rtLabel(rt),
      status: p.verified === true ? 'PASTI' : 'BELUM',
      verified: p.verified === true
    };
  }

  function detailKampungRowArray(r) {
    return [r.no, r.nik, r.nama, r.tempatLahir, r.tanggalLahir, r.umur, r.statusPerkawinan, r.jenisKelamin, r.alamat, r.status];
  }

  function renderDetailKampung() {
    const c = $('appContent');
    if (!c) return;
    const kampung = state.detailKampung;
    if (!kampung) { closeDetailKampung(); return; }

    if (!state.allData) {
      c.innerHTML = '<div class="page-loading"><div class="spinner"></div><p>Memuat data...</p></div>';
      const token = state.pageToken;
      state.detailLoading = true;
      fetchAndReplace(false, () => {
        state.detailLoading = false;
        if (isStillOn(token, 'detail-kampung')) renderDetailKampung();
      });
      return;
    }

    const kampungKey = String(kampung).trim().toLowerCase();
    const allList = state.allData || [];
    const listKampung = allList.filter(x => String(x.kampung || '').trim().toLowerCase() === kampungKey);

    // Hitung per RT
    const rtCounts = {};
    RT_LIST.forEach(rt => rtCounts[rt] = 0);
    listKampung.forEach(x => {
      const rt = normRT(x.rt);
      rtCounts[rt] = (rtCounts[rt] || 0) + 1;
    });

    // Filter
    let filtered = listKampung;
    if (state.detailFilterRT) {
      const targetRT = normRT(state.detailFilterRT);
      filtered = filtered.filter(x => normRT(x.rt) === targetRT);
    }

    if (state.detailFilterVerif === 'true') {
      filtered = filtered.filter(x => x.verified === true);
    } else if (state.detailFilterVerif === 'false') {
      filtered = filtered.filter(x => x.verified !== true);
    }

    const verifiedInRT = filtered.filter(x => x.verified === true).length;
    const unverifiedInRT = filtered.filter(x => x.verified !== true).length;
    const totalInRT = filtered.length;

    // ⭐ SORT LOGIC: A-Z atau Z-A atau Default (by RT lalu nama)
    filtered = filtered.slice();
    if (state.detailSortAZ === 'asc') {
      filtered.sort((a, b) => (a.nama || '').localeCompare(b.nama || '', 'id', { sensitivity: 'base' }));
    } else if (state.detailSortAZ === 'desc') {
      filtered.sort((a, b) => (b.nama || '').localeCompare(a.nama || '', 'id', { sensitivity: 'base' }));
    } else {
      // Default: by RT lalu nama
      filtered.sort((a, b) => {
        const rtA = normRT(a.rt), rtB = normRT(b.rt);
        if (rtA !== rtB) return rtA.localeCompare(rtB);
        return (a.nama || '').localeCompare(b.nama || '', 'id', { sensitivity: 'base' });
      });
    }

    const verifiedInView = filtered.filter(x => x.verified === true).length;
    const unverifiedInView = filtered.length - verifiedInView;

    // RT chips
    let rtChipsHtml = '';
    const totalAllKampung = listKampung.length;
    const activeAll = !state.detailFilterRT ? 'active' : '';
    rtChipsHtml += '<button class="rt-chip ' + activeAll + '" data-rt="" type="button">Semua <span class="count">' + totalAllKampung + '</span></button>';
    RT_LIST.forEach(rt => {
      const cnt = rtCounts[rt] || 0;
      if (cnt === 0) return;
      const active = (state.detailFilterRT && normRT(state.detailFilterRT) === rt) ? 'active' : '';
      const label = rt === RT_UMUM ? 'UMUM' : ('RT ' + rt);
      rtChipsHtml += '<button class="rt-chip ' + active + '" data-rt="' + rt + '" type="button">' + label + ' <span class="count">' + cnt + '</span></button>';
    });

    // Verif chips
    const vchipAllActive = state.detailFilterVerif === '' ? 'active' : '';
    const vchipVActive = state.detailFilterVerif === 'true' ? 'active verified' : '';
    const vchipUActive = state.detailFilterVerif === 'false' ? 'active unverified' : '';

    const vChipsHtml =
      '<button class="vchip ' + vchipAllActive + '" data-vfilter="" type="button">' +
        ICONS.users + ' Semua <span class="count">' + totalInRT + '</span>' +
      '</button>' +
      '<button class="vchip ' + vchipVActive + '" data-vfilter="true" type="button">' +
        ICONS.shield + ' PASTI <span class="count">' + verifiedInRT + '</span>' +
      '</button>' +
      '<button class="vchip ' + vchipUActive + '" data-vfilter="false" type="button">' +
        ICONS.clock + ' Belum <span class="count">' + unverifiedInRT + '</span>' +
      '</button>';

    // ⭐ SORT BUTTON: toggle A-Z <-> Z-A
    const sortIsAsc = state.detailSortAZ !== 'desc';
    const sortLabel = sortIsAsc ? 'A - Z' : 'Z - A';
    const sortIcon = sortIsAsc ? ICONS.sortAZ : ICONS.sortZA;
    const sortBtnHtml =
      '<button class="sort-btn ' + (state.detailSortAZ !== 'default' ? 'active' : '') + '" id="btnSortAZ" type="button" title="Urutkan berdasarkan nama">' +
        sortIcon + ' <span>' + sortLabel + '</span>' +
      '</button>';

    const rtLbl = state.detailFilterRT ? (state.detailFilterRT === RT_UMUM ? 'UMUM' : ('RT ' + normRT(state.detailFilterRT))) : 'Semua RT';
    const verifLabel = state.detailFilterVerif === 'true' ? ' • PASTI' : (state.detailFilterVerif === 'false' ? ' • Belum' : '');
    const headerTitle = 'Kp. ' + kampung;

    let tableHtml = '';
    if (filtered.length === 0) {
      tableHtml =
        '<div class="table-empty">' +
          '<div class="big">📭</div>' +
          '<h4>Tidak Ada Data</h4>' +
          '<p>Belum ada pendukung untuk filter ini</p>' +
        '</div>';
    } else {
      // kelas per kolom (urutan = DETAIL_KAMPUNG_COLS) untuk perataan & lebar
      const colCls = ['col-no', 'col-nik', 'col-nama', 'col-tempat', 'col-tgl', 'col-umur', 'col-kawin', 'col-jk', 'col-alamat', 'col-status'];
      tableHtml = '<div class="table-scroll-hint">↔ Geser tabel ke samping untuk melihat semua kolom</div>' +
        '<div class="table-scroll"><table class="data-table data-table-wide"><thead><tr>' +
        DETAIL_KAMPUNG_COLS.map((h, i) => '<th class="' + colCls[i] + '">' + h + '</th>').join('') +
        '</tr></thead><tbody>';
      filtered.forEach((p, idx) => {
        const r = detailKampungRow(p, idx);
        const cells = detailKampungRowArray(r);
        tableHtml += '<tr>' + cells.map((v, i) => {
          if (colCls[i] === 'col-status') {
            const cls = r.verified ? 'verified' : 'unverified';
            return '<td class="col-status"><span class="status-pill ' + cls + '"><span class="status-dot ' + cls + '"></span>' + esc(v) + '</span></td>';
          }
          return '<td class="' + colCls[i] + (v === '-' ? ' is-empty' : '') + '">' + esc(v) + '</td>';
        }).join('') + '</tr>';
      });
      tableHtml += '</tbody></table></div>';
      tableHtml += '<div class="table-footer">Total: ' + filtered.length + ' data' +
        (state.detailFilterRT ? (' • ' + (state.detailFilterRT === RT_UMUM ? 'UMUM' : ('RT ' + normRT(state.detailFilterRT)))) : '') +
        (state.detailFilterVerif === 'true' ? ' • ✅ PASTI' : (state.detailFilterVerif === 'false' ? ' • ⏳ Belum' : '')) +
        '</div>';
    }

    c.innerHTML =
      '<div class="detail-header">' +
        '<div class="detail-top">' +
          '<button class="detail-back" id="btnBackDetail" title="Kembali" type="button">' + ICONS.arrowLeft + '</button>' +
          '<div class="detail-title-block">' +
            '<div class="detail-label">DETAIL KAMPUNG</div>' +
            '<div class="detail-title">' + esc(headerTitle) + '</div>' +
            '<div class="detail-subtitle">' + rtLbl + verifLabel + ' • ' + filtered.length + ' data</div>' +
          '</div>' +
        '</div>' +
        '<div class="detail-stats">' +
          '<div class="detail-stat"><div class="n">' + filtered.length + '</div><div class="l">Tampil</div></div>' +
          '<div class="detail-stat" style="background:rgba(16,185,129,.15);border-color:rgba(16,185,129,.3)"><div class="n">' + verifiedInView + '</div><div class="l">✅ Pasti</div></div>' +
          '<div class="detail-stat" style="background:rgba(148,163,184,.15);border-color:rgba(148,163,184,.3)"><div class="n">' + unverifiedInView + '</div><div class="l">⏳ Belum</div></div>' +
        '</div>' +
      '</div>' +

      '<div class="detail-filter">' +
        '<div class="detail-filter-label">Filter RT</div>' +
        '<div class="rt-chips">' + rtChipsHtml + '</div>' +
      '</div>' +

      '<div class="detail-filter">' +
        '<div class="detail-filter-label">Filter Verifikasi</div>' +
        '<div class="filter-verified-bar" style="margin-top:0">' + vChipsHtml + '</div>' +
      '</div>' +

      // ⭐ SORT BAR
      '<div class="detail-sort-bar">' +
        '<div class="detail-sort-label">' + ICONS.sortAZ + ' Urutkan Nama</div>' +
        '<div class="detail-sort-buttons">' +
          sortBtnHtml +
        '</div>' +
      '</div>' +

      '<div class="detail-actions">' +
        (!roleOperate() ? '' :
        '<button class="btn-download" id="btnDownloadPdf" ' + (filtered.length === 0 ? 'disabled' : '') + ' type="button">' +
          ICONS.download + ' Download PDF (A4)' +
        '</button>' +
        '<button class="btn-download btn-xlsx" id="btnDownloadXlsx" ' + (filtered.length === 0 ? 'disabled' : '') + ' type="button" title="Unduh spreadsheet; jika Semua RT, dibuat 1 sheet per RT">' +
          ICONS.download + ' Download XLSX' +
        '</button>') +
      '</div>' +

      '<div class="table-wrap">' + tableHtml + '</div>';

    // Petunjuk "geser" hanya bila tabel lebih lebar dari layar; hilang setelah tabel digeser
    const tScroll = c.querySelector('.table-scroll');
    const tHint = c.querySelector('.table-scroll-hint');
    if (tScroll && tHint) {
      tScroll.addEventListener('scroll', () => tHint.classList.remove('show'), { once: true, passive: true });
      setTimeout(() => {
        tHint.classList.toggle('show', tScroll.scrollWidth > tScroll.clientWidth + 4);
      }, 60);
    }

    // Bind back
    const btnBack = $('btnBackDetail');
    if (btnBack) btnBack.addEventListener('click', closeDetailKampung);

    // Bind RT chips
    c.querySelectorAll('.rt-chip').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rtValue = btn.getAttribute('data-rt') || '';
        state.detailFilterRT = rtValue;
        renderDetailKampung();
      });
    });

    // Bind Verif chips
    c.querySelectorAll('[data-vfilter]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const vValue = btn.getAttribute('data-vfilter') || '';
        state.detailFilterVerif = vValue;
        renderDetailKampung();
      });
    });

    // ⭐ Bind Sort button
    const btnSort = $('btnSortAZ');
    if (btnSort) {
      btnSort.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Toggle: asc -> desc -> asc (tidak balik ke default)
        if (state.detailSortAZ === 'asc') {
          state.detailSortAZ = 'desc';
        } else {
          state.detailSortAZ = 'asc';
        }
        renderDetailKampung();
      });
    }

    // Bind Download
    const btnDl = $('btnDownloadPdf');
    if (btnDl) {
      btnDl.addEventListener('click', () => {
        downloadPdfDetail(kampung, state.detailFilterRT, state.detailFilterVerif, filtered);
      });
    }

    // Bind Download XLSX
    const btnDlX = $('btnDownloadXlsx');
    if (btnDlX) {
      btnDlX.addEventListener('click', () => {
        downloadXlsxDetail(kampung, state.detailFilterRT, state.detailFilterVerif, filtered);
      });
    }
  }

  // ============================================================ //
  // EXPORT PDF A4                                                 //
  // ============================================================ //
  function downloadPdfDetail(kampung, rtFilter, verifFilter, dataList) {
    if (state.pdfGenerating) return;
    state.pdfGenerating = true;
    const btn = $('btnDownloadPdf');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0;border-color:rgba(255,255,255,.4);border-top-color:#fff"></div> Membuat PDF...';
    }

    try {
      const { jsPDF } = window.jspdf;
      if (!jsPDF) {
        toast('Library PDF belum siap. Coba lagi sebentar.', 'error');
        resetPdfButton();
        return;
      }

      // A4 mendatar: 9 kolom (NO s.d. ALAMAT) muat & tetap terbaca
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const marginL = 10;
      const marginR = 10;
      const marginT = 12;
      const marginB = 14;

      let y = marginT;

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(13, 110, 63);
      doc.text('DATA KTP DUKUNGAN UNTUK PAK MUHAIMIN (PAK EMEN)', pageW / 2, y, { align: 'center' });
      y += 7;

      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      const rtLbl = rtFilter
        ? (rtFilter === RT_UMUM ? 'UMUM' : ('RT ' + normRT(rtFilter)))
        : 'Semua RT';
      let verifLbl = '';
      if (verifFilter === 'true') verifLbl = '  |  STATUS: PASTI';
      else if (verifFilter === 'false') verifLbl = '  |  STATUS: BELUM PASTI';
      else verifLbl = '  |  STATUS: SEMUA';

      doc.text('PADA PILKADES SERUNI MUMBUL 2026  |  Kp. ' + kampung + ' ' + rtLbl + verifLbl, pageW / 2, y, { align: 'center' });
      y += 4;

      doc.setDrawColor(13, 110, 63);
      doc.setLineWidth(0.5);
      doc.line(marginL, y, pageW - marginR, y);
      y += 6;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(71, 85, 105);
      doc.text('Total: ' + dataList.length + ' pendukung  |  Dicetak: ' + formatTanggalIndo(new Date()), marginL, y);
      y += 5;

      // PDF memakai kolom yang sama dengan tabel di layar, KECUALI kolom STATUS (suara PASTI/BELUM tidak ikut dicetak)
      const COL_STATUS = DETAIL_KAMPUNG_COLS.indexOf('STATUS');
      const pdfCols = DETAIL_KAMPUNG_COLS.filter((h, i) => i !== COL_STATUS);
      const bodyRows = dataList.map((p, idx) => detailKampungRowArray(detailKampungRow(p, idx)).filter((v, i) => i !== COL_STATUS));
      const TOTAL_PAGES = '{total}';

      doc.autoTable({
        startY: y,
        head: [pdfCols],
        body: bodyRows,
        theme: 'grid',
        headStyles: {
          fillColor: [13, 110, 63],
          textColor: [255, 255, 255],
          fontStyle: 'bold',
          fontSize: 7.5,
          halign: 'center',
          valign: 'middle',
          cellPadding: 1.8
        },
        bodyStyles: {
          fontSize: 8,
          textColor: [15, 23, 42],
          cellPadding: 1.8,
          valign: 'middle',
          overflow: 'linebreak'
        },
        alternateRowStyles: { fillColor: [240, 253, 244] },
        // lebar total = 277 mm (A4 mendatar dikurangi margin); NAMA mengambil sisa ruang
        columnStyles: {
          0: { cellWidth: 10, halign: 'center', fontStyle: 'bold' },   // NO
          1: { cellWidth: 33, halign: 'left', font: 'courier' },       // NIK
          2: { cellWidth: 'auto', halign: 'left' },                    // NAMA
          3: { cellWidth: 26, halign: 'left' },                        // TEMPAT LAHIR
          4: { cellWidth: 21, halign: 'center' },                      // TANGGAL LAHIR
          5: { cellWidth: 12, halign: 'center' },                      // UMUR
          6: { cellWidth: 23, halign: 'center' },                      // STATUS PERKAWINAN
          7: { cellWidth: 20, halign: 'center' },                      // JENIS KELAMIN
          8: { cellWidth: 42, halign: 'left' }                         // ALAMAT (Kampung + RT)
        },
        margin: { left: marginL, right: marginR, top: marginT, bottom: marginB },
        didDrawPage: function(data) {
          const pageNum = doc.internal.getCurrentPageInfo().pageNumber;
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(148, 163, 184);
          // jumlah halaman belum diketahui saat halaman digambar → ditulis placeholder, diganti setelah tabel selesai
          doc.text('Halaman ' + pageNum + ' dari ' + TOTAL_PAGES, pageW / 2, pageH - 8, { align: 'center' });
          doc.text('Data Pendukung Pak Emen - Pilkades 2026', marginL, pageH - 8);
        }
      });
      if (typeof doc.putTotalPages === 'function') doc.putTotalPages(TOTAL_PAGES);

      const statusSuffix = verifFilter === 'true' ? '_PASTI' : (verifFilter === 'false' ? '_BELUM' : '_SEMUA');
      const rtSuffix = rtFilter ? ('_' + (rtFilter === RT_UMUM ? 'UMUM' : ('RT_' + normRT(rtFilter)))) : '_SemuaRT';
      const sortSuffix = state.detailSortAZ === 'desc' ? '_ZA' : '_AZ';
      const namaFile = 'Data_KTP_' + slugify(kampung) + rtSuffix + statusSuffix + sortSuffix + '_' + formatTanggalFile(new Date()) + '.pdf';
      doc.save(namaFile);
      toast('✅ PDF berhasil di-download', 'success');
      logDownload('PDF_KAMPUNG', 'PDF A4 ' + kampung + ' — ' + (rtFilter ? (rtFilter === RT_UMUM ? 'UMUM' : 'RT ' + normRT(rtFilter)) : 'semua RT') +
        ' — ' + (verifFilter === 'true' ? 'PASTI' : verifFilter === 'false' ? 'BELUM PASTI' : 'semua status') + ' (' + dataList.length + ' data)');
    } catch (e) {
      console.error('PDF Error:', e);
      toast('Gagal buat PDF: ' + e.message, 'error');
    } finally {
      resetPdfButton();
    }
  }

  function resetPdfButton() {
    state.pdfGenerating = false;
    const btn = $('btnDownloadPdf');
    if (btn) { btn.disabled = false; btn.innerHTML = ICONS.download + ' Download PDF (A4)'; }
  }

  // ============================================================ //
  // EXPORT XLSX — filter & urutan sama dengan PDF.               //
  //  • Filter RT tertentu → 1 sheet berisi RT tersebut.          //
  //  • Filter "Semua RT"  → 1 sheet per RT (data dikelompokkan   //
  //    per RT, BUKAN satu sheet berisi semua data).             //
  //  • Kolom = kolom PDF (tabel layar KECUALI STATUS).           //
  // ============================================================ //
  function downloadXlsxDetail(kampung, rtFilter, verifFilter, dataList) {
    if (state.xlsxGenerating) return;
    state.xlsxGenerating = true;
    const btn = $('btnDownloadXlsx');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0;border-color:rgba(255,255,255,.4);border-top-color:#fff"></div> Membuat XLSX...';
    }

    try {
      const W = window.XlsxWriter;
      if (!W) {
        toast('Library XLSX belum siap. Coba lagi sebentar.', 'error');
        resetXlsxButton();
        return;
      }

      const COL_STATUS = DETAIL_KAMPUNG_COLS.indexOf('STATUS');
      const cols = DETAIL_KAMPUNG_COLS.filter((h, i) => i !== COL_STATUS).concat(['TTD']);
      const nCol = cols.length;
      const lastColLetter = String.fromCharCode(65 + nCol - 1);   // kolom terakhir: 'J'
      const now = new Date();
      const statusLbl = verifFilter === 'true' ? 'PASTI' : (verifFilter === 'false' ? 'BELUM PASTI' : 'SEMUA');

      // Kelompokkan per RT
      const groups = [];
      if (rtFilter) {
        groups.push({ rt: normRT(rtFilter), rows: dataList.slice() });
      } else {
        const byRT = {};
        RT_LIST.forEach(rt => { byRT[rt] = []; });
        dataList.forEach(p => {
          const rt = normRT(p.rt);
          if (!byRT[rt]) byRT[rt] = [];
          byRT[rt].push(p);
        });
        Object.keys(byRT).forEach(rt => { if (byRT[rt].length) groups.push({ rt, rows: byRT[rt] }); });
        // Urutan sheet mengikuti urutan RT resmi, lalu RT lain (bila ada)
        groups.sort((a, b) => {
          const ia = RT_LIST.indexOf(a.rt), ib = RT_LIST.indexOf(b.rt);
          const xa = ia === -1 ? 999 : ia, xb = ib === -1 ? 999 : ib;
          return xa !== xb ? xa - xb : a.rt.localeCompare(b.rt);
        });
      }

      const book = {
        title: 'Data KTP Dukungan - Kp. ' + kampung,
        creator: 'Suara Pendukung',
        sheets: []
      };

      groups.forEach(g => {
        const rtLbl = g.rt === RT_UMUM ? 'UMUM' : ('RT ' + g.rt);
        const cells = [
          // Baris 1-3: judul (digabung menyilang seluruh kolom)
          [{ v: 'DATA KTP DUKUNGAN UNTUK PAK MUHAIMIN (PAK EMEN)', bold: true, sz: 13, color: '0D6E3F', align: 'center' }],
          [{ v: 'PADA PILKADES SERUNI MUMBUL 2026  |  Kp. ' + kampung + ' ' + rtLbl + '  |  STATUS: ' + statusLbl, bold: true, sz: 11, color: '0F172A', align: 'center' }],
          [{ v: 'Total: ' + g.rows.length + ' pendukung  |  Dicetak: ' + formatTanggalIndo(now), sz: 9, color: '475569', align: 'center' }],
          [],   // baris kosong (pemisah)
          // Baris 5: judul kolom
          cols.map(h => ({ v: h, bold: true, sz: 10, color: 'FFFFFF', fill: '0D6E3F', align: 'center', wrap: true, border: true }))
        ];
        // Baris data
        g.rows.forEach((p, idx) => {
          const arr = detailKampungRowArray(detailKampungRow(p, idx)).filter((v, i) => i !== COL_STATUS);
          arr.push(ttdUrlValue(p));                                    // kolom TTD: tautan bukti TTD
          const center = [0, 4, 5, 6, 7];                 // NO, TGL LAHIR, UMUR, KAWIN, JK
          cells.push(arr.map((v, c) => {
            const isNum = (c === 0) || (c === 5 && /^\d+$/.test(v));   // NO & UMUR sebagai angka
            const isTtd = c === cols.length - 1;                       // kolom TTD terakhir
            return {
              v: isNum ? Number(v) : v,
              sz: 10, color: isTtd ? '1D4ED8' : '0F172A',
              align: center.indexOf(c) !== -1 ? 'center' : 'left',
              border: true,
              fill: (idx % 2 === 1) ? 'F0FDF4' : null
            };
          }));
        });

        book.sheets.push({
          name: (g.rt === RT_UMUM ? 'UMUM' : 'RT ' + g.rt).replace(/[\[\]:*?/\\]/g, '-').slice(0, 31),
          colWidths: [5, 20, 30, 17, 14, 7, 18, 14, 28, 40],
          rowHeights: { 0: 20, 1: 17, 2: 14, 3: 8, 4: 32 },
          merges: [
            'A1:' + lastColLetter + '1',
            'A2:' + lastColLetter + '2',
            'A3:' + lastColLetter + '3'
          ],
          cells: cells
        });
      });

      const statusSuffix = verifFilter === 'true' ? '_PASTI' : (verifFilter === 'false' ? '_BELUM' : '_SEMUA');
      const rtSuffix = rtFilter ? ('_' + (rtFilter === RT_UMUM ? 'UMUM' : ('RT_' + normRT(rtFilter)))) : '_SemuaRT';
      const sortSuffix = state.detailSortAZ === 'desc' ? '_ZA' : '_AZ';
      const namaFile = 'Data_KTP_' + slugify(kampung) + rtSuffix + statusSuffix + sortSuffix + '_' + formatTanggalFile(now) + '.xlsx';
      W.save(book, namaFile);
      toast('✅ XLSX berhasil di-download', 'success');
      logDownload('XLSX_KAMPUNG', 'XLSX ' + kampung + ' — ' +
        (rtFilter ? (rtFilter === RT_UMUM ? 'UMUM' : 'RT ' + normRT(rtFilter)) : 'semua RT (' + groups.length + ' sheet, per RT)') +
        ' — ' + (verifFilter === 'true' ? 'PASTI' : verifFilter === 'false' ? 'BELUM PASTI' : 'semua status') +
        ' (' + dataList.length + ' data)');
    } catch (e) {
      console.error('XLSX Error:', e);
      toast('Gagal buat XLSX: ' + e.message, 'error');
    } finally {
      resetXlsxButton();
    }
  }

  function resetXlsxButton() {
    state.xlsxGenerating = false;
    const btn = $('btnDownloadXlsx');
    if (btn) { btn.disabled = false; btn.innerHTML = ICONS.download + ' Download XLSX'; }
  }

  /** URL bukti TTD untuk isi kolom TTD di XLSX — absolut agar tautan bisa dibuka. Kosong → '-' */
  function ttdUrlValue(p) {
    if (!p) return '-';
    const raw = p.fotoTTD || (p.fotoTTDId ? '/api/photo?id=' + encodeURIComponent(p.fotoTTDId) : '');
    if (!raw) return '-';
    return /^https?:\/\//i.test(raw) ? raw : ((window.location.origin || '') + raw);
  }

  function resetMassalPdfButton() {
    state.massalPdfGenerating = false;
    const btn = $('btnMassalPdf');
    if (btn) { btn.disabled = false; btn.innerHTML = ICONS.download + ' Download PDF'; }
  }

  function resetMassalXlsxButton() {
    state.massalXlsxGenerating = false;
    const btn = $('btnMassalXlsx');
    if (btn) { btn.disabled = false; btn.innerHTML = ICONS.download + ' Download XLSX'; }
  }

  /** Kelompokkan semua data → [ { kampung, subsets: [{ rt, rows }] } ] menurut urutan KAMPUNG_LIST & RT_LIST (nama diurutkan A–Z). */
  function _kelompokMassal() {
    const data = state.allData || [];
    const byKampung = {};
    data.forEach(p => {
      const k = String(p.kampung || '').trim();
      if (!byKampung[k]) { byKampung[k] = []; }
      byKampung[k].push(p);
    });
    const kampungs = Object.keys(byKampung).sort((a, b) => {
      const ia = KAMPUNG_LIST.indexOf(a), ib = KAMPUNG_LIST.indexOf(b);
      const xa = ia === -1 ? 999 : ia, xb = ib === -1 ? 999 : ib;
      return xa !== xb ? xa - xb : a.localeCompare(b);
    });
    return kampungs.map(k => {
      const byRt = {};
      RT_LIST.forEach(rt => { byRt[rt] = []; });
      byKampung[k].forEach(p => {
        const rt = normRT(p.rt);
        if (!byRt[rt]) { byRt[rt] = []; }
        byRt[rt].push(p);
      });
      const subsets = [];
      let azDesc = state.filter.sortAz === 'desc';
      Object.keys(byRt).forEach(rt => {
        if (!byRt[rt].length) { return; }
        // Urutkan dalam tiap RT mengikuti tombol Urutkan Nama A–Z/Z–A (default: A–Z)
        byRt[rt].sort((a, b) => azDesc
          ? (b.nama || '').localeCompare(a.nama || '', 'id', { sensitivity: 'base' })
          : (a.nama || '').localeCompare(b.nama || '', 'id', { sensitivity: 'base' }));
        subsets.push({ rt, rows: byRt[rt] });
      });
      subsets.sort((a, b) => {
        const ia = RT_LIST.indexOf(a.rt), ib = RT_LIST.indexOf(b.rt);
        const xa = ia === -1 ? 999 : ia, xb = ib === -1 ? 999 : ib;
        return xa !== xb ? xa - xb : a.rt.localeCompare(b.rt);
      });
      return { kampung: k, subsets };
    });
  }

  // ============================================================ //
  // DOWNLOAD MASSAL — SEMUA KAMPUNG (tombol di halaman Data)     //
  // ============================================================ //
  window.__downloadMassalPdf = function() {
    if (state.massalPdfGenerating) { return; }
    if (!state.allData || !state.allData.length) { toast('Belum ada data untuk diunduh', 'warn'); return; }
    state.massalPdfGenerating = true;
    const btn = $('btnMassalPdf');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0;border-color:rgba(255,255,255,.4);border-top-color:#fff"></div> Membuat PDF...';
    }
    try {
      const { jsPDF } = window.jspdf;
      if (!jsPDF) { toast('Library PDF belum siap. Coba lagi sebentar.', 'error'); resetMassalPdfButton(); return; }

      const kampungGroups = _kelompokMassal();
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const marginL = 10, marginR = 10, marginT = 12, marginB = 14;
      const TOTAL_PAGES = '{total}';
      const footerPages = {};
      let y = marginT;

      doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(13, 110, 63);
      doc.text('DATA KTP DUKUNGAN UNTUK PAK MUHAIMIN (PAK EMEN)', pageW / 2, y, { align: 'center' }); y += 7;
      doc.setFontSize(11); doc.setTextColor(15, 23, 42);
      doc.text('PADA PILKADES SERUNI MUMBUL 2026  |  SEMUA KAMPUNG  |  STATUS: SEMUA', pageW / 2, y, { align: 'center' }); y += 4;
      doc.setDrawColor(13, 110, 63); doc.setLineWidth(0.5);
      doc.line(marginL, y, pageW - marginR, y); y += 6;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(71, 85, 105);
      doc.text('Total: ' + state.allData.length + ' pendukung  |  Dicetak: ' + formatTanggalIndo(new Date()), marginL, y); y += 6;

      const COL_STATUS = DETAIL_KAMPUNG_COLS.indexOf('STATUS');
      const pdfCols = DETAIL_KAMPUNG_COLS.filter((h, i) => i !== COL_STATUS);

      kampungGroups.forEach((g, gi) => {
        if (gi > 0 && y > pageH - marginB - 24) { doc.addPage(); y = marginT; }
        const jumlahKampung = g.subsets.reduce((s, x) => s + x.rows.length, 0);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(13, 110, 63);
        doc.text('Kp. ' + g.kampung, marginL, y);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(71, 85, 105);
        doc.text(' (' + jumlahKampung + ' pendukung)', marginL + doc.getTextWidth('Kp. ' + g.kampung + ' ') + 1, y);
        y += 3.5;
        doc.setLineWidth(0.3); doc.line(marginL, y, pageW - marginR, y); y += 5;

        g.subsets.forEach(s => {
          if (y > pageH - marginB - 30) { doc.addPage(); y = marginT; }
          const rtLbl = s.rt === RT_UMUM ? 'UMUM' : ('RT ' + s.rt);
          doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(30, 41, 59);
          doc.text(rtLbl + '  (' + s.rows.length + ')', marginL, y); y += 3.5;

          const bodyRows = s.rows.map((p, idx) => detailKampungRowArray(detailKampungRow(p, idx)).filter((v, i) => i !== COL_STATUS));
          doc.autoTable({
            startY: y, head: [pdfCols], body: bodyRows, theme: 'grid',
            headStyles: { fillColor: [13, 110, 63], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.5, halign: 'center', valign: 'middle', cellPadding: 1.8 },
            bodyStyles: { fontSize: 8, textColor: [15, 23, 42], cellPadding: 1.8, valign: 'middle', overflow: 'linebreak' },
            alternateRowStyles: { fillColor: [240, 253, 244] },
            columnStyles: {
              0: { cellWidth: 10, halign: 'center', fontStyle: 'bold' },
              1: { cellWidth: 33, halign: 'left', font: 'courier' },
              2: { cellWidth: 'auto', halign: 'left' },
              3: { cellWidth: 26, halign: 'left' },
              4: { cellWidth: 21, halign: 'center' },
              5: { cellWidth: 12, halign: 'center' },
              6: { cellWidth: 23, halign: 'center' },
              7: { cellWidth: 20, halign: 'center' },
              8: { cellWidth: 42, halign: 'left' }
            },
            margin: { left: marginL, right: marginR, top: marginT, bottom: marginB },
            didDrawPage: function(data) {
              const pageNum = doc.internal.getCurrentPageInfo().pageNumber;
              if (footerPages[pageNum]) { return; }   // setiap halaman hanya sekali footernya
              footerPages[pageNum] = true;
              doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(148, 163, 184);
              doc.text('Halaman ' + pageNum + ' dari ' + TOTAL_PAGES, pageW / 2, pageH - 8, { align: 'center' });
              doc.text('Data Pendukung Pak Emen - Pilkades 2026', marginL, pageH - 8);
            }
          });
          y = doc.lastAutoTable.finalY + 5;
        });
        y += 2;
      });

      if (typeof doc.putTotalPages === 'function') { doc.putTotalPages(TOTAL_PAGES); }
      const namaFile = 'Data_KTP_SEMUA_KAMPUNG_AZ_' + formatTanggalFile(new Date()) + '.pdf';
      doc.save(namaFile);
      toast('✅ PDF berhasil di-download', 'success');
      logDownload('PDF_MASSAL', 'PDF A4 SEMUA KAMPUNG (' + state.allData.length + ' data)');
    } catch (e) {
      console.error('PDF MASSAL Error:', e);
      toast('Gagal buat PDF: ' + e.message, 'error');
    } finally {
      resetMassalPdfButton();
    }
  };

  window.__downloadMassalXlsx = function() {
    if (state.massalXlsxGenerating) { return; }
    if (!state.allData || !state.allData.length) { toast('Belum ada data untuk diunduh', 'warn'); return; }
    state.massalXlsxGenerating = true;
    const btn = $('btnMassalXlsx');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0;border-color:rgba(255,255,255,.4);border-top-color:#fff"></div> Membuat XLSX...';
    }
    try {
      const W = window.XlsxWriter;
      if (!W) { toast('Library XLSX belum siap. Coba lagi sebentar.', 'error'); resetMassalXlsxButton(); return; }

      const kampungGroups = _kelompokMassal();
      const COL_STATUS = DETAIL_KAMPUNG_COLS.indexOf('STATUS');
      const cols = DETAIL_KAMPUNG_COLS.filter((h, i) => i !== COL_STATUS).concat(['TTD']);
      const nCol = cols.length;
      const lastColLetter = String.fromCharCode(65 + nCol - 1);
      const now = new Date();

      const book = { title: 'Data KTP Dukungan — Semua Kampung', creator: 'Suara Pendukung', sheets: [] };

      kampungGroups.forEach(g => {
        const jumlah = g.subsets.reduce((s, x) => s + x.rows.length, 0);
        const cells = [];
        const merges = [];
        const rowHeights = {};
        let rIndex = 0;

        // Baris 1-3: judul (digabung menyilang)
        cells.push([{ v: 'DATA KTP DUKUNGAN UNTUK PAK MUHAIMIN (PAK EMEN)', bold: true, sz: 13, color: '0D6E3F', align: 'center' }]);
        merges.push('A' + (rIndex + 1) + ':' + lastColLetter + (rIndex + 1)); rowHeights[rIndex] = 20; rIndex++;
        cells.push([{ v: 'PADA PILKADES SERUNI MUMBUL 2026  |  Kp. ' + g.kampung + '  |  SEMUA KAMPUNG', bold: true, sz: 11, color: '0F172A', align: 'center' }]);
        merges.push('A' + (rIndex + 1) + ':' + lastColLetter + (rIndex + 1)); rowHeights[rIndex] = 17; rIndex++;
        cells.push([{ v: 'Total: ' + jumlah + ' pendukung  |  Dicetak: ' + formatTanggalIndo(now), sz: 9, color: '475569', align: 'center' }]);
        merges.push('A' + (rIndex + 1) + ':' + lastColLetter + (rIndex + 1)); rowHeights[rIndex] = 14; rIndex++;
        cells.push([]); rowHeights[rIndex] = 8; rIndex++;

        g.subsets.forEach((s, idxSub) => {
          if (idxSub > 0) { cells.push([]); rowHeights[rIndex] = 10; rIndex++; }
          const rtLbl = s.rt === RT_UMUM ? 'UMUM' : ('RT ' + s.rt);
          cells.push([{ v: rtLbl + '  (' + s.rows.length + ' pendukung)', bold: true, sz: 11, color: '065F46', fill: 'D1FAE5', align: 'left', border: true, wrap: false }]);
          merges.push('A' + (rIndex + 1) + ':' + lastColLetter + (rIndex + 1)); rowHeights[rIndex] = 18; rIndex++;
          cells.push(cols.map(h => ({ v: h, bold: true, sz: 10, color: 'FFFFFF', fill: '0D6E3F', align: 'center', wrap: true, border: true })));
          rowHeights[rIndex] = 32; rIndex++;
          s.rows.forEach((p, idx) => {
            const arr = detailKampungRowArray(detailKampungRow(p, idx)).filter((v, i) => i !== COL_STATUS);
            arr.push(ttdUrlValue(p));                                    // kolom TTD: tautan bukti TTD
            const center = [0, 4, 5, 6, 7];
            cells.push(arr.map((v, c) => {
              const isNum = (c === 0) || (c === 5 && /^\d+$/.test(v));
              const isTtd = c === cols.length - 1;                       // kolom TTD terakhir
              return { v: isNum ? Number(v) : v, sz: 10, color: isTtd ? '1D4ED8' : '0F172A', align: center.indexOf(c) !== -1 ? 'center' : 'left', border: true, fill: (idx % 2 === 1) ? 'F0FDF4' : null };
            }));
            rIndex++;
          });
        });

        book.sheets.push({
          name: String(g.kampung || 'Kampung').replace(/[\[\]:*?/\\]/g, '-').slice(0, 31),
          colWidths: [5, 20, 30, 17, 14, 7, 18, 14, 28, 40],
          rowHeights: rowHeights,
          merges: merges,
          cells: cells
        });
      });

      const namaFile = 'Data_KTP_SEMUA_KAMPUNG_AZ_' + formatTanggalFile(now) + '.xlsx';
      W.save(book, namaFile);
      toast('✅ XLSX berhasil di-download', 'success');
      logDownload('XLSX_MASSAL', 'XLSX SEMUA KAMPUNG (' + kampungGroups.length + ' sheet) (' + state.allData.length + ' data)');
    } catch (e) {
      console.error('XLSX MASSAL Error:', e);
      toast('Gagal buat XLSX: ' + e.message, 'error');
    } finally {
      resetMassalXlsxButton();
    }
  };

  function slugify(s) {
    return String(s || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  function formatTanggalIndo(d) {
    const bulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
    return d.getDate() + ' ' + bulan[d.getMonth()] + ' ' + d.getFullYear();
  }

  /** "1990-03-25" → "25 Maret 1990" (teks lain dikembalikan apa adanya, kosong → '-') */
  function formatTglLahir(ymd) {
    const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return ymd ? String(ymd) : '-';
    return formatTanggalIndo(new Date(+m[1], +m[2] - 1, +m[3]));
  }

  /** Isian Tempat Lahir & Status Perkawinan (dipakai form Input dan Edit) */
  function dataDiriFieldsHtml(prefix, p) {
    p = p || {};
    let statusOpts = '<option value="">-- Pilih Status --</option>';
    STATUS_KAWIN_LIST.forEach(s => {
      statusOpts += '<option value="' + esc(s) + '"' + (p.statusPerkawinan === s ? ' selected' : '') + '>' + esc(s) + '</option>';
    });
    if (p.statusPerkawinan && STATUS_KAWIN_LIST.indexOf(p.statusPerkawinan) === -1) {
      statusOpts += '<option value="' + esc(p.statusPerkawinan) + '" selected>' + esc(p.statusPerkawinan) + '</option>';
    }
    return '<div class="form-row">' +
        '<div class="form-group">' +
          '<label class="form-label" for="' + prefix + 'TempatLahir">Tempat Lahir</label>' +
          '<input type="text" class="form-input" id="' + prefix + 'TempatLahir" placeholder="Contoh: Mataram" maxlength="' + MAX_TEMPAT_LAHIR + '" autocomplete="off" value="' + esc(p.tempatLahir || '') + '">' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="form-label" for="' + prefix + 'StatusKawin">Status Perkawinan</label>' +
          '<select class="form-select" id="' + prefix + 'StatusKawin">' + statusOpts + '</select>' +
        '</div>' +
      '</div>';
  }

  /** Nilai isian Data Diri tambahan dari form (prefix 'f' = Input, 'e' = Edit) */
  function readDataDiriFields(prefix) {
    return {
      tempatLahir: $(prefix + 'TempatLahir').value.replace(/\s+/g, ' ').trim(),
      statusPerkawinan: $(prefix + 'StatusKawin').value
    };
  }

  function formatTanggalFile(d) {
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes());
  }

  // ============================================================ //
  // ⭐ DOWNLOAD FOTO KTP → PDF A4 (untuk print, foto di tengah)     //
  // ============================================================ //
  window.__downloadKtpA4 = function(id, btnEl) {
    const p = (state.allData || []).find(x => String(x.id) === String(id));
    if (!p) { toast('Data tidak ditemukan', 'error'); return; }
    if (!p.fotoKTPId) { toast('Belum ada foto KTP untuk data ini', 'error'); return; }
    if (state.ktpPdfGenerating) return;
    state.ktpPdfGenerating = true;

    const originalHtml = btnEl ? btnEl.innerHTML : '';
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.innerHTML = '<div class="spinner" style="width:13px;height:13px;border-width:2px;margin:0;border-color:rgba(7,89,133,.25);border-top-color:currentColor"></div>';
    }

    const finish = () => {
      state.ktpPdfGenerating = false;
      if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = originalHtml; }
    };

    fetchFotoUrl(p)
      .then(u => buildKtpPdf(p, u, () => { if (String(u).startsWith('blob:')) URL.revokeObjectURL(u); finish(); }))
      .catch(e => { toast('Gagal ambil foto KTP: ' + e.message, 'error'); finish(); });
  };

  // ============================================================ //
  // ⭐ DOWNLOAD KTP + TTD DIGITAL → PDF A4 (satu halaman: KTP di atas, TTD digital di bawah) //
  // Hanya untuk data yang diverifikasi dengan tanda tangan digital.
  // ============================================================ //
  function hasTtdDigital(p) { return !!(p && p.metodeTTD === 'digital' && p.fotoTTDId && p.verified); }

  window.__downloadKtpTtd = function(id, btnEl) {
    const p = (state.allData || []).find(x => String(x.id) === String(id));
    if (!p) { toast('Data tidak ditemukan', 'error'); return; }
    if (!hasTtdDigital(p)) { toast('Data ini tidak memiliki tanda tangan digital', 'warn'); return; }
    if (!p.fotoKTPId) { toast('Belum ada foto KTP untuk data ini', 'error'); return; }
    if (state.ktpPdfGenerating) return;
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) { toast('Library PDF belum siap, coba lagi', 'error'); return; }
    state.ktpPdfGenerating = true;
    const originalHtml = btnEl ? btnEl.innerHTML : '';
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.innerHTML = '<div class="spinner" style="width:15px;height:15px;border-width:2px;margin:0;border-color:rgba(7,89,133,.25);border-top-color:currentColor"></div> Menyiapkan…';
    }
    const urls = [];
    const grab = which => fetchFotoUrl(p, which).then(u => { urls.push(u); return loadImage(u); }).then(img => imgToJpeg(img, 1400));
    Promise.all([grab('ktp'), grab('ttd')])
      .then(([ktp, ttd]) => {
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        drawKtpTtdA4Page(doc, ktp, ttd, p);
        doc.save('KTP_TTD_' + slugify(p.nama) + '_' + (p.nik || '') + '.pdf');
        toast('✅ PDF KTP + TTD digital siap (A4)', 'success');
        logDownload('KTP_TTD', 'KTP + TTD digital ' + p.nama + ' / NIK ' + (p.nik || '-') + ' (' + (p.kampung || '-') + ' ' + rtLabel(p.rt) + ')');
      })
      .catch(e => { console.error('KTP+TTD error:', e); toast('Gagal membuat PDF: ' + (e && e.message ? e.message : e), 'error'); })
      .then(() => {
        urls.forEach(u => { if (String(u).startsWith('blob:')) URL.revokeObjectURL(u); });
        state.ktpPdfGenerating = false;
        if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = originalHtml; }
      });
  };

  // 1 halaman A4: "KTP" + foto KTP, lalu "TTD Digital" + lembar tanda tangan, di tengah kertas
  function drawKtpTtdA4Page(doc, ktp, ttd, p) {
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const fit = (img, maxW, maxH) => {
      const a = img.w / img.h;
      let w = maxW, h = maxW / a;
      if (h > maxH) { h = maxH; w = maxH * a; }
      return { w, h };
    };
    const k = fit(ktp, 100, 64);          // ukuran sama dengan cetak KTP biasa
    const t = fit(ttd, 120, 82);
    const labelH = 8, gap = 16;
    const total = labelH + k.h + gap + labelH + t.h;
    let y = (pageH - total) / 2;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text('KTP', pageW / 2, y + 5, { align: 'center' });
    y += labelH;
    doc.addImage(ktp.dataUrl, 'JPEG', (pageW - k.w) / 2, y, k.w, k.h);
    y += k.h + gap;

    doc.text('TTD Digital', pageW / 2, y + 5, { align: 'center' });
    y += labelH;
    doc.addImage(ttd.dataUrl, 'JPEG', (pageW - t.w) / 2, y, t.w, t.h);
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.3);
    doc.rect((pageW - t.w) / 2, y, t.w, t.h);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(148, 163, 184);
    doc.text(String(p.nama || '') + '  •  ' + String(p.nik || ''), pageW / 2, pageH - 12, { align: 'center' });
  }

  // ⭐ Render ulang gambar lewat canvas → JPEG. Decoder PNG bawaan jsPDF kadang
  // gagal ("Incomplete or corrupt PNG file") walau file PNG-nya valid & bisa
  // ditampilkan browser — canvas re-encode ini menghindari masalah itu.
  // maxPx (opsional) membatasi sisi terpanjang supaya PDF massal tidak kebesaran.
  function imgToJpeg(img, maxPx) {
    let natW = img.naturalWidth || img.width || 1;
    let natH = img.naturalHeight || img.height || 1;
    if (maxPx && Math.max(natW, natH) > maxPx) {
      const k = maxPx / Math.max(natW, natH);
      natW = Math.round(natW * k);
      natH = Math.round(natH * k);
    }
    const canvas = document.createElement('canvas');
    canvas.width = natW;
    canvas.height = natH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, natW, natH);
    ctx.drawImage(img, 0, 0, natW, natH);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.92), w: natW, h: natH };
  }

  // Gambar 1 halaman A4: foto KTP di tengah kertas + nama/NIK kecil di bawah
  function drawKtpA4Page(doc, jpeg, p) {
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();

    // Batas ukuran cetak di A4 (dibuat sedekat mungkin ukuran KTP asli ±
    // 100x64mm supaya tidak terlalu besar di kertas), foto tetap proporsional (tidak gepeng)
    const maxW = 100, maxH = 64;
    const aspect = jpeg.w / jpeg.h;

    let drawW = maxW, drawH = maxW / aspect;
    if (drawH > maxH) { drawH = maxH; drawW = maxH * aspect; }

    const x = (pageW - drawW) / 2;
    const y = (pageH - drawH) / 2;

    doc.addImage(jpeg.dataUrl, 'JPEG', x, y, drawW, drawH);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(148, 163, 184);
    doc.text(String(p.nama || '') + '  •  ' + String(p.nik || ''), pageW / 2, pageH - 12, { align: 'center' });
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Gagal memuat gambar KTP'));
      img.src = dataUrl;
    });
  }

  function buildKtpPdf(p, dataUrl, done) {
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) { toast('Library PDF belum siap, coba lagi', 'error'); done(); return; }

    loadImage(dataUrl)
      .then(img => {
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        drawKtpA4Page(doc, imgToJpeg(img, 1200), p);
        doc.save('KTP_' + slugify(p.nama) + '_' + (p.nik || '') + '.pdf');
        toast('✅ PDF KTP siap di-print (A4)', 'success');
        logDownload('KTP', 'KTP ' + p.nama + ' / NIK ' + (p.nik || '-') + ' (' + (p.kampung || '-') + ' RT ' + (p.rt || '-') + ')');
      })
      .catch(err => {
        console.error('KTP PDF error:', err);
        toast('Gagal buat PDF: ' + err.message, 'error');
      })
      .then(done);
  }

  // ============================================================ //
  // ⭐ DOWNLOAD KTP MASSAL → 1 PDF A4 (1 KTP per halaman, di tengah) //
  // ============================================================ //
  // Mengikuti filter Kampung / RT / Pencarian / Status Suara yang
  // sedang aktif di halaman Data. Status cetak dipilih di modal.
  function getBulkKtpBaseList() {
    let list = state.allData || [];
    if (state.filter.kampung) list = list.filter(x => String(x.kampung || '').trim() === String(state.filter.kampung).trim());
    if (state.filter.rt) {
      const targetRT = normRT(state.filter.rt);
      list = list.filter(x => normRT(x.rt) === targetRT);
    }
    if (state.filter.q) {
      const q = state.filter.q.toLowerCase();
      list = list.filter(x => (x.nama || '').toLowerCase().includes(q) || (x.nik || '').includes(q));
    }
    if (state.filter.verified === 'true') list = list.filter(x => x.verified === true);
    else if (state.filter.verified === 'false') list = list.filter(x => x.verified !== true);
    return list.filter(x => x.fotoKTPId && String(x.fotoKTPId).trim());
  }

  function bulkKtpFilterLabel() {
    const parts = [];
    if (state.filter.kampung) parts.push(state.filter.kampung);
    if (state.filter.rt) parts.push(state.filter.rt === RT_UMUM ? 'UMUM' : ('RT ' + normRT(state.filter.rt)));
    if (state.filter.verified === 'true') parts.push('Suara Pasti');
    else if (state.filter.verified === 'false') parts.push('Belum Pasti');
    if (state.filter.q) parts.push('"' + state.filter.q + '"');
    return parts.length ? parts.join(' • ') : 'Semua data';
  }

  window.__openBulkKtp = function() {
    if (state.bulkKtp) {
      $('modalBulkKtp').classList.add('show');
      return;
    }
    const base = getBulkKtpBaseList();
    const belum = base.filter(x => x.dicetak !== true);
    const sudah = base.filter(x => x.dicetak === true);
    // Default pilih "Belum Dicetak" (paling sering dipakai), kecuali kosong
    const sel = belum.length ? 'false' : 'true';

    $('modalBulkKtpContent').innerHTML =
      '<div class="bulk-ktp-head">' +
        '<div class="bulk-ktp-icon">' + ICONS.download + '</div>' +
        '<h3>Download KTP Massal</h3>' +
        '<p>1 file PDF ukuran A4, 1 KTP per halaman (di tengah kertas)</p>' +
      '</div>' +
      '<div class="bulk-ktp-scope">Filter aktif: <b>' + esc(bulkKtpFilterLabel()) + '</b></div>' +
      '<div class="bulk-ktp-label">Mau download yang mana?</div>' +
      '<div class="bulk-ktp-opts">' +
        '<label class="bulk-ktp-opt' + (belum.length ? '' : ' disabled') + '">' +
          '<input type="radio" name="bulkKtpStatus" value="false"' + (sel === 'false' ? ' checked' : '') + (belum.length ? '' : ' disabled') + '>' +
          '<span class="bko-title">📄 Belum Dicetak</span>' +
          '<span class="bko-count">' + belum.length + ' KTP</span>' +
        '</label>' +
        '<label class="bulk-ktp-opt' + (sudah.length ? '' : ' disabled') + '">' +
          '<input type="radio" name="bulkKtpStatus" value="true"' + (sel === 'true' ? ' checked' : '') + (sudah.length ? '' : ' disabled') + '>' +
          '<span class="bko-title">🖨️ Sudah Dicetak</span>' +
          '<span class="bko-count">' + sudah.length + ' KTP</span>' +
        '</label>' +
      '</div>' +
      '<label class="bulk-ktp-mark" id="bulkKtpMarkWrap">' +
        '<input type="checkbox" id="bulkKtpMark" checked>' +
        '<span>Setelah PDF selesai, tandai otomatis sebagai <b>Sudah Dicetak</b></span>' +
      '</label>' +
      '<div class="bulk-ktp-note">Data tanpa foto KTP otomatis dilewati.</div>' +
      '<div class="bulk-ktp-progress" id="bulkKtpProgress" style="display:none">' +
        '<div class="bkp-bar"><div class="bkp-fill" id="bulkKtpFill"></div></div>' +
        '<div class="bkp-text" id="bulkKtpText">Menyiapkan...</div>' +
      '</div>' +
      '<div class="confirm-btns">' +
        '<button class="btn btn-outline" id="bulkKtpCancel" type="button">Batal</button>' +
        '<button class="btn-download" id="bulkKtpStart" type="button"' + ((belum.length || sudah.length) ? '' : ' disabled') + '>' + ICONS.download + ' Download</button>' +
      '</div>';

    const syncMark = () => {
      const r = document.querySelector('input[name="bulkKtpStatus"]:checked');
      $('bulkKtpMarkWrap').style.display = (r && r.value === 'false') ? '' : 'none';
    };
    document.querySelectorAll('input[name="bulkKtpStatus"]').forEach(r => r.addEventListener('change', syncMark));
    syncMark();

    $('bulkKtpCancel').addEventListener('click', closeBulkKtp);
    $('bulkKtpStart').addEventListener('click', () => {
      const r = document.querySelector('input[name="bulkKtpStatus"]:checked');
      if (!r) { toast('Pilih status cetak dulu', 'error'); return; }
      const wantPrinted = r.value === 'true';
      const list = wantPrinted ? sudah : belum;
      const mark = !wantPrinted && $('bulkKtpMark').checked;
      runBulkKtp(list, wantPrinted, mark);
    });

    $('modalBulkKtp').classList.add('show');
  };

  function closeBulkKtp() {
    if (state.bulkKtp) {
      state.bulkKtp.cancelled = true;
      const t = $('bulkKtpText');
      if (t) t.textContent = 'Membatalkan...';
      return;
    }
    $('modalBulkKtp').classList.remove('show');
  }

  // Ambil foto KTP sebagai URL objek lewat /api/photo (ter-cache di perangkat & CDN → cepat),
  // cadangan: RPC base64 bila URL tidak tersedia/gagal.
  // which: 'ktp' (default) | 'ttd' (lembar bukti tanda tangan digital)
  function fetchFotoUrl(p, which) {
    const ttd = which === 'ttd';
    const fid = ttd ? p.fotoTTDId : p.fotoKTPId;
    const url = (ttd ? p.fotoTTD : p.fotoKTP) || (fid ? '/api/photo?id=' + encodeURIComponent(fid) : '');
    const viaRpc = () => new Promise((resolve, reject) => {
      google.script.run
        .withSuccessHandler(r => r && r.ok ? resolve(r.dataUrl) : reject(new Error((r && r.message) || 'Gagal ambil foto')))
        .withFailureHandler(e => reject(e))
        .apiGetFotoBase64(fid);
    });
    if (!url) return viaRpc();
    return fetch(url, { credentials: 'same-origin' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(b => URL.createObjectURL(b))
      .catch(() => viaRpc());
  }

  function runBulkKtp(list, wantPrinted, markAfter) {
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) { toast('Library PDF belum siap, coba lagi', 'error'); return; }
    if (!list.length) { toast('Tidak ada KTP untuk di-download', 'error'); return; }

    const job = state.bulkKtp = { cancelled: false };
    const total = list.length;
    const images = new Array(total);   // hasil JPEG per index (urutan halaman tetap)
    const failed = [];
    let doneCount = 0;

    const btnStart = $('bulkKtpStart');
    btnStart.disabled = true;
    btnStart.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0;border-color:rgba(255,255,255,.4);border-top-color:#fff"></div> Memproses...';
    $('bulkKtpCancel').textContent = 'Batalkan';
    document.querySelectorAll('#modalBulkKtpContent input').forEach(i => { i.disabled = true; });
    $('bulkKtpProgress').style.display = '';

    const updateProgress = () => {
      $('bulkKtpFill').style.width = Math.round((doneCount / total) * 100) + '%';
      $('bulkKtpText').textContent = 'Mengambil foto ' + doneCount + ' / ' + total + (failed.length ? ' (' + failed.length + ' gagal)' : '');
    };
    updateProgress();

    // Ambil foto paralel (5 sekaligus); foto yang sudah ter-cache (perangkat/CDN) langsung tersedia
    let next = 0;
    const worker = () => {
      if (job.cancelled || next >= total) return Promise.resolve();
      const idx = next++;
      const p = list[idx];
      return fetchFotoUrl(p)
        .then(u => loadImage(u).finally(() => { if (u.startsWith('blob:')) URL.revokeObjectURL(u); }))
        .then(img => { images[idx] = imgToJpeg(img, 1200); })
        .catch(err => { console.warn('KTP gagal:', p.nama, err); failed.push(p); })
        .then(() => { doneCount++; updateProgress(); return worker(); });
    };

    Promise.all([worker(), worker(), worker(), worker(), worker()])
      .then(() => {
        if (job.cancelled) { toast('Download KTP massal dibatalkan', 'warn'); return; }

        $('bulkKtpText').textContent = 'Menyusun PDF...';
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        const okList = [];
        list.forEach((p, i) => {
          if (!images[i]) return;
          if (okList.length) doc.addPage('a4', 'portrait');
          drawKtpA4Page(doc, images[i], p);
          okList.push(p);
        });

        if (!okList.length) { toast('Semua foto KTP gagal diambil', 'error'); return; }

        const parts = ['KTP'];
        if (state.filter.kampung) parts.push(slugify(state.filter.kampung));
        if (state.filter.rt) parts.push(state.filter.rt === RT_UMUM ? 'UMUM' : ('RT' + normRT(state.filter.rt)));
        parts.push(wantPrinted ? 'SudahDicetak' : 'BelumDicetak');
        parts.push(okList.length + 'data');
        doc.save(parts.join('_') + '_' + formatTanggalFile(new Date()) + '.pdf');
        logDownload('KTP_MASSAL', okList.length + ' KTP (' + (wantPrinted ? 'sudah' : 'belum') + ' dicetak)' +
          (state.filter.kampung ? ' — ' + state.filter.kampung : ' — semua kampung') +
          (state.filter.rt ? ' ' + (state.filter.rt === RT_UMUM ? 'UMUM' : 'RT ' + normRT(state.filter.rt)) : '') +
          (failed.length ? ' • ' + failed.length + ' gagal' : ''));

        if (failed.length) {
          toast('✅ ' + okList.length + ' KTP ter-download • ' + failed.length + ' gagal: ' +
            failed.slice(0, 3).map(x => x.nama).join(', ') + (failed.length > 3 ? ', ...' : ''), 'warn');
        } else {
          toast('✅ ' + okList.length + ' KTP berhasil di-download (A4)', 'success');
        }

        if (markAfter) return markBulkPrinted(okList, failed.length);
      })
      .catch(err => {
        console.error('Bulk KTP error:', err);
        toast('Gagal buat PDF: ' + err.message, 'error');
      })
      .then(() => {
        state.bulkKtp = null;
        $('modalBulkKtp').classList.remove('show');
      });
  }

  function markBulkPrinted(okList, failedCount) {
    $('bulkKtpText').textContent = 'Menandai ' + okList.length + ' data sebagai sudah dicetak...';
    const ids = okList.map(x => String(x.id));
    return new Promise(resolve => {
      google.script.run
        .withSuccessHandler(r => {
          if (r && r.ok) {
            const idSet = {};
            ids.forEach(id => { idSet[id] = true; });
            (state.allData || []).forEach(x => { if (idSet[String(x.id)]) x.dicetak = true; });
            if (r.version) state.version = r.version;
            state.dashboardCache = null;
            toast('🖨️ ' + r.count + ' KTP di-download & ditandai sudah dicetak' + (failedCount ? ' • ' + failedCount + ' gagal diambil' : ''), failedCount ? 'warn' : 'success');
            if (state.page === 'data') renderData();
            else if (state.page === 'detail-kampung') renderDetailKampung();
          } else {
            toast('PDF sudah ter-download, tapi gagal menandai status cetak: ' + ((r && r.message) || ''), 'error');
          }
          resolve();
        })
        .withFailureHandler(e => {
          toast('PDF sudah ter-download, tapi gagal menandai status cetak: ' + e.message, 'error');
          resolve();
        })
        .apiSetPrintBatch(ids, true);
    });
  }

  // ============================================================ //
  // FORM INPUT                                                    //
  // ============================================================ //
  function renderInput() {
    const c = $('appContent');
    if (!c) return;
    if (state.offline && roleOperate()) { c.innerHTML = emptyState('📴', 'Butuh internet', 'Input data hanya bisa dilakukan saat online.'); return; }
    if (!canOperate()) { c.innerHTML = emptyState('🔒', 'Tidak ada akses', 'Akun Anda hanya bisa melihat data.'); return; }
    state.fotoBase64 = null;
    state.fotoMime = null;
    state.nikLastChecked = '';
    state.nikIsDup = false;

    let kampungOpts = '<option value="">-- Pilih Kampung --</option>';
    KAMPUNG_LIST.forEach(k => kampungOpts += '<option value="' + esc(k) + '">' + esc(k) + '</option>');

    let rtOpts = '<option value="">-- Pilih RT --</option>';
    RT_LIST.forEach(rt => {
      const label = rt === RT_UMUM ? 'UMUM (Tanpa RT)' : ('RT ' + rt);
      rtOpts += '<option value="' + rt + '">' + label + '</option>';
    });

    c.innerHTML =
      pageHead('Form Pendukung Baru', 'Masukkan data pendukung sesuai dengan dokumen yang dimiliki.') +
      '<div class="form-layout">' +
        '<div class="form-main">' +
          '<section class="form-section">' +
            '<div class="fs-head"><span class="fs-ico ico-amber">' + ICONS.card + '</span><h3>1. Foto KTP</h3><span class="fs-opt">Opsional</span></div>' +
            '<div class="foto-box" id="fotoBox">' +
              '<div class="foto-placeholder" id="fotoPlaceholder">' +
                '<div class="ico">' + ICONS.card + '</div>' +
                'Ambil foto KTP — data diri terisi otomatis' +
              '</div>' +
              '<img id="fotoPreview" class="foto-preview" style="display:none" alt="">' +
              '<div class="foto-btns">' +
                '<button type="button" class="foto-btn primary" id="btnKamera">' + ICONS.camera + 'Kamera</button>' +
                '<button type="button" class="foto-btn" id="btnGaleri">' + ICONS.gallery + 'Galeri</button>' +
              '</div>' +
              '<button type="button" class="foto-hapus" id="btnHapusFoto" style="display:none">' + ICONS.trash + 'Hapus Foto</button>' +
            '</div>' +
            '<div class="foto-tools" id="fotoTools">' +
              '<button type="button" id="btnFotoEdit">' + ICONS.card + 'Putar / Crop</button>' +
              '<button type="button" id="btnOcrUlang">' + ICONS.refresh + 'Baca Ulang Data</button>' +
            '</div>' +
            '<div class="ocr-st" id="ocrSt" role="status" aria-live="polite"></div>' +
          '</section>' +

          '<section class="form-section">' +
            '<div class="fs-head"><span class="fs-ico">' + ICONS.users + '</span><h3>2. Data Diri</h3></div>' +
            '<div class="form-row">' +
              '<div class="form-group">' +
                '<label class="form-label" for="fNama">Nama Lengkap <span class="req">*</span></label>' +
                '<input type="text" class="form-input" id="fNama" placeholder="Masukkan nama lengkap" autocomplete="off">' +
              '</div>' +
              '<div class="form-group">' +
                '<label class="form-label" for="fNik">NIK <span class="req">*</span></label>' +
                '<input type="tel" class="form-input" id="fNik" placeholder="16 digit angka" maxlength="16" inputmode="numeric" autocomplete="off">' +
                '<div class="form-hint">' + ICONS.shield + ' NIK dicek otomatis — tidak boleh duplikat</div>' +
              '</div>' +
            '</div>' +
            '<div class="nik-preview" id="nikPreview"></div>' +
            dataDiriFieldsHtml('f') +
          '</section>' +

          '<section class="form-section">' +
            '<div class="fs-head"><span class="fs-ico ico-green">' + ICONS.home + '</span><h3>3. Alamat</h3></div>' +
            '<div class="form-row">' +
              '<div class="form-group">' +
                '<label class="form-label" for="fKampung">Kampung <span class="req">*</span></label>' +
                '<select class="form-select" id="fKampung">' + kampungOpts + '</select>' +
              '</div>' +
              '<div class="form-group">' +
                '<label class="form-label" for="fRt">RT <span class="req">*</span></label>' +
                '<select class="form-select" id="fRt">' + rtOpts + '</select>' +
              '</div>' +
            '</div>' +
          '</section>' +

          '<div class="form-actions">' +
            '<button class="btn btn-primary" id="btnSubmit" type="button">' + ICONS.save + ' Simpan Data</button>' +
            '<button class="btn btn-outline" id="btnResetForm" type="button">' + ICONS.refresh + ' Reset</button>' +
          '</div>' +
        '</div>' +

        '<aside class="form-aside">' +
          '<div class="aside-card aside-hero">' +
            '<div class="aside-art"><svg viewBox="0 0 120 96" fill="none"><rect x="14" y="10" width="72" height="80" rx="10" fill="#dbeafe"/><rect x="26" y="26" width="34" height="6" rx="3" fill="#93c5fd"/><rect x="26" y="40" width="46" height="6" rx="3" fill="#bfdbfe"/><rect x="26" y="54" width="28" height="6" rx="3" fill="#bfdbfe"/><circle cx="84" cy="66" r="22" fill="#3b82f6"/><circle cx="84" cy="60" r="7" fill="#fff"/><path d="M71 78c2-8 8-11 13-11s11 3 13 11" fill="#fff"/></svg></div>' +
            '<h4>Pastikan Data Benar</h4>' +
            '<p>Data yang Anda masukkan akan digunakan untuk verifikasi dan pencetakan KTP. Periksa kembali sebelum menyimpan.</p>' +
          '</div>' +
          '<div class="aside-card aside-secure">' +
            '<div class="as-ico">' + ICONS.shield + '</div>' +
            '<div><h5>Keamanan Data</h5><p>Data dijaga kerahasiaannya dan hanya dapat diakses oleh pengguna yang berwenang.</p></div>' +
          '</div>' +
        '</aside>' +
      '</div>';

    const fNik = $('fNik');
    fNik.addEventListener('input', () => {
      fNik.value = fNik.value.replace(/\D/g, '').slice(0, 16);
      handleNikInput(fNik.value, null);
    });

    $('btnKamera').addEventListener('click', () => openKtpCamera('input'));
    $('btnGaleri').addEventListener('click', () => $('galleryInput').click());
    $('cameraInput').onchange = handleGalleryFileForCrop;
    $('galleryInput').onchange = handleGalleryFileForCrop;
    $('btnHapusFoto').addEventListener('click', clearFoto);
    $('btnFotoEdit').addEventListener('click', () => {
      const src = state.fotoSrc || state.fotoBase64;
      if (src) openCropModal(src);
    });
    $('btnOcrUlang').addEventListener('click', () => { if (state.fotoOcr || state.fotoBase64) runKtpOcr(state.fotoOcr || state.fotoBase64); });
    $('btnSubmit').addEventListener('click', submitForm);
    $('btnResetForm').addEventListener('click', () => { renderInput(); toast('Form direset', 'success'); });
  }

  function handleNikInput(nik, excludeId) {
    const p = $('nikPreview');
    const fNik = $('fNik');
    if (!p || !fNik) return;
    fNik.classList.remove('dup-input', 'ok-input');
    if (nik.length < 16) {
      state.nikIsDup = false;
      state.nikLastChecked = '';
      if (nik.length > 0) {
        p.style.display = 'block';
        p.className = 'nik-preview';
        p.textContent = 'Ketik ' + (16 - nik.length) + ' digit lagi...';
      } else p.style.display = 'none';
      return;
    }
    const parsed = parseNIK(nik);
    if (!parsed.valid) {
      p.style.display = 'block';
      p.className = 'nik-preview error';
      p.textContent = '⚠️ ' + parsed.msg;
      return;
    }
    p.style.display = 'block';
    p.className = 'nik-preview checking';
    p.innerHTML = '👤 <b>' + parsed.jenisKelamin + '</b> • 🎂 ' + parsed.tglText + ' • 📅 Usia <b>' + parsed.usia + ' tahun</b><br>🔍 Mengecek NIK...';
    clearTimeout(state.nikCheckTimer);
    state.nikCheckTimer = setTimeout(() => { checkNikServer(nik, parsed, excludeId); }, 300);
  }

  function checkNikServer(nik, parsed, excludeId) {
    const p = $('nikPreview');
    const fNik = $('fNik');
    if (!p || !fNik) return;
    google.script.run
      .withSuccessHandler(r => {
        if (!r.ok) {
          p.className = 'nik-preview error';
          p.textContent = '⚠️ ' + (r.message || 'Gagal cek NIK');
          return;
        }
        if (r.tersedia) {
          state.nikIsDup = false;
          state.nikLastChecked = nik;
          fNik.classList.add('ok-input');
          p.className = 'nik-preview';
          p.innerHTML = '✅ NIK tersedia • 👤 <b>' + parsed.jenisKelamin + '</b> • 🎂 ' + parsed.tglText + ' • 📅 Usia <b>' + parsed.usia + ' tahun</b>';
        } else {
          state.nikIsDup = true;
          state.nikLastChecked = nik;
          state.dupData = r.duplikat;
          fNik.classList.add('dup-input');
          p.className = 'nik-preview dup';
          const first = r.duplikat[0];
          p.innerHTML = '❌ <b>NIK SUDAH TERDAFTAR!</b><br>👤 ' + esc(first.nama) + ' • ' + esc(first.kampung) + ' ' + rtLabel(first.rt);
        }
      })
      .withFailureHandler(e => {
        p.className = 'nik-preview error';
        p.textContent = '⚠️ Gagal cek: ' + e.message;
      })
      .apiCheckNik({ nik: nik, excludeId: excludeId });
  }

  // Skala-kan sumber besar (foto kamera 12MP+) agar editor tetap ringan
  function downscaleDataUrl(dataUrl, maxSide, cb) {
    const img = new Image();
    img.onload = () => {
      const m = Math.max(img.naturalWidth, img.naturalHeight);
      if (m <= maxSide) { cb(dataUrl); return; }
      const k = maxSide / m;
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, c.width, c.height);
      cb(c.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => cb(dataUrl);
    img.src = dataUrl;
  }

  function handleGalleryFileForCrop(e, target) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { toast('Foto maksimal 15 MB', 'error'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = ev => {
      downscaleDataUrl(ev.target.result, 2600, src => {
        if (target === 'edit') state.editFotoSrc = src; else state.fotoSrc = src;
        openCropModal(src, target);
      });
      e.target.value = '';
    };
    reader.onerror = () => { toast('Gagal membaca file foto', 'error'); e.target.value = ''; };
    reader.readAsDataURL(file);
  }

  // Kamera langsung dengan bingkai ukuran KTP; bila tak tersedia/ditolak → kamera bawaan HP (+ editor)
  function openKtpCamera(target) {
    const isEdit = target === 'edit';
    const fallback = () => $(isEdit ? 'editCameraInput' : 'cameraInput').click();
    if (!window.KtpCapture || !KtpCapture.supported()) { fallback(); return; }
    KtpCapture.open({
      onCapture: (dataUrl, q) => {
        if (isEdit) { state.editFotoSrc = dataUrl; setEditFoto(dataUrl); }
        else { state.fotoSrc = dataUrl; finalizeFotoKTP(dataUrl, dataUrl); }
        if (q && !q.ok) toast('⚠️ ' + q.tips[0], 'warn');
      },
      onError: reason => {
        if (reason === 'denied') toast('Izin kamera ditolak — memakai kamera bawaan. Izinkan kamera di pengaturan browser untuk bingkai KTP.', 'warn');
        fallback();
      }
    });
  }

  // Putar/crop foto KTP yang SUDAH tersimpan (modal Edit)
  function openCropFromUrl(url) {
    toast('Memuat foto…', 'info');
    fetch(url, { credentials: 'same-origin' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(b => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b); }))
      .then(d => { state.editFotoSrc = d; openCropModal(d, 'edit'); })
      .catch(e => toast('Gagal memuat foto: ' + e.message, 'error'));
  }

  // Foto KTP baru di modal Edit (hasil kamera berbingkai / editor putar-crop)
  function setEditFoto(dataUrl) {
    downscaleDataUrl(dataUrl, 1200, small => {
      state.fotoBase64 = small;
      state.fotoMime = 'image/jpeg';
      const pv = $('eFotoPreview');
      if (!pv) return;
      pv.src = small;
      pv.style.display = 'block';
      $('eFotoPlaceholder').style.display = 'none';
      $('eFotoBox').classList.add('has-foto');
      const t = $('eFotoTools');
      if (t) t.classList.add('show');
    });
  }

  function showFotoPreview(base64) {
    $('fotoPreview').src = base64;
    $('fotoPreview').style.display = 'block';
    $('fotoPlaceholder').style.display = 'none';
    $('fotoBox').classList.add('has-foto');
    $('btnHapusFoto').style.display = 'flex';
  }

  function clearFoto() {
    state.fotoBase64 = null;
    state.fotoMime = null;
    state.fotoSrc = null;
    state.fotoOcr = null;
    state.ocrToken = (state.ocrToken || 0) + 1;
    setOcrStatus('', '');
    $('fotoPreview').style.display = 'none';
    $('fotoPreview').src = '';
    $('fotoPlaceholder').style.display = 'block';
    $('fotoBox').classList.remove('has-foto');
    $('btnHapusFoto').style.display = 'none';
  }

  // ============================================================ //
  // ⭐ FOTO KTP: kamera berbingkai + editor putar/crop + OCR     //
  // - Kamera langsung (ktpcam.js, getUserMedia) dengan bingkai     //
  //   rasio KTP; hanya isi bingkai yang diambil. Bila kamera       //
  //   tidak tersedia/izin ditolak → kamera bawaan HP lalu editor.  //
  // - Galeri/ambil ulang: editor Cropper.js — putar 90°, miringkan //
  //   bebas (-45°…+45°), zoom, crop rasio KTP atau bebas.          //
  // - Setelah foto final, Nama & NIK dibaca otomatis di server     //
  //   (api/rpc ocrKtp → Google Cloud Vision + parser lib/ktp.js)   //
  //   dan hanya DIISIKAN ke form; foto tak jelas → isi manual.     //
  // ============================================================ //
  const KTP_RATIO = 85.6 / 53.98;
  let cropperInstance = null;
  let cropIsFreeRatio = false;
  let cropRotBase = 0;   // kelipatan 90°
  let cropTarget = 'input';   // 'input' (form Input) | 'edit' (modal Edit)

  function openCropModal(dataUrl, target) {
    cropTarget = target === 'edit' ? 'edit' : 'input';
    const modal = $('modalCropFoto');
    const img = $('cropImgEl');
    if (cropperInstance) { cropperInstance.destroy(); cropperInstance = null; }
    cropIsFreeRatio = false;
    cropRotBase = 0;
    $('cropRatioToggle').classList.remove('active');
    $('cropRatioLbl').textContent = 'Rasio KTP';
    $('cropFine').value = 0;
    $('cropFineVal').textContent = '0°';
    img.onload = () => {
      cropperInstance = new Cropper(img, {
        viewMode: 1,
        dragMode: 'move',
        aspectRatio: KTP_RATIO,
        autoCropArea: 0.98,
        background: false,
        responsive: true,
        guides: true,
        center: true,
        highlight: false,
        cropBoxMovable: true,
        cropBoxResizable: true,
        checkOrientation: true,
        minContainerHeight: 240,
        toggleDragModeOnDblclick: false
      });
    };
    img.src = dataUrl;
    modal.classList.add('show');
    updateFabVisibility();
  }

  function closeCropModal() {
    $('modalCropFoto').classList.remove('show');
    updateFabVisibility();
    if (cropperInstance) { cropperInstance.destroy(); cropperInstance = null; }
    $('cropImgEl').src = '';
  }

  // dataUrl = foto yang disimpan (dikecilkan), ocrUrl = versi resolusi tinggi untuk dibaca OCR
  function finalizeFotoKTP(dataUrl, ocrUrl) {
    downscaleDataUrl(dataUrl, 1200, small => {
      state.fotoBase64 = small;
      state.fotoMime = 'image/jpeg';
      state.fotoOcr = ocrUrl || small;
      showFotoPreview(small);
      runKtpOcr(state.fotoOcr);
    });
  }

  // ============================================================ //
  // ⭐ BACA OTOMATIS NAMA & NIK (OCR server: Google Cloud Vision)  //
  // Hasil hanya DIISIKAN ke form (tidak langsung disimpan) dan      //
  // divalidasi struktur NIK; bila tak yakin, pengguna isi manual.   //
  // ============================================================ //
  function setOcrStatus(kind, html) {
    const el = $('ocrSt');
    if (!el) return;
    el.className = 'ocr-st' + (kind ? ' show ' + kind : '');
    el.innerHTML = html || '';
  }

  function setFieldAuto(id, val) {
    const el = $(id);
    if (!el) return;
    el.value = val;
    el.classList.add('auto-fill');
    el.addEventListener('input', () => el.classList.remove('auto-fill'), { once: true });
    if (id === 'fNik') el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function runKtpOcr(imgUrl) {
    if (!$('ocrSt') || !imgUrl) return;
    const token = state.ocrToken = (state.ocrToken || 0) + 1;
    setOcrStatus('busy', '<div class="ocr-row"><span class="ocr-spin"></span><span>Membaca data dari KTP…</span></div>');
    // foto buram/gelap: beri peringatan dini (tetap dicoba dibaca)
    let tip = '';
    try {
      const im = new Image();
      im.onload = () => { const q = window.KtpCapture && KtpCapture.quality(im); if (q && !q.ok) tip = q.tips[0]; };
      im.src = imgUrl;
    } catch (e) { /* abaikan */ }

    shrinkForOcr(imgUrl, small => {
      if (token !== state.ocrToken || !$('ocrSt')) return;
      google.script.run
        .withSuccessHandler(r => {
          if (token !== state.ocrToken || !$('ocrSt')) return;
          showOcrResult(r, tip);
        })
        .withFailureHandler(e => {
          if (token !== state.ocrToken || !$('ocrSt')) return;
          setOcrStatus('err', '⚠️ Gagal membaca otomatis (' + esc(e && e.message ? e.message : 'error') + '). Isi Nama & NIK secara manual.');
        })
        .apiOcrKtp({ image: small });
    });
  }

  // Kecilkan foto untuk OCR: maks. 1280px & ±300KB (OCR Drive lebih cepat, upload dari HP cepat, batas OCR.space 1MB)
  function shrinkForOcr(dataUrl, cb) {
    const img = new Image();
    img.onload = () => {
      const tries = [[1280, 0.82], [1100, 0.75], [960, 0.7]];
      let out = dataUrl;
      for (const [maxSide, q] of tries) {
        const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, c.width, c.height);
        out = c.toDataURL('image/jpeg', q);
        if (out.length < 420000) break;
      }
      cb(out);
    };
    img.onerror = () => cb(dataUrl);
    img.src = dataUrl;
  }

  function showOcrResult(r, tip) {
    if (!r || !r.ok) {
      if (r && /^OCR_(DISABLED|DENIED)$/.test(r.code || '')) setOcrStatus('warn', 'ℹ️ ' + esc(r.message) + '<br>Sementara, isi Nama & NIK secara manual.');
      else setOcrStatus('err', '⚠️ ' + esc((r && r.message) || 'Gagal membaca KTP') + '. Isi manual.');
      return;
    }
    const d = r.data || {};
    if (!r.hasText || (!d.nik && !d.nama)) {
      setOcrStatus('warn', '📷 <b>Tulisan KTP tidak terbaca jelas.</b>' + (tip ? '<br>' + esc(tip) : '') +
        '<ul><li>Foto ulang dengan cahaya cukup, tanpa silau</li><li>Pastikan seluruh KTP dalam bingkai & tajam</li></ul>Atau isi Nama & NIK secara manual.');
      return;
    }
    const applied = [], offers = [];
    const tryField = (id, label, val, trusted) => {
      if (!val) return;
      const cur = $(id).value.trim();
      if (trusted && (!cur || cur === val)) { if (cur !== val) setFieldAuto(id, val); else $(id).classList.add('auto-fill'); applied.push(label); }
      else if (cur !== val) offers.push({ id, label, val, doubt: !trusted });
    };
    tryField('fNik', 'NIK', d.nik, d.nikValid);
    tryField('fNama', 'Nama', d.nama, !!d.nama);
    tryField('fTempatLahir', 'Tempat Lahir', d.tempatLahir, true);
    if (STATUS_KAWIN_LIST.indexOf(d.statusPerkawinan) !== -1) tryField('fStatusKawin', 'Status Perkawinan', d.statusPerkawinan, true);
    let html = '';
    const sure = applied.length && d.confidence === 'high';
    if (applied.length) {
      html += (sure ? '✅ <b>Terbaca otomatis:</b> ' : '⚠️ <b>Terisi otomatis (mohon cek):</b> ') + applied.join(', ').replace(/, ([^,]*)$/, ' & $1') + '. Periksa kembali sebelum menyimpan.' + (r.ms ? ' <span style="opacity:.7">(' + (r.ms / 1000).toFixed(1) + ' dtk)</span>' : '');
    }
    if (offers.length) {
      html += (html ? '<br>' : '') + offers.map(o =>
        (o.doubt ? '🤔 Hasil baca ' + o.label + ' diragukan: ' : '🔎 Hasil baca ' + o.label + ': ') + '<b>' + esc(o.val) + '</b> ' +
        '<button type="button" class="ocr-apply" data-ocr-id="' + o.id + '" data-ocr-val="' + esc(o.val) + '">Pakai</button>').join('<br>');
    }
    if (d.catatan && d.catatan.length) html += '<ul>' + d.catatan.map(c => '<li>' + esc(c) + '</li>').join('') + '</ul>';
    if (tip && !sure) html += '<div>' + esc(tip) + '</div>';
    const kind = sure && !offers.length ? 'ok' : 'warn';
    setOcrStatus(kind, html);
    const box = $('ocrSt');
    box.querySelectorAll('.ocr-apply').forEach(b => b.addEventListener('click', () => {
      setFieldAuto(b.getAttribute('data-ocr-id'), b.getAttribute('data-ocr-val'));
      b.remove();
    }));
  }

  function submitForm() {
    const nama = $('fNama').value.trim();
    const nik = $('fNik').value.trim();
    const kampung = $('fKampung').value;
    const rt = normRT($('fRt').value);
    if (!nama) { toast('Nama wajib diisi', 'error'); $('fNama').focus(); return; }
    if (!/^\d{16}$/.test(nik)) { toast('NIK harus 16 digit', 'error'); $('fNik').focus(); return; }
    if (!kampung) { toast('Pilih kampung', 'error'); return; }
    if (!rt || RT_LIST.indexOf(rt) === -1) { toast('Pilih RT', 'error'); return; }
    if (state.nikIsDup && state.dupData && state.nikLastChecked === nik) {
      showDupWarning(state.dupData);
      return;
    }

    const btn = $('btnSubmit');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0;border-color:rgba(255,255,255,.4);border-top-color:#fff"></div> Memverifikasi NIK...';
    const ks = kotakSuara({ tone: 'abu', title: 'Menyimpan data pendukung', step: 'Memeriksa NIK' });

    google.script.run
      .withSuccessHandler(checkR => {
        if (checkR.ok && !checkR.tersedia) {
          ks.close();
          btn.disabled = false;
          btn.innerHTML = ICONS.save + ' Simpan Data';
          showDupWarning(checkR.duplikat);
          state.nikIsDup = true;
          state.dupData = checkR.duplikat;
          const p = $('nikPreview');
          const fNik = $('fNik');
          if (p) { p.className = 'nik-preview dup'; p.innerHTML = '❌ <b>NIK SUDAH TERDAFTAR!</b><br>👤 ' + esc(checkR.duplikat[0].nama); }
          if (fNik) fNik.classList.add('dup-input');
          return;
        }
        btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0;border-color:rgba(255,255,255,.4);border-top-color:#fff"></div> Menyimpan...';
        const payload = Object.assign({ nama, nik, kampung, rt, fotoBase64: state.fotoBase64, fotoMime: state.fotoMime }, readDataDiriFields('f'));
        ks.step(state.fotoBase64 ? 'Mengunggah foto KTP' : 'Menyimpan ke data');
        const stepT = state.fotoBase64 ? setTimeout(() => ks.step('Menyimpan ke data'), 2500) : null;
        google.script.run
          .withSuccessHandler(r => {
            clearTimeout(stepT);
            btn.disabled = false;
            btn.innerHTML = ICONS.save + ' Simpan Data';
            if (r.ok) {
              // kertas masuk kotak (±1 dtk), lalu pindah ke halaman Data
              const anim = ks.success({ title: 'Pendukung baru tercatat', sub: nama + ' • ' + kampung + ' ' + rtLabel(rt) });
              if (r.fotoGagal) toast('⚠️ ' + r.message, 'warn');
              if (r.version) state.version = r.version;
              $('fNama').value = '';
              $('fNik').value = '';
              $('fTempatLahir').value = '';
              $('fStatusKawin').value = '';
              $('fKampung').value = '';
              $('fRt').value = '';
              $('nikPreview').style.display = 'none';
              $('fNik').classList.remove('dup-input', 'ok-input');
              state.nikIsDup = false;
              state.nikLastChecked = '';
              clearFoto();
              state.allData = null;
              state.dashboardCache = null;
              state.prevIds = {};
              state.currentPage = 1;
              let dataSiap = false, animSelesai = false;
              const lanjut = () => {
                if (!dataSiap || !animSelesai) return;
                state.page = 'data';
                state.pageToken++;
                document.querySelectorAll('[data-nav]').forEach(el => {
                  el.classList.toggle('active', el.getAttribute('data-nav') === 'data');
                });
                updateFabVisibility();
                renderData();
              };
              fetchAndReplace(false, () => { dataSiap = true; lanjut(); });   // data dimuat bersamaan dengan animasi
              anim.then(() => { animSelesai = true; lanjut(); });
            } else {
              if (r.duplikat && r.duplikat.length) {
                ks.close();
                showDupWarning(r.duplikat);
                state.nikIsDup = true;
                state.dupData = r.duplikat;
              } else {
                ks.fail(r.message || 'Data belum tersimpan');
              }
            }
          })
          .withFailureHandler(e => {
            clearTimeout(stepT);
            btn.disabled = false;
            btn.innerHTML = ICONS.save + ' Simpan Data';
            ks.fail((e && e.message ? e.message : 'Koneksi bermasalah') + ' — data belum tersimpan, coba lagi.');
          })
          .apiAdd(payload);
      })
      .withFailureHandler(e => {
        btn.disabled = false;
        btn.innerHTML = ICONS.save + ' Simpan Data';
        ks.fail('Gagal cek NIK: ' + (e && e.message ? e.message : 'koneksi bermasalah'));
      })
      .apiCheckNik({ nik: nik, excludeId: null });
  }

  // Animasi "kertas suara masuk kotak" (public/js/kotaksuara.js); aman bila skrip belum termuat
  function kotakSuara(opts) {
    if (window.KotakSuara) return window.KotakSuara.show(opts);
    const noop = () => Promise.resolve();
    return { step() {}, success: noop, fail: noop, close() {} };
  }

  function showDupWarning(duplikat) {
    const list = $('dupList');
    let html = '';
    duplikat.forEach(d => {
      const initials = (d.nama || '?').split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
      html +=
        '<div class="dup-list-item">' +
          '<div class="dup-li-avatar">' + esc(initials) + '</div>' +
          '<div class="dup-li-info">' +
            '<div class="dup-li-name">' + esc(d.nama) + '</div>' +
            '<div class="dup-li-meta">' + esc(d.kampung) + ' • ' + rtLabel(d.rt) + '</div>' +
          '</div>' +
        '</div>';
    });
    list.innerHTML = html;
    $('modalDupWarning').classList.add('show');
  }

  $('dupOkBtn').addEventListener('click', () => {
    $('modalDupWarning').classList.remove('show');
    if ($('fNik')) $('fNik').focus();
  });

  // ============================================================ //
  // HALAMAN DATA                                                  //
  // ============================================================ //
  function renderData() {
    const c = $('appContent');
    if (!c) return;

    const allList = state.allData || [];

    let baseList = allList;
    if (state.filter.kampung) {
      baseList = baseList.filter(x => String(x.kampung || '').trim() === String(state.filter.kampung).trim());
    }
    if (state.filter.rt) {
      const targetRT = normRT(state.filter.rt);
      baseList = baseList.filter(x => normRT(x.rt) === targetRT);
    }

    const countAll = baseList.length;
    const countVerified = baseList.filter(x => x.verified === true).length;
    const countUnverified = countAll - countVerified;
    const countDicetak = baseList.filter(x => x.dicetak === true).length;
    const countBelumCetak = countAll - countDicetak;

    let kampungOpts = '<option value="">Semua Kampung</option>';
    KAMPUNG_LIST.forEach(k => {
      const sel = (state.filter.kampung === k) ? ' selected' : '';
      kampungOpts += '<option value="' + esc(k) + '"' + sel + '>' + esc(k) + '</option>';
    });

    let rtOpts = '<option value="">Semua RT</option>';
    RT_LIST.forEach(rt => {
      const sel = (state.filter.rt && normRT(state.filter.rt) === normRT(rt)) ? ' selected' : '';
      const label = rt === RT_UMUM ? 'UMUM' : ('RT ' + rt);
      rtOpts += '<option value="' + rt + '"' + sel + '>' + label + '</option>';
    });

    // ⭐ Filter status verifikasi & cetak disederhanakan jadi dropdown (senada dengan Kampung/RT)
    let verifiedOpts = '<option value="">Semua Status Suara (' + countAll + ')</option>';
    verifiedOpts += '<option value="true"' + (state.filter.verified === 'true' ? ' selected' : '') + '>✅ Suara PASTI (' + countVerified + ')</option>';
    verifiedOpts += '<option value="false"' + (state.filter.verified === 'false' ? ' selected' : '') + '>⏳ Belum Pasti (' + countUnverified + ')</option>';

    let printOpts = '<option value="">Semua Status Cetak (' + countAll + ')</option>';
    printOpts += '<option value="true"' + (state.filter.dicetak === 'true' ? ' selected' : '') + '>🖨️ Sudah Dicetak (' + countDicetak + ')</option>';
    printOpts += '<option value="false"' + (state.filter.dicetak === 'false' ? ' selected' : '') + '>📄 Belum Dicetak (' + countBelumCetak + ')</option>';

    const countLaki = baseList.filter(x => x.jenisKelamin !== 'Perempuan').length;
    const countPerempuan = countAll - countLaki;
    const pctOf = n => countAll > 0 ? Math.round((n / countAll) * 100) : 0;
    const miniStat = (tone, ico, label, val, sub) =>
      '<div class="mini-stat"><div class="sc-ico ico-' + tone + '">' + ico + '</div>' +
      '<div class="ms-body"><div class="ms-label">' + label + '</div><div class="ms-value">' + fmtNum(val) + '</div><div class="ms-sub">' + sub + '</div></div></div>';

    const headActions = !canOperate() ? '' :
      '<button class="btn-tool btn-sel-mode' + (state.sel.on ? ' active' : '') + '" id="btnSelMode" type="button">' +
        (state.sel.on ? ICONS.close + ' Keluar Ceklist' : ICONS.check + ' Ceklist Cetak') +
      '</button>' +
      '<button class="btn-tool btn-dl-xlsx" id="btnMassalXlsx" type="button" title="Unduh semua data: 1 sheet per kampung, tabel per RT di dalamnya">' + ICONS.download + ' Download XLSX</button>' +
      '<button class="btn-tool btn-dl-pdf" id="btnMassalPdf" type="button" title="Unduh semua data seluruh kampung">' + ICONS.download + ' Download PDF</button>' +
      '<button class="btn-tool btn-bulk-ktp" id="btnBulkKtp" type="button">' + ICONS.download + ' Download KTP</button>' +
      '<button class="btn-tool btn-add" id="btnAddFromData" type="button">' + ICONS.plus + ' Tambah Pendukung</button>';

    c.innerHTML =
      pageHead('Data Pendukung', 'Kelola data pendukung secara lengkap dan terstruktur.', headActions) +
      '<div class="mini-stats">' +
        miniStat('blue', ICONS.users, 'Total Pendukung', countAll, 'sesuai filter') +
        miniStat('green', ICONS.male, 'Laki-laki', countLaki, pctOf(countLaki) + '%') +
        miniStat('pink', ICONS.female, 'Perempuan', countPerempuan, pctOf(countPerempuan) + '%') +
        miniStat('emerald', ICONS.shield, 'Suara PASTI', countVerified, pctOf(countVerified) + '%') +
      '</div>' +
      '<div class="filter-bar">' +
        '<div class="filter-search">' + ICONS.search +
          '<input type="text" id="fSearch" placeholder="Cari nama atau NIK..." value="' + esc(state.filter.q) + '" autocomplete="off">' +
        '</div>' +
        '<div class="filter-row">' +
          '<select id="fFilterKampung" aria-label="Filter kampung">' + kampungOpts + '</select>' +
          '<select id="fFilterRt" aria-label="Filter RT">' + rtOpts + '</select>' +
          '<select id="fFilterVerified" aria-label="Filter status suara">' + verifiedOpts + '</select>' +
          '<select id="fFilterDicetak" aria-label="Filter status cetak">' + printOpts + '</select>' +
        '</div>' +
      '</div>' +
      '<div class="grid-info" id="gridInfo"></div>' +
      '<div id="dataGridWrap"></div>' +
      '<div id="paginationWrap"></div>';

    $('fSearch').addEventListener('input', debounce(e => {
      state.filter.q = e.target.value.trim();
      state.currentPage = 1;
      renderFilteredGrid();
    }, 150));

    $('fFilterKampung').addEventListener('change', e => {
      state.filter.kampung = e.target.value;
      state.currentPage = 1;
      renderData();
    });

    $('fFilterRt').addEventListener('change', e => {
      state.filter.rt = e.target.value;
      state.currentPage = 1;
      renderData();
    });

    $('fFilterVerified').addEventListener('change', e => {
      state.filter.verified = e.target.value;
      state.currentPage = 1;
      renderData();
    });

    $('fFilterDicetak').addEventListener('change', e => {
      state.filter.dicetak = e.target.value;
      state.currentPage = 1;
      renderData();
    });

    if (canOperate()) {
      $('btnAddFromData').addEventListener('click', () => setPage('input'));
      $('btnBulkKtp').addEventListener('click', () => {
        if (!state.allData) { toast('Data masih dimuat, tunggu sebentar', 'warn'); return; }
        window.__openBulkKtp();
      });
      $('btnMassalPdf').addEventListener('click', () => window.__downloadMassalPdf());
      $('btnMassalXlsx').addEventListener('click', () => window.__downloadMassalXlsx());

      $('btnSelMode').addEventListener('click', () => {
        if (!state.allData) { toast('Data masih dimuat, tunggu sebentar', 'warn'); return; }
        if (state.sel.on) exitSelMode(true);
        else enterSelMode();
      });
    }

    if (state.allData) {
      renderFilteredGrid();
      syncData(true);
      return;
    }

    showGridSkeleton();
    fetchAndReplace(false);
  }

  function showGridSkeleton() {
    const wrap = $('dataGridWrap');
    if (!wrap) return;
    const info = $('gridInfo');
    if (info) info.innerHTML = '<span>Memuat data...</span>';
    let html = '<div class="prow-list">';
    for (let i = 0; i < 8; i++) {
      html +=
        '<div class="prow skeleton-card">' +
          '<div class="skeleton skeleton-block" style="width:38px;height:38px;border-radius:12px"></div>' +
          '<div style="flex:1;min-width:0"><div class="skeleton skeleton-line" style="width:45%;height:13px;margin-bottom:8px"></div>' +
          '<div class="skeleton skeleton-line" style="width:30%;height:11px"></div></div>' +
        '</div>';
    }
    html += '</div>';
    wrap.innerHTML = html;
  }

  // Semua filter halaman Data (kampung, RT, pencarian, status suara, status cetak)
  function getFilteredData() {
    let filtered = state.allData || [];
    if (state.filter.kampung) filtered = filtered.filter(x => String(x.kampung || '').trim() === String(state.filter.kampung).trim());
    if (state.filter.rt) {
      const targetRT = normRT(state.filter.rt);
      filtered = filtered.filter(x => normRT(x.rt) === targetRT);
    }
    if (state.filter.q) {
      const q = state.filter.q.toLowerCase();
      filtered = filtered.filter(x =>
        (x.nama || '').toLowerCase().includes(q) || (x.nik || '').includes(q)
      );
    }
    if (state.filter.verified === 'true') filtered = filtered.filter(x => x.verified === true);
    else if (state.filter.verified === 'false') filtered = filtered.filter(x => x.verified !== true);
    if (state.filter.dicetak === 'true') filtered = filtered.filter(x => x.dicetak === true);
    else if (state.filter.dicetak === 'false') filtered = filtered.filter(x => x.dicetak !== true);
    // Urutkan nama A–Z / Z–A bila dipilih (default: urutan asli)
    if (state.filter.sortAz === 'asc') {
      filtered = filtered.slice().sort((a, b) => (a.nama || '').localeCompare(b.nama || '', 'id', { sensitivity: 'base' }));
    } else if (state.filter.sortAz === 'desc') {
      filtered = filtered.slice().sort((a, b) => (b.nama || '').localeCompare(a.nama || '', 'id', { sensitivity: 'base' }));
    }
    return filtered;
  }

  function renderFilteredGrid(animate) {
    const wrap = $('dataGridWrap');
    const info = $('gridInfo');
    const pag = $('paginationWrap');
    if (!wrap) return;

    const filtered = getFilteredData();
    const selOn = state.sel.on;
    state.sel.pageIds = [];

    const totalFiltered = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / PER_PAGE));
    if (state.currentPage > totalPages) state.currentPage = totalPages;
    if (state.currentPage < 1) state.currentPage = 1;
    const startIdx = (state.currentPage - 1) * PER_PAGE;
    const endIdx = Math.min(startIdx + PER_PAGE, totalFiltered);
    const pageItems = filtered.slice(startIdx, endIdx);
    clearTimeout(state._prefetchT);
    state._prefetchT = setTimeout(() => prefetchPhotosOf(pageItems), 900);   // foto data di layar dimuat di latar

    if (info) {
      const totalAll = (state.allData || []).length;
      let infoText = 'Menampilkan <b>' + (totalFiltered === 0 ? 0 : startIdx + 1) + '–' + endIdx + '</b> dari <b>' + totalFiltered + '</b>';
      if (totalFiltered !== totalAll) infoText += ' (total ' + totalAll + ' data)';
      const parts = [];
      if (state.filter.kampung) parts.push(state.filter.kampung);
      if (state.filter.rt) parts.push(state.filter.rt === RT_UMUM ? 'UMUM' : ('RT ' + normRT(state.filter.rt)));
      if (state.filter.verified === 'true') parts.push('✅ Pasti');
      else if (state.filter.verified === 'false') parts.push('⏳ Belum');
      if (state.filter.dicetak === 'true') parts.push('🖨️ Sudah Cetak');
      else if (state.filter.dicetak === 'false') parts.push('🖨️ Belum Cetak');
      if (parts.length) infoText += ' • filter: ' + parts.join(', ');
      info.innerHTML = infoText + ' <span class="live-tag"><span class="sync-dot"></span>Realtime</span>';
    }

    if (totalFiltered === 0) {
      wrap.innerHTML = emptyState('📭', 'Tidak ada data', 'Coba ubah filter atau kata kunci pencarian');
      if (pag) pag.innerHTML = '';
      renderSelBar();
      return;
    }

    const prevIds = animate ? state.prevIds : {};
    const newIds = {};

    // Tombol urut nama (sama seperti Detail Kampung) — diletakkan pas di atas tabel
    const sortIsAsc = state.filter.sortAz !== 'desc';
    const sortBtnHTML =
      '<div class="detail-sort-bar">' +
        '<div class="detail-sort-label">' + ICONS.sortAZ + ' Urutkan Nama</div>' +
        '<div class="detail-sort-buttons">' +
          '<button class="sort-btn ' + (state.filter.sortAz !== 'default' ? 'active' : '') + '" id="btnSortNamaData" type="button" title="Urutkan berdasarkan nama">' +
            (sortIsAsc ? ICONS.sortAZ : ICONS.sortZA) + ' <span>' + (sortIsAsc ? 'A - Z' : 'Z - A') + '</span>' +
          '</button>' +
        '</div>' +
      '</div>';

    let html =
      sortBtnHTML +
      '<div class="table-scroll-hint" id="prowHint">↔ Geser tabel ke samping untuk melihat semua kolom</div>' +
      '<div class="prow-wrap">' +
      '<div class="prow-head" aria-hidden="true">' +
        '<span class="pc-no">NO</span><span class="pc-nik">NIK</span><span class="pc-name">NAMA</span>' +
        '<span class="pc-tempat">TEMPAT LAHIR</span><span class="pc-tgl">TANGGAL LAHIR</span><span class="pc-umur">UMUR</span>' +
        '<span class="pc-kawin">STATUS PERKAWINAN</span><span class="pc-jk">JENIS KELAMIN</span>' +
        '<span class="pc-alamat">ALAMAT</span><span class="pc-ttd">TTD</span>' +
      '</div>' +
      '<div class="prow-list' + (selOn ? ' select-mode' : '') + '">';
    pageItems.forEach((p, i) => {
      newIds[p.id] = true;
      state.sel.pageIds.push(String(p.id));
      const isSel = selOn && !!state.sel.ids[p.id];
      const isNew = animate && !prevIds[p.id];
      const isP = p.jenisKelamin === 'Perempuan';
      const isVerified = p.verified === true;
      const isPrinted = p.dicetak === true;
      const initials = initialsOf(p.nama);
      const rowClass = 'prow ' + (isVerified ? 'verified-card' : 'unverified-card') + (isNew ? ' is-new' : '') + (isSel ? ' selected' : '');
      const id = esc(p.id);

      html +=
        '<div class="' + rowClass + '" data-open-detail="' + id + '">' +
          (selOn ? '<div class="sel-check" aria-hidden="true">' + ICONS.check + '</div>' : '') +
          '<div class="pc-no">' + (startIdx + i + 1) + '</div>' +
          '<div class="pc-nik">' + esc(p.nik) + '</div>' +
          '<div class="pc-name">' +
            '<div class="person-avatar' + (isP ? ' p' : '') + '">' + esc(initials) +
              (isVerified ? '<div class="verified-mark">' + ICONS.check + '</div>' : '') +
            '</div>' +
            '<div class="pn-txt">' +
              '<div class="person-name" title="' + esc(p.nama) + '">' + esc(p.nama) + '</div>' +
              '<div class="pn-sub"><span class="pn-nik">' + esc(p.nik) + '</span><span class="pn-loc">' + esc(p.kampung) + ' • ' + rtLabel(p.rt) + '</span>' +
              '<span class="pn-status">' + esc(isVerified ? '✅ Pasti' : '⏳ Belum') + ' • ' + esc(isPrinted ? 'Sudah cetak' : 'Belum cetak') + '</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="pc-tempat">' + esc((p.tempatLahir || '').trim() || '-') + '</div>' +
          '<div class="pc-tgl">' + esc(formatTglTabel(p.tanggalLahir)) + '</div>' +
          '<div class="pc-umur">' + (p.usia ? esc(String(p.usia)) : '-') + '</div>' +
          '<div class="pc-kawin">' + esc((p.statusPerkawinan || '').trim() || '-') + '</div>' +
          '<div class="pc-jk"><span class="person-tag' + (isP ? ' p' : '') + '">' + esc(p.jenisKelamin) + '</span></div>' +
          '<div class="pc-alamat">' + esc(p.kampung ? 'Kp. ' + p.kampung + ' ' + rtLabel(p.rt) : rtLabel(p.rt)) + '</div>' +
          '<div class="pc-ttd">' +
            (p.fotoTTDId
              ? '<button class="ttd-btn" data-action="view-ttd" data-id="' + id + '" title="' + esc(p.metodeTTD === 'digital' ? 'Lihat tanda tangan digital' : 'Lihat bukti TTD (fotokopi KTP ber-TTD)') + '" type="button">' + ICONS.ttd + ' ' + esc(p.metodeTTD === 'digital' ? 'Digital' : 'Lihat') + '</button>'
              : '<span class="ttd-kosong">–</span>') +
          '</div>' +
          '<div class="pc-chev" aria-hidden="true">' + ICONS.next + '</div>' +
        '</div>';
    });
    html += '</div></div>';
    wrap.innerHTML = html;

    state.prevIds = newIds;
    bindGridEvents(wrap);
    setupLazyImages(wrap);

    // Tombol urut nama: toggle A–Z <-> Z–A
    const btnSortNama = $('btnSortNamaData');
    if (btnSortNama) {
      btnSortNama.addEventListener('click', () => {
        state.filter.sortAz = state.filter.sortAz === 'asc' ? 'desc' : 'asc';
        state.currentPage = 1;
        renderFilteredGrid();
      });
    }

    // Petunjuk "geser" bila tabel lebar; hilang setelah tabel digeser
    let prowHint = $('prowHint');
    let pwrap = wrap.querySelector('.prow-wrap');
    if (prowHint && pwrap) {
      pwrap.addEventListener('scroll', () => prowHint.classList.remove('show'), { once: true, passive: true });
      // Ukuran tabel ditentukan setelah tata letak; tunda sedikit agar scrollWidth benar
      setTimeout(() => {
        prowHint.classList.toggle('show', pwrap.scrollWidth > pwrap.clientWidth + 4);
      }, 60);
    }

    if (pag) renderPagination(pag, totalFiltered, totalPages);
    renderSelBar();
  }

  // ⭐ Disederhanakan jadi satu baris (‹ 1 2 3…16 ›). Tombol Awal/Akhir dan
  // kotak "Ke: ... Go" dihapus — fitur pencarian sudah cukup untuk navigasi cepat.
  function renderPagination(container, totalFiltered, totalPages) {
    if (totalPages <= 1) { container.innerHTML = ''; return; }
    const cur = state.currentPage;
    const pages = buildPageNumbers(cur, totalPages);
    let btns = '';
    btns += '<button class="page-btn nav-btn" data-page="' + (cur - 1) + '" ' + (cur === 1 ? 'disabled' : '') + ' title="Sebelumnya" type="button">' + ICONS.prev + '</button>';
    pages.forEach(p => {
      if (p === '...') btns += '<span class="page-ellipsis">…</span>';
      else btns += '<button class="page-btn' + (p === cur ? ' active' : '') + '" data-page="' + p + '" type="button">' + p + '</button>';
    });
    btns += '<button class="page-btn nav-btn" data-page="' + (cur + 1) + '" ' + (cur === totalPages ? 'disabled' : '') + ' title="Berikutnya" type="button">' + ICONS.next + '</button>';

    container.innerHTML =
      '<div class="pagination-wrap">' +
        '<div class="pagination-info">Halaman <b>' + cur + '</b> dari <b>' + totalPages + '</b></div>' +
        '<div class="pagination-controls">' + btns + '</div>' +
      '</div>';

    container.querySelectorAll('.page-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = parseInt(btn.getAttribute('data-page'), 10);
        if (!target || target < 1 || target > totalPages) return;
        if (target === state.currentPage) return;
        gotoPage(target);
      });
    });
  }

  function gotoPage(p) {
    state.currentPage = p;
    renderFilteredGrid(false);
    const wrap = $('dataGridWrap');
    if (wrap) {
      const y = wrap.getBoundingClientRect().top + window.pageYOffset - 100;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }
  }

  function buildPageNumbers(current, total) {
    const delta = 2;
    const range = [];
    const rangeWithDots = [];
    let last;
    for (let i = 1; i <= total; i++) {
      if (i === 1 || i === total || (i >= current - delta && i <= current + delta)) range.push(i);
    }
    range.forEach(i => {
      if (last) {
        if (i - last === 2) rangeWithDots.push(last + 1);
        else if (i - last > 2) rangeWithDots.push('...');
      }
      rangeWithDots.push(i);
      last = i;
    });
    return rangeWithDots;
  }

  function bindGridEvents(container) {
    // ⭐ FIX: #dataGridWrap tidak dibuat ulang saat ganti halaman/pencarian/sinkron,
    // jadi listener cukup dipasang SEKALI. Dulu terpasang berulang sehingga satu
    // klik diproses berkali-kali (fatal untuk ceklist: centang langsung terlepas lagi).
    if (container._gridBound) return;
    container._gridBound = true;
    // Sentuhan pertama pada kartu → mulai muat foto (±100–300 ms lebih awal dari klik)
    container.addEventListener('pointerdown', e => {
      const el = e.target.closest('[data-open-detail], [data-id]');
      const id = el && (el.getAttribute('data-open-detail') || el.getAttribute('data-id'));
      if (id) prefetchById(id);
    }, { passive: true });
    container.addEventListener('click', e => {
      // Mode ceklist massal: klik di mana pun pada kartu = pilih / batal pilih
      if (state.sel.on) {
        const selCard = e.target.closest('[data-open-detail]');
        if (selCard) {
          e.preventDefault();
          e.stopPropagation();
          toggleSelCard(selCard.getAttribute('data-open-detail'), selCard);
        }
        return;
      }

      const btn = e.target.closest('[data-action]');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        const action = btn.getAttribute('data-action');
        const id = btn.getAttribute('data-id');
        if (action === 'detail') { window.__openDetailWarga(id); return; }
        if (action === 'view-ttd') { window.__viewTtd(id); return; }
        if (!canOperate()) return; // role user: tombol tulis tidak ada & ditolak server
        if (action === 'edit') window.__editData(id);
        else if (action === 'del') { if (isAdmin()) window.__deleteData(id, btn.getAttribute('data-nama')); }
        else if (action === 'verify') window.__startVerify(id);
        else if (action === 'unverify') window.__unverifyData(id);
        else if (action === 'download-ktp') window.__downloadKtpA4(id, btn);
        else if (action === 'toggle-print') window.__togglePrint(id, btn);
        return;
      }

      const card = e.target.closest('[data-open-detail]');
      if (card) {
        const id = card.getAttribute('data-open-detail');
        if (id) window.__openDetailWarga(id);
      }
    });
  }

  // ============================================================ //
  // ⭐ CEKLIST MASSAL STATUS CETAK                                //
  // ============================================================ //
  // Pilih banyak data (lintas halaman & filter), lalu tandai Sudah /
  // Belum Dicetak sekaligus. Tidak bergantung pada foto KTP — data
  // tanpa foto juga bisa ditandai. Server: apiSetPrintBatch (1x tulis).
  function selCount() { return Object.keys(state.sel.ids).length; }

  function enterSelMode() {
    state.sel.on = true;
    state.sel.ids = {};
    document.body.classList.add('sel-mode');
    renderData();
    toast('Mode ceklist aktif: ketuk kartu untuk memilih', 'success');
  }

  function exitSelMode(rerender) {
    const wasOn = state.sel.on;
    state.sel.on = false;
    state.sel.ids = {};
    state.sel.pageIds = [];
    document.body.classList.remove('sel-mode');
    const bar = $('selBar');
    if (bar) bar.innerHTML = '';
    if (rerender && wasOn && state.page === 'data') renderData();
  }

  function toggleSelCard(id, cardEl) {
    if (!id || state.sel.busy) return;
    if (state.sel.ids[id]) delete state.sel.ids[id];
    else state.sel.ids[id] = true;
    // Update DOM langsung (tanpa render ulang grid) supaya cepat & tidak berkedip
    if (cardEl) cardEl.classList.toggle('selected', !!state.sel.ids[id]);
    renderSelBar();
  }

  function setSelMany(ids, on) {
    ids.forEach(id => { if (on) state.sel.ids[id] = true; else delete state.sel.ids[id]; });
    document.querySelectorAll('#dataGridWrap [data-open-detail]').forEach(card => {
      card.classList.toggle('selected', !!state.sel.ids[card.getAttribute('data-open-detail')]);
    });
    renderSelBar();
  }

  function renderSelBar() {
    // Bar ditempel ke <body>, bukan ke #appContent: .app-content punya animasi
    // transform yang membuat position:fixed di dalamnya ikut menempel ke konten.
    let bar = $('selBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'selBar';
      document.body.appendChild(bar);
    }
    if (!state.sel.on || state.page !== 'data') { bar.innerHTML = ''; return; }

    // Buang id yang sudah tidak ada (mis. dihapus orang lain saat sinkron)
    const byId = {};
    (state.allData || []).forEach(p => { byId[p.id] = p; });
    Object.keys(state.sel.ids).forEach(id => { if (!byId[id]) delete state.sel.ids[id]; });

    const filtered = getFilteredData();
    const filteredIds = filtered.map(p => String(p.id));
    const inFilter = filteredIds.filter(id => state.sel.ids[id]).length;
    const n = selCount();
    const hidden = n - inFilter;
    const pageIds = state.sel.pageIds || [];
    const pageAll = pageIds.length > 0 && pageIds.every(id => state.sel.ids[id]);
    const allFilter = filteredIds.length > 0 && inFilter === filteredIds.length;
    const belumIds = filtered.filter(p => p.dicetak !== true).map(p => String(p.id));
    const sel = Object.keys(state.sel.ids).map(id => byId[id]);
    const nBelum = sel.filter(p => p.dicetak !== true).length;
    const nSudah = n - nBelum;
    const nTanpaFoto = sel.filter(p => !(p.fotoKTPId && String(p.fotoKTPId).trim())).length;
    const busy = state.sel.busy;

    bar.innerHTML =
      '<div class="sel-bar">' +
        '<div class="sel-bar-top">' +
          '<div class="sel-count">' +
            '<b>' + n + '</b> dipilih' +
            (n ? '<span>' + nBelum + ' belum · ' + nSudah + ' sudah dicetak' + (nTanpaFoto ? ' · ' + nTanpaFoto + ' tanpa foto KTP' : '') + '</span>' : '<span>Ketuk kartu untuk memilih</span>') +
            (hidden > 0 ? '<span class="sel-hidden">' + hidden + ' terpilih di luar filter/pencarian saat ini</span>' : '') +
          '</div>' +
          '<button class="sel-done" id="selDone" type="button"' + (busy ? ' disabled' : '') + '>Selesai</button>' +
        '</div>' +
        '<div class="sel-quick">' +
          '<button type="button" id="selPage"' + (pageIds.length && !busy ? '' : ' disabled') + '>' + (pageAll ? 'Batal pilih halaman ini' : 'Pilih halaman ini (' + pageIds.length + ')') + '</button>' +
          '<button type="button" id="selAll"' + (filteredIds.length && !busy ? '' : ' disabled') + '>' + (allFilter ? 'Batal pilih semua hasil filter' : 'Pilih semua hasil filter (' + filteredIds.length + ')') + '</button>' +
          '<button type="button" id="selBelum"' + (belumIds.length && !busy ? '' : ' disabled') + '>Pilih yang belum dicetak (' + belumIds.length + ')</button>' +
          '<button type="button" id="selClear"' + (n && !busy ? '' : ' disabled') + '>Kosongkan</button>' +
        '</div>' +
        '<div class="sel-actions">' +
          '<button type="button" class="sel-mark-on" id="selMarkOn"' + (nBelum && !busy ? '' : ' disabled') + '>' +
            (busy === 'on' ? '<div class="spinner" style="width:16px;height:16px;border-width:2px;margin:0;border-color:rgba(255,255,255,.4);border-top-color:#fff"></div> Menyimpan...' : ICONS.printer + ' Tandai Sudah Dicetak' + (nBelum ? ' (' + nBelum + ')' : '')) +
          '</button>' +
          '<button type="button" class="sel-mark-off" id="selMarkOff"' + (nSudah && !busy ? '' : ' disabled') + '>' +
            (busy === 'off' ? 'Menyimpan...' : 'Tandai Belum Dicetak' + (nSudah ? ' (' + nSudah + ')' : '')) +
          '</button>' +
        '</div>' +
      '</div>';

    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('selDone', () => exitSelMode(true));
    on('selPage', () => setSelMany(pageIds, !pageAll));
    on('selAll', () => setSelMany(filteredIds, !allFilter));
    on('selBelum', () => setSelMany(belumIds, true));
    on('selClear', () => setSelMany(Object.keys(state.sel.ids), false));
    on('selMarkOn', () => confirmSelPrint(true));
    on('selMarkOff', () => confirmSelPrint(false));
  }

  function confirmSelPrint(dicetak) {
    const byId = {};
    (state.allData || []).forEach(p => { byId[p.id] = p; });
    const sel = Object.keys(state.sel.ids).map(id => byId[id]).filter(Boolean);
    // Hanya kirim yang statusnya memang berubah
    const target = sel.filter(p => (p.dicetak === true) !== dicetak);
    if (!target.length) { toast('Tidak ada data yang perlu diubah', 'warn'); return; }
    const lewati = sel.length - target.length;
    const tanpaFoto = target.filter(p => !(p.fotoKTPId && String(p.fotoKTPId).trim())).length;
    const label = dicetak ? 'SUDAH DICETAK' : 'BELUM DICETAK';

    const contoh = target.slice(0, 5).map(p => esc(p.nama)).join(', ') + (target.length > 5 ? ', dan ' + (target.length - 5) + ' lainnya' : '');
    $('confirmTitle').textContent = 'Tandai ' + (dicetak ? 'Sudah' : 'Belum') + ' Dicetak?';
    $('confirmMsg').innerHTML =
      '<b>' + target.length + ' data</b> akan ditandai <b>' + label + '</b>.<br>' +
      '<span style="font-size:12px">' + contoh + '</span>' +
      (dicetak && tanpaFoto ? '<br><br>Termasuk <b>' + tanpaFoto + ' data tanpa foto KTP</b>.' : '') +
      (lewati ? '<br>' + lewati + ' data terpilih lainnya sudah berstatus ' + label.toLowerCase() + ', dilewati.' : '');
    $('confirmYes').textContent = 'Ya, Tandai ' + target.length;
    state.confirmCb = () => applySelPrint(target.map(p => String(p.id)), dicetak);
    $('modalConfirm').classList.add('show');
  }

  function applySelPrint(ids, dicetak) {
    if (state.sel.busy) return;
    state.sel.busy = dicetak ? 'on' : 'off';
    closeConfirm();
    renderSelBar();

    const done = () => { state.sel.busy = false; renderSelBar(); };
    google.script.run
      .withSuccessHandler(r => {
        if (!r || !r.ok) { toast('❌ ' + ((r && r.message) || 'Gagal menyimpan'), 'error'); done(); return; }
        const set = {};
        ids.forEach(id => { set[id] = true; });
        (state.allData || []).forEach(p => { if (set[p.id]) p.dicetak = dicetak; });
        if (r.version) state.version = r.version;
        state.dashboardCache = null;
        toast('🖨️ ' + r.count + ' data ditandai ' + (dicetak ? 'sudah' : 'belum') + ' dicetak', 'success');
        state.sel.busy = false;
        exitSelMode(false);
        if (state.page === 'data') renderData();
      })
      .withFailureHandler(e => {
        toast('Gagal: ' + e.message, 'error');
        done();
      })
      .apiSetPrintBatch(ids, dicetak);
  }

  // ⭐ MODAL DETAIL WARGA
  window.__openDetailWarga = function(id) {
    const p = (state.allData || []).find(x => String(x.id) === String(id));
    if (!p) { toast('Data tidak ditemukan', 'error'); return; }

    state.detailWargaId = id;
    state._detailSig = JSON.stringify(p);
    prefetchById(id);
    renderModalDetailWarga(p);
    $('modalDetailWarga').classList.add('show');
  };

  // Buka lembar bukti TTD (fotokopi ber-TTD atau TTD digital) di penampil foto
  window.__viewTtd = function(id) {
    const p = (state.allData || []).find(x => String(x.id) === String(id));
    if (!p) { toast('Data tidak ditemukan', 'error'); return; }
    const url = p.fotoTTD || (p.fotoTTDId ? '/api/photo?id=' + encodeURIComponent(p.fotoTTDId) : '');
    if (!url) { toast('Bukti TTD belum tersedia', 'error'); return; }
    window.__showFoto(url);
  };

  // Foto KTP/TTD di detail digambar ke canvas (tidak bisa "Download gambar" lewat tekan lama)
  function fotoAmanHtml(url, alt) {
    if (window.FotoAman) return window.FotoAman.html(url, alt);
    return '<div class="foto-wrap"><img class="warga-foto" src="' + esc(url) + '" alt="' + esc(alt) + '"></div>';
  }

  /** Satu baris info di detail pendukung; nilai kosong (data lama) tampil sebagai "-" */
  function infoRow(label, value) {
    const v = String(value == null ? '' : value).trim();
    return '<div class="warga-info-row"><span class="lbl">' + esc(label) + '</span>' +
      '<span class="val' + (v ? '' : ' kosong') + '">' + (v ? esc(v) : '-') + '</span></div>';
  }

  function renderModalDetailWarga(p) {
    const content = $('modalDetailWargaContent');
    if (!content) return;

    const isVerified = p.verified === true;
    const isPrinted = p.dicetak === true;
    const isP = p.jenisKelamin === 'Perempuan';
    const initials = (p.nama || '?').split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
    const fotoKTP = p.fotoKTP || '';
    const fotoTTD = p.fotoTTD || '';

    content.innerHTML =
      '<div class="warga-detail-head">' +
        '<div class="warga-avatar' + (isP ? ' p' : '') + '">' + esc(initials) + '</div>' +
        '<div class="warga-head-info">' +
          '<div class="warga-head-name">' + esc(p.nama) + '</div>' +
          '<div class="warga-head-meta">' + esc(p.nik) + ' • ' + esc(p.kampung) + ', ' + rtLabel(p.rt) + '</div>' +
          '<span class="person-verify-tag ' + (isVerified ? 'verified' : 'unverified') + '" style="margin-top:6px">' +
            (isVerified ? ICONS.shield + ' SUARA PASTI' : ICONS.clock + ' BELUM PASTI') +
          '</span>' +
          '<span class="person-print-tag ' + (isPrinted ? 'printed' : 'unprinted') + '" style="margin-top:6px">' +
            ICONS.printer + (isPrinted ? ' SUDAH DICETAK' : ' BELUM DICETAK') +
          '</span>' +
        '</div>' +
        '<button class="modal-close" id="btnCloseDetailWarga" type="button" title="Tutup">' + ICONS.close + '</button>' +
      '</div>' +

      '<div class="warga-section">' +
        '<div class="warga-section-title">' + ICONS.users + ' Informasi Data</div>' +
        '<div class="warga-info-grid">' +
          '<div class="warga-info-row"><span class="lbl">Nama</span><span class="val">' + esc(p.nama) + '</span></div>' +
          '<div class="warga-info-row"><span class="lbl">NIK</span><span class="val mono">' + esc(p.nik) + '</span></div>' +
          '<div class="warga-info-row"><span class="lbl">Jenis Kelamin</span><span class="val">' + esc(p.jenisKelamin) + '</span></div>' +
          '<div class="warga-info-row"><span class="lbl">Usia</span><span class="val">' + (p.usia || '-') + ' tahun</span></div>' +
          infoRow('Tempat Lahir', p.tempatLahir) +
          infoRow('Tanggal Lahir', p.tanggalLahir ? formatTglLahir(p.tanggalLahir) : '') +
          infoRow('Status Perkawinan', p.statusPerkawinan) +
          '<div class="warga-info-row"><span class="lbl">Kampung</span><span class="val">' + esc(p.kampung) + '</span></div>' +
          '<div class="warga-info-row"><span class="lbl">RT</span><span class="val">' + rtLabel(p.rt) + '</span></div>' +
        '</div>' +
      '</div>' +

      '<div class="warga-section">' +
        '<div class="warga-section-title">' + ICONS.card + ' Foto KTP</div>' +
        (fotoKTP
          ? fotoAmanHtml(fotoKTP, 'Foto KTP ' + p.nama)
          : '<div class="warga-foto-empty">📷 Belum ada foto KTP</div>'
        ) +
      '</div>' +

      '<div class="warga-section">' +
        '<div class="warga-section-title">' + ICONS.ttd + (p.metodeTTD === 'digital' ? ' Bukti Tanda Tangan Digital' : ' Bukti Fotokopi KTP yang Ditandatangani') + '</div>' +
        (fotoTTD
          ? fotoAmanHtml(fotoTTD, 'Bukti TTD ' + p.nama) +
            '<div class="warga-ttd-note">✅ ' + (p.metodeTTD === 'digital' ? 'Diverifikasi dengan tanda tangan digital' : 'Sudah diverifikasi dengan bukti fotokopi KTP ber-TTD') + '</div>'
          : '<div class="warga-foto-empty">' +
              (isVerified
                ? '⚠️ Status PASTI tapi bukti TTD belum diupload'
                : '⏳ Belum diverifikasi'
              ) +
            '</div>'
        ) +
      '</div>' +

      (!canOperate() ? '' : '<div class="warga-actions">' +
        (isVerified
          ? '<button class="btn btn-outline wa-main" id="btnDetailUnverify" type="button">' + ICONS.clock + ' Batal Verifikasi</button>'
          : '<button class="btn btn-primary wa-main" id="btnDetailVerify" type="button">' + ICONS.shield + ' Verifikasi Sekarang</button>'
        ) +
        '<button class="btn wa-btn wa-edit" id="btnDetailEdit" type="button">' + ICONS.edit + ' Edit Data</button>' +
        '<button class="btn wa-btn wa-print" id="btnDetailPrint" type="button">' + ICONS.printer + (isPrinted ? ' Tandai Belum Cetak' : ' Tandai Sudah Cetak') + '</button>' +
        '<button class="btn wa-btn wa-ktp" id="btnDetailKtp" type="button"' + (p.fotoKTPId ? '' : ' disabled') + '>' + ICONS.download + ' Unduh KTP</button>' +
        (isAdmin() ? '<button class="btn wa-btn wa-del" id="btnDetailDel" type="button">' + ICONS.trash + ' Hapus Data</button>' : '') +
        '<button class="btn wa-btn wa-ktp" id="btnDetailKtpTtd" type="button"' + (hasTtdDigital(p) && p.fotoKTPId ? '' : ' disabled') + ' title="' +
          (hasTtdDigital(p) ? (p.fotoKTPId ? 'Unduh KTP + TTD digital (A4)' : 'Belum ada foto KTP') : 'Tersedia untuk data yang diverifikasi dengan TTD digital') + '">' + ICONS.download + ' Unduh KTP + TTD Digital</button>' +
      '</div>');

    if (window.FotoAman) window.FotoAman.hydrate(content);
    content.querySelectorAll('[data-pf]').forEach(w => w.addEventListener('click', () => window.__showFoto(w.getAttribute('data-pf'))));

    const btnClose = $('btnCloseDetailWarga');
    if (btnClose) btnClose.addEventListener('click', () => {
      $('modalDetailWarga').classList.remove('show');
      state.detailWargaId = null;
    });

    const btnVerify = $('btnDetailVerify');
    if (btnVerify) {
      btnVerify.addEventListener('click', () => {
        $('modalDetailWarga').classList.remove('show');
        state.detailWargaId = null;
        window.__startVerify(p.id);
      });
    }

    const closeDetail = () => { $('modalDetailWarga').classList.remove('show'); state.detailWargaId = null; };
    const bindDetail = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', () => fn(el)); };
    bindDetail('btnDetailEdit', () => { closeDetail(); window.__editData(p.id); });
    bindDetail('btnDetailDel', () => { closeDetail(); window.__deleteData(p.id, p.nama); });
    bindDetail('btnDetailPrint', el => { closeDetail(); window.__togglePrint(p.id, null); });
    bindDetail('btnDetailKtp', el => window.__downloadKtpA4(p.id, el));
    bindDetail('btnDetailKtpTtd', el => window.__downloadKtpTtd(p.id, el));

    const btnUnverify = $('btnDetailUnverify');
    if (btnUnverify) {
      btnUnverify.addEventListener('click', () => {
        $('modalDetailWarga').classList.remove('show');
        state.detailWargaId = null;
        window.__unverifyData(p.id);
      });
    }
  }

  // ============================================================ //
  // MODAL VERIFIKASI TTD                                          //
  // ============================================================ //
  window.__startVerify = function(id) {
    const p = (state.allData || []).find(x => String(x.id) === String(id));
    if (!p) { toast('Data tidak ditemukan', 'error'); return; }

    state.verifyId = id;
    state.verifyFotoTTDBase64 = null;
    state.verifyFotoTTDMime = null;
    let m = 'foto';
    try { m = localStorage.getItem('pendukung_verif_metode') === 'digital' ? 'digital' : 'foto'; } catch (e) {}
    state.verifyMetode = m;                       // pilihan terakhir diingat di perangkat ini

    renderModalVerifTTD(p);
    $('modalVerifTTD').classList.add('show');
  };

  function renderModalVerifTTD(p) {
    const content = $('modalVerifTTDContent');
    if (!content) return;

    const isP = p.jenisKelamin === 'Perempuan';
    const initials = (p.nama || '?').split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase();

    content.innerHTML =
      '<div class="verif-head">' +
        '<div class="verif-icon">' + ICONS.shield + '</div>' +
        '<h3>Verifikasi Suara PASTI</h3>' +
        '<p id="verifSub">Pilih cara verifikasi: fotokopi KTP ber-TTD atau tanda tangan digital</p>' +
      '</div>' +

      '<div class="verif-info">' +
        '<div class="verif-avatar' + (isP ? ' p' : '') + '">' + esc(initials) + '</div>' +
        '<div>' +
          '<div class="verif-name">' + esc(p.nama) + '</div>' +
          '<div class="verif-nik">' + esc(p.nik) + '</div>' +
          '<div class="verif-meta">' + esc(p.kampung) + ' • ' + rtLabel(p.rt) + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="verif-tabs" role="tablist">' +
        '<button type="button" role="tab" class="verif-tab" data-metode="foto">' + ICONS.camera + '<span>Fotokopi KTP</span></button>' +
        '<button type="button" role="tab" class="verif-tab" data-metode="digital">' + ICONS.ttd + '<span>TTD Digital</span></button>' +
      '</div>' +

      '<div class="verif-upload" id="verifPanelFoto">' +
        '<label class="form-label">📸 Bukti Fotokopi KTP yang Ditandatangani <span class="req">*</span></label>' +
        '<div class="foto-box" id="verifTTDBox">' +
          '<div class="foto-placeholder" id="verifTTDPlaceholder">' +
            '<div class="ico">' + ICONS.ttd + '</div>' +
            'Ambil foto bukti TTD langsung atau pilih dari galeri' +
          '</div>' +
          '<img id="verifTTDPreview" class="foto-preview" style="display:none" alt="">' +
          '<div class="foto-btns">' +
            '<button type="button" class="foto-btn primary" id="btnVerifKamera">' + ICONS.camera + 'Kamera</button>' +
            '<button type="button" class="foto-btn" id="btnVerifGaleri">' + ICONS.gallery + 'Galeri</button>' +
          '</div>' +
          '<button type="button" class="foto-hapus" id="btnVerifHapus" style="display:none">' + ICONS.trash + ' Hapus</button>' +
        '</div>' +
        '<div class="form-hint" style="margin-top:8px">⚠️ Wajib upload bukti TTD untuk verifikasi</div>' +
      '</div>' +

      '<div class="verif-digital" id="verifPanelDigital" style="display:none">' +
        '<div class="verif-statement" id="verifStatement"></div>' +
        '<div id="verifPad"></div>' +
        '<div class="form-hint" style="margin-top:8px">✍️ Serahkan HP ke warga untuk tanda tangan langsung di layar. Tersimpan sebagai lembar bukti beserta nama, NIK, waktu & saksi.</div>' +
      '</div>' +

      '<div class="confirm-btns" style="margin-top:20px">' +
        '<button class="btn btn-outline" id="btnVerifCancel" type="button">Batal</button>' +
        '<button class="btn btn-primary" id="btnVerifSave" type="button">' + ICONS.shield + ' Verifikasi</button>' +
      '</div>';

    $('btnVerifKamera').addEventListener('click', () => $('verifCameraInput').click());
    $('btnVerifGaleri').addEventListener('click', () => $('verifGalleryInput').click());
    $('verifCameraInput').onchange = handleVerifFotoInput;
    $('verifGalleryInput').onchange = handleVerifFotoInput;
    $('btnVerifHapus').addEventListener('click', clearVerifFoto);
    $('btnVerifCancel').addEventListener('click', closeModalVerif);
    $('btnVerifSave').addEventListener('click', doVerifyWithTTD);
    $('verifStatement').textContent = pernyataanDukungan(p);
    document.querySelectorAll('#modalVerifTTDContent .verif-tab').forEach(b =>
      b.addEventListener('click', () => setVerifMetode(b.getAttribute('data-metode'))));
    setVerifMetode(state.verifyMetode || 'foto');
  }

  function pernyataanDukungan(p) {
    return 'Saya, ' + (p.nama || '') + ', dengan sadar dan tanpa paksaan menyatakan memberikan dukungan kepada ' +
      (NAMA_KANDIDAT || 'calon kepala desa') + ' pada ' + (NAMA_PILKADES || 'pemilihan kepala desa') + '.';
  }

  /** Ganti cara verifikasi: 'foto' (unggah fotokopi KTP ber-TTD) | 'digital' (tanda tangan di layar) */
  function setVerifMetode(m) {
    m = m === 'digital' ? 'digital' : 'foto';
    state.verifyMetode = m;
    try { localStorage.setItem('pendukung_verif_metode', m); } catch (e) {}
    document.querySelectorAll('#modalVerifTTDContent .verif-tab').forEach(b => {
      const on = b.getAttribute('data-metode') === m;
      b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('verifPanelFoto').style.display = m === 'foto' ? '' : 'none';
    $('verifPanelDigital').style.display = m === 'digital' ? '' : 'none';
    $('verifSub').textContent = m === 'digital'
      ? 'Warga menandatangani langsung di layar HP ini'
      : 'Upload bukti fotokopi KTP yang sudah ditandatangani warga';
    if (m === 'digital' && !state.verifyPad && window.TtdPad) {
      state.verifyPad = window.TtdPad.create($('verifPad'), { onChange: updateVerifBtn });
    }
    updateVerifBtn();
  }

  function updateVerifBtn() {
    const btn = $('btnVerifSave');
    if (!btn || btn.dataset.busy) return;
    const m = state.verifyMetode;
    btn.innerHTML = ICONS.shield + (m === 'digital' ? ' Simpan & Verifikasi' : ' Verifikasi');
  }

  function handleVerifFotoInput(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('Foto maksimal 8 MB', 'error'); e.target.value = ''; return; }
    compressImage(file, (base64, mime) => {
      if (!base64) { toast('Gagal memproses foto', 'error'); e.target.value = ''; return; }
      state.verifyFotoTTDBase64 = base64;
      state.verifyFotoTTDMime = mime;
      $('verifTTDPreview').src = base64;
      $('verifTTDPreview').style.display = 'block';
      $('verifTTDPlaceholder').style.display = 'none';
      $('verifTTDBox').classList.add('has-foto');
      $('btnVerifHapus').style.display = 'flex';
      e.target.value = '';
    });
  }

  function clearVerifFoto() {
    state.verifyFotoTTDBase64 = null;
    state.verifyFotoTTDMime = null;
    $('verifTTDPreview').style.display = 'none';
    $('verifTTDPreview').src = '';
    $('verifTTDPlaceholder').style.display = 'block';
    $('verifTTDBox').classList.remove('has-foto');
    $('btnVerifHapus').style.display = 'none';
  }

  function closeModalVerif() {
    $('modalVerifTTD').classList.remove('show');
    if (state.verifyPad) { state.verifyPad.destroy(); state.verifyPad = null; }
    state.verifyId = null;
    state.verifyFotoTTDBase64 = null;
    state.verifyFotoTTDMime = null;
  }

  function doVerifyWithTTD() {
    if (!state.verifyId) { toast('Data tidak valid', 'error'); return; }
    const metode = state.verifyMetode === 'digital' ? 'digital' : 'foto';
    let ttdData = state.verifyFotoTTDBase64, ttdMime = state.verifyFotoTTDMime;
    if (metode === 'digital') {
      const pad = state.verifyPad;
      if (!pad || pad.isEmpty()) { toast('Warga belum menandatangani', 'error'); return; }
      if (pad.isTooShort()) { toast('Tanda tangan terlalu singkat — minta warga tanda tangan dengan jelas', 'error'); return; }
      const p0 = (state.allData || []).find(x => String(x.id) === String(state.verifyId)) || {};
      const u = state.user || {};
      const now = new Date();
      const waktu = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: HH_ZONE }) +
        ' pukul ' + now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: HH_ZONE }).replace('.', ':') + ' ' + HH_LABEL;
      ttdData = pad.toProof({
        nama: p0.nama, nik: p0.nik, kampung: p0.kampung, rt: rtLabel(p0.rt),
        pernyataan: pernyataanDukungan(p0), waktu,
        saksi: (u.nama || u.username || '') + (u.role ? ' (' + ROLE_LABEL[userRole()] + ')' : ''),
        aplikasi: 'Suara Pendukung'
      });
      ttdMime = 'image/jpeg';
    } else if (!ttdData) { toast('Bukti TTD wajib diupload', 'error'); return; }

    const btn = $('btnVerifSave');
    btn.dataset.busy = '1';
    btn.disabled = true;
    const pv = (state.allData || []).find(x => String(x.id) === String(state.verifyId)) || {};
    const ks = kotakSuara({ tone: 'hijau', title: 'Memverifikasi Suara PASTI',
      step: metode === 'digital' ? 'Mengunggah tanda tangan digital' : 'Mengunggah bukti TTD' });
    const stepT = setTimeout(() => ks.step('Menyimpan ke data'), 2500);
    btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;margin:0;border-color:rgba(255,255,255,.4);border-top-color:#fff"></div> Memverifikasi...';

    google.script.run
      .withSuccessHandler(r => {
        clearTimeout(stepT);
        delete btn.dataset.busy;
        btn.disabled = false;
        updateVerifBtn();
        if (r.ok) {
          ks.success({ title: 'Suara PASTI ✅', sub: (pv.nama || '') + (pv.kampung ? ' • ' + pv.kampung + ' ' + rtLabel(pv.rt) : '') });
          const p = (state.allData || []).find(x => String(x.id) === String(state.verifyId));
          if (p) {
            p.verified = true;
            p.fotoTTD = r.fotoTTD || '';
            p.fotoTTDId = r.fotoTTDId || '';
            p.metodeTTD = r.metodeTTD || metode;
          }
          if (r.version) state.version = r.version;
          state.dashboardCache = null;
          closeModalVerif();
          if (state.page === 'data') renderData();
          else if (state.page === 'detail-kampung') renderDetailKampung();
        } else {
          ks.fail(r.message || 'Verifikasi belum tersimpan');
        }
      })
      .withFailureHandler(e => {
        clearTimeout(stepT);
        delete btn.dataset.busy;
        btn.disabled = false;
        updateVerifBtn();
        ks.fail((e && e.message ? e.message : 'Koneksi bermasalah') + ' — belum tersimpan, coba lagi.');
      })
      .apiVerifyWithTTD({
        id: state.verifyId,
        fotoTTDBase64: ttdData,
        fotoTTDMime: ttdMime,
        metode
      });
  }

  window.__unverifyData = function(id) {
    const p = (state.allData || []).find(x => String(x.id) === String(id));
    if (!p) { toast('Data tidak ditemukan', 'error'); return; }

    $('confirmTitle').textContent = 'Batalkan Verifikasi?';
    $('confirmMsg').innerHTML = 'Status <b>' + esc(p.nama) + '</b> akan dikembalikan ke BELUM PASTI. Bukti TTD juga akan dihapus.';
    $('confirmYes').textContent = 'Ya, Batalkan';
    state.confirmCb = () => {
      google.script.run
        .withSuccessHandler(r => {
          closeConfirm();
          if (r.ok) {
            toast('✅ ' + r.message, 'success');
            const px = (state.allData || []).find(x => String(x.id) === String(id));
            if (px) {
              px.verified = false;
              px.fotoTTD = '';
              px.fotoTTDId = '';
            }
            if (r.version) state.version = r.version;
            state.dashboardCache = null;
            if (state.page === 'data') renderData();
            else if (state.page === 'detail-kampung') renderDetailKampung();
          } else {
            toast('❌ ' + r.message, 'error');
          }
        })
        .withFailureHandler(e => {
          closeConfirm();
          toast('Gagal: ' + e.message, 'error');
        })
        .apiUnverify(id);
    };
    $('modalConfirm').classList.add('show');
  };

  // ⭐ Toggle status "Dicetak" — langsung tanpa modal konfirmasi (aksi ringan & mudah dibalik)
  window.__togglePrint = function(id, btnEl) {
    const p = (state.allData || []).find(x => String(x.id) === String(id));
    if (!p) { toast('Data tidak ditemukan', 'error'); return; }

    const next = !(p.dicetak === true);
    if (btnEl) btnEl.disabled = true;

    google.script.run
      .withSuccessHandler(r => {
        if (btnEl) btnEl.disabled = false;
        if (r.ok) {
          const px = (state.allData || []).find(x => String(x.id) === String(id));
          if (px) px.dicetak = r.dicetak === true;
          if (r.version) state.version = r.version;
          state.dashboardCache = null;
          toast(r.dicetak ? '🖨️ Ditandai sudah dicetak' : 'Ditandai belum dicetak', 'success');
          if (state.page === 'data') renderData();
          else if (state.page === 'detail-kampung') renderDetailKampung();
        } else {
          toast('❌ ' + r.message, 'error');
        }
      })
      .withFailureHandler(e => {
        if (btnEl) btnEl.disabled = false;
        toast('Gagal: ' + e.message, 'error');
      })
      .apiTogglePrint(id, next);
  };

  function setupLazyImages(container) {
    const imgs = container.querySelectorAll('img.person-foto[data-src]');
    imgs.forEach(img => {
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        const full = img.getAttribute('data-full');
        if (full) window.__showFoto(full);
      });
    });
    if (!('IntersectionObserver' in window)) {
      imgs.forEach(img => {
        img.src = img.getAttribute('data-src');
        img.removeAttribute('data-src');
      });
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          const src = img.getAttribute('data-src');
          if (src) {
            img.src = src;
            img.removeAttribute('data-src');
          }
          observer.unobserve(img);
        }
      });
    }, { rootMargin: '200px 0px' });
    imgs.forEach(img => observer.observe(img));
  }

  // ============================================================ //
  // ⭐ PREFETCH FOTO — foto mulai dimuat SEBELUM detail dibuka      //
  // (disimpan cache perangkat oleh service worker & CDN Vercel)    //
  // ============================================================ //
  const photoPrefetched = new Set();
  const photoQueue = [];
  let photoActive = 0;
  function saveDataMode() {
    const c = navigator.connection;
    return !!(c && (c.saveData || /2g/.test(c.effectiveType || '')));
  }
  function prefetchPhoto(url, urgent) {
    if (!url || photoPrefetched.has(url)) return;
    photoPrefetched.add(url);
    if (urgent) photoQueue.unshift(url); else photoQueue.push(url);
    pumpPhotoQueue();
  }
  function pumpPhotoQueue() {
    while (photoActive < 3 && photoQueue.length) {
      const url = photoQueue.shift();
      photoActive++;
      fetch(url, { credentials: 'same-origin' })
        .then(r => r.blob())       // isi dibaca penuh → tersimpan di cache
        .catch(() => { photoPrefetched.delete(url); })
        .finally(() => { photoActive--; pumpPhotoQueue(); });
    }
  }
  function prefetchPhotosOf(items) {
    if (saveDataMode()) return;
    (items || []).slice(0, PER_PAGE).forEach(p => { if (p && p.fotoKTP) prefetchPhoto(p.fotoKTP); });
  }
  function prefetchById(id) {
    const p = (state.allData || []).find(x => String(x.id) === String(id));
    if (p && p.fotoKTP) prefetchPhoto(p.fotoKTP, true);
    if (p && p.fotoTTD) prefetchPhoto(p.fotoTTD, true);
  }

  // ============================================================ //
  // EDIT & DELETE                                                 //
  // ============================================================ //
  window.__showFoto = function(url) {
    // URL Drive lama (https://drive.google.com/...) diarahkan ke proxy
    // ter-autentikasi /api/photo supaya tetap tampil tanpa sharing publik.
    const m = String(url || '').match(/[?&]id=([\w-]+)/);
    if (m && String(url).indexOf('drive.google') !== -1) {
      url = '/api/photo?id=' + encodeURIComponent(m[1]);
    }
    const cv = $('modalFotoCv'), box = $('modalFotoBox');
    if (box) { box.classList.add('is-loading'); box.classList.remove('is-err'); }
    if (cv) { cv.width = 1; cv.height = 1; }
    $('modalFoto').classList.add('show');
    if (window.FotoAman && cv) {
      window.FotoAman.draw(cv, url)
        .then(() => box && box.classList.remove('is-loading'))
        .catch(() => { if (box) { box.classList.remove('is-loading'); box.classList.add('is-err'); } });
    }
  };

  window.__editData = function(id) {
    if (!canOperate()) { toast(state.offline ? '📴 Edit data butuh internet' : 'Akun Anda hanya bisa melihat data', 'warn'); return; }
    const p = (state.allData || []).find(x => String(x.id) === String(id));
    if (!p) { toast('Data tidak ditemukan', 'error'); return; }
    openEditModal(p);
  };

  window.__deleteData = function(id, nama) {
    if (!isAdmin()) { toast('Hapus data khusus Super Admin', 'warn'); return; }
    $('confirmTitle').textContent = 'Hapus Data?';
    $('confirmMsg').innerHTML = 'Data <b>' + esc(nama) + '</b> akan dihapus permanen. Lanjutkan?';
    $('confirmYes').textContent = 'Ya, Hapus';
    state.confirmCb = () => {
      google.script.run
        .withSuccessHandler(r => {
          closeConfirm();
          if (r.ok) {
            toast('✅ ' + r.message, 'success');
            if (r.version) state.version = r.version;
            state.prevIds = {};
            state.dashboardCache = null;
            fetchAndReplace(false);
            checkDupBadge();
            if ($('modalScanDup').classList.contains('show')) startScanDup();
          } else {
            toast('❌ ' + r.message, 'error');
          }
        })
        .withFailureHandler(e => {
          closeConfirm();
          toast('Gagal: ' + e.message, 'error');
        })
        .apiDelete(id);
    };
    $('modalConfirm').classList.add('show');
  };

  function closeConfirm() {
    $('modalConfirm').classList.remove('show');
    state.confirmCb = null;
  }

  $('confirmNo').addEventListener('click', closeConfirm);
  $('confirmYes').addEventListener('click', () => { if (state.confirmCb) state.confirmCb(); });

  // ============================================================ //
  // MODAL EDIT                                                    //
  // ============================================================ //
  // ============================================================ //
  // ⭐ SCAN ULANG KTP DARI MODAL EDIT                            //
  // Ambil foto KTP dari server → OCR → isi kolom yang kosong    //
  // (Tempat Lahir, Status Perkawinan). Kolom terisi tidak        //
  // ditimpa. KTP juga tetap tersimpan untuk verifikasi.          //
  // ============================================================ //
  function setEditOcrStatus(kind, html) {
    const el = $('eOcrSt');
    if (!el) return;
    el.style.display = html ? '' : 'none';
    el.className = 'ocr-st' + (kind ? ' show ' + kind : '');
    el.innerHTML = html || '';
  }

  async function runKtpOcrEdit(fotoKTPId) {
    const btn = $('eBtnScanKtp');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="ocr-spin" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>Membaca…'; }
    setEditOcrStatus('busy', '<div class="ocr-row"><span class="ocr-spin"></span><span>Mengambil foto KTP dari server…</span></div>');

    try {
      // Ambil foto dari server (butuh auth cookie)
      const fotoUrl = '/api/photo?id=' + encodeURIComponent(fotoKTPId);
      const resp = await fetch(fotoUrl, { credentials: 'same-origin' });
      if (!resp.ok) throw new Error('Gagal mengambil foto (HTTP ' + resp.status + ')');
      const blob = await resp.blob();

      // Kompresi untuk OCR (sama seperti shrinkForOcr di form input)
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Gagal membaca file foto'));
        reader.readAsDataURL(blob);
      });

      // Tampilkan status OCR
      setEditOcrStatus('busy', '<div class="ocr-row"><span class="ocr-spin"></span><span>Membaca data dari KTP…</span></div>');

      // Kompresi untuk OCR (mandiri — sama seperti shrinkForOcr di form input)
      const img = new Image();
      img.onload = () => {
        const tries = [[1280, 0.82], [1100, 0.75], [960, 0.7]];
        let small = dataUrl;
        for (const [maxSide, q] of tries) {
          const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
          const g = c.getContext('2d');
          g.imageSmoothingQuality = 'high';
          g.drawImage(img, 0, 0, c.width, c.height);
          small = c.toDataURL('image/jpeg', q);
          if (small.length < 420000) break;
        }
        google.script.run
          .withSuccessHandler(r => {
            if (btn) { btn.disabled = false; btn.innerHTML = ICONS.search + ' Scan Ulang KTP'; }
            showOcrResultEdit(r);
          })
          .withFailureHandler(e => {
            if (btn) { btn.disabled = false; btn.innerHTML = ICONS.search + ' Scan Ulang KTP'; }
            setEditOcrStatus('err', '⚠️ Gagal membaca otomatis (' + esc(e && e.message ? e.message : 'error') + '). Kolom tetap bisa diisi manual.');
          })
          .apiOcrKtp({ image: small });
      };
      img.onerror = () => {
        if (btn) { btn.disabled = false; btn.innerHTML = ICONS.search + ' Scan Ulang KTP'; }
        setEditOcrStatus('err', '⚠️ Gagal memproses foto KTP');
      };
      img.src = dataUrl;
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = ICONS.search + ' Scan Ulang KTP'; }
      setEditOcrStatus('err', '⚠️ Gagal mengambil foto KTP dari server: ' + esc(e && e.message ? e.message : 'error'));
    }
  }

  function showOcrResultEdit(r) {
    if (!r || !r.ok) {
      const code = r && r.code;
      if (code === 'OCR_DISABLED' || code === 'OCR_DENIED') {
        setEditOcrStatus('warn', 'ℹ️ ' + esc(r.message) + '<br>Kolom tetap bisa diisi manual.');
      } else {
        setEditOcrStatus('err', '⚠️ ' + esc((r && r.message) || 'Gagal membaca KTP') + '. Kolom tetap bisa diisi manual.');
      }
      return;
    }
    const d = r.data || {};
    if (!r.hasText || (!d.nik && !d.nama)) {
      setEditOcrStatus('warn', '📷 <b>Tulisan KTP tidak terbaca jelas.</b><br>Coba ganti foto KTP yang lebih jelas, atau isi manual.');
      return;
    }

    const filled = [];
    const tryFillEmpty = (id, label, val) => {
      if (!val) return;
      const el = $(id);
      if (!el) return;
      const cur = el.value.trim();
      if (!cur || cur === '') {
        setFieldAutoEdit(id, val);
        filled.push(label);
      }
    };

    // Hanya isi kolom yang masih kosong — jangan timpa data yang sudah ada
    tryFillEmpty('eTempatLahir', 'Tempat Lahir', d.tempatLahir);
    if (STATUS_KAWIN_LIST.indexOf(d.statusPerkawinan) !== -1) {
      tryFillEmpty('eStatusKawin', 'Status Perkawinan', d.statusPerkawinan);
    }

    let html = '';
    if (filled.length) {
      html += '✅ <b>Terisi otomatis:</b> ' + filled.join(' & ') + '. Kolom yang sudah terisi tidak diubah.' + (r.ms ? ' <span style="opacity:.7">(' + (r.ms / 1000).toFixed(1) + ' dtk)</span>' : '');
      setEditOcrStatus('ok', html);
    } else {
      setEditOcrStatus('warn', 'ℹ️ Semua kolom data diri sudah terisi — tidak ada yang perlu diubah dari hasil scan.');
    }
  }

  function setFieldAutoEdit(id, val) {
    const el = $(id);
    if (!el) return;
    el.value = val;
    el.classList.add('auto-fill');
    el.addEventListener('input', () => el.classList.remove('auto-fill'), { once: true });
  }

  function openEditModal(p) {
    state.editId = p.id;
    state.fotoBase64 = null;
    state.fotoMime = null;
    state.editFotoTTDBase64 = null;
    state.editFotoTTDMime = null;
    state.editHapusTTD = false;

    let kampungOpts = '';
    KAMPUNG_LIST.forEach(k => kampungOpts += '<option value="' + esc(k) + '"' + (p.kampung === k ? ' selected' : '') + '>' + esc(k) + '</option>');
    if (KAMPUNG_LIST.indexOf(p.kampung) === -1 && p.kampung) {
      kampungOpts = '<option value="' + esc(p.kampung) + '" selected>' + esc(p.kampung) + ' (tidak di config)</option>' + kampungOpts;
    }

    const curRT = normRT(p.rt);
    let rtOpts = '';
    RT_LIST.forEach(rt => {
      const label = rt === RT_UMUM ? 'UMUM (Tanpa RT)' : ('RT ' + rt);
      rtOpts += '<option value="' + rt + '"' + (curRT === rt ? ' selected' : '') + '>' + label + '</option>';
    });

    const isVerified = p.verified === true;
    const hasTTD = !!(p.fotoTTD && String(p.fotoTTD).trim());

    let buktiTTDHtml = '';
    if (isVerified) {
      buktiTTDHtml =
        '<div class="form-group" id="eTTDGroup" style="background:#ecfdf5;border:1.5px solid #a7f3d0;border-radius:12px;padding:14px">' +
          '<label class="form-label" style="color:#065f46;display:flex;align-items:center;gap:6px">' + ICONS.ttd + ' Bukti Fotokopi KTP yang Ditandatangani</label>' +
          '<div class="foto-box' + (hasTTD ? ' has-foto' : '') + '" id="eTTDBox">' +
            (hasTTD
              ? '<img id="eTTDPreview" class="foto-preview" src="' + esc(p.fotoTTD) + '" alt="">'
              : '<img id="eTTDPreview" class="foto-preview" style="display:none" alt="">'
            ) +
            '<div class="foto-placeholder" id="eTTDPlaceholder"' + (hasTTD ? ' style="display:none"' : '') + '>' +
              '<div class="ico">' + ICONS.ttd + '</div>' +
              'Upload / ganti bukti TTD' +
            '</div>' +
            '<div class="foto-btns">' +
              '<button type="button" class="foto-btn primary" id="eBtnTTDKamera">' + ICONS.camera + 'Kamera</button>' +
              '<button type="button" class="foto-btn" id="eBtnTTDGaleri">' + ICONS.gallery + 'Galeri</button>' +
            '</div>' +
            (hasTTD
              ? '<button type="button" class="foto-hapus" id="eBtnTTDHapus" style="display:flex">' + ICONS.trash + ' Hapus Bukti TTD</button>'
              : '<button type="button" class="foto-hapus" id="eBtnTTDHapus" style="display:none">' + ICONS.trash + ' Hapus Bukti TTD</button>'
            ) +
          '</div>' +
        '</div>';
    }

    $('modalEditContent').innerHTML =
      '<div class="section-title" style="margin-top:0">Edit Data Pendukung</div>' +
      (isVerified
        ? '<div style="background:linear-gradient(135deg,#d1fae5,#a7f3d0);border-left:3px solid #059669;padding:12px 14px;border-radius:10px;margin-bottom:14px;font-size:12px;color:#065f46;font-weight:700;display:flex;align-items:center;gap:8px">' + ICONS.shield + ' Data ini sudah diverifikasi (Suara PASTI)</div>'
        : ''
      ) +
      '<div class="form-group">' +
        '<label class="form-label">Nama Lengkap <span class="req">*</span></label>' +
        '<input type="text" class="form-input" id="eNama" value="' + esc(p.nama) + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">NIK <span class="req">*</span></label>' +
        '<input type="tel" class="form-input" id="eNik" value="' + esc(p.nik) + '" maxlength="16" inputmode="numeric">' +
        '<div class="nik-preview" id="eNikPreview" style="display:block">🔒 NIK tidak boleh sama dengan orang lain</div>' +
      '</div>' +
      dataDiriFieldsHtml('e', p) +
      '<div class="form-row">' +
        '<div class="form-group">' +
          '<label class="form-label">Kampung</label>' +
          '<select class="form-select" id="eKampung">' + kampungOpts + '</select>' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="form-label">RT</label>' +
          '<select class="form-select" id="eRt">' + rtOpts + '</select>' +
        '</div>' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Foto KTP</label>' +
        '<div class="foto-box' + (p.fotoKTP ? ' has-foto' : '') + '" id="eFotoBox">' +
          (p.fotoKTP
            ? '<img id="eFotoPreview" class="foto-preview" src="' + esc(p.fotoKTP) + '" alt="">'
            : '<img id="eFotoPreview" class="foto-preview" style="display:none" alt="">'
          ) +
          '<div class="foto-placeholder" id="eFotoPlaceholder"' + (p.fotoKTP ? ' style="display:none"' : '') + '>' +
            '<div class="ico">' + ICONS.card + '</div>' +
            'Ganti foto KTP atau biarkan tetap' +
          '</div>' +
          '<div class="foto-btns">' +
            '<button type="button" class="foto-btn primary" id="eBtnKamera">' + ICONS.camera + 'Kamera</button>' +
            '<button type="button" class="foto-btn" id="eBtnGaleri">' + ICONS.gallery + 'Galeri</button>' +
          '</div>' +
        '</div>' +
        '<div class="foto-tools" id="eFotoTools">' +
          '<button type="button" id="eBtnFotoEdit">' + ICONS.card + 'Putar / Crop</button>' +
          (p.fotoKTPId
            ? '<button type="button" id="eBtnScanKtp">' + ICONS.search + 'Scan Ulang KTP</button>'
            : ''
          ) +
        '</div>' +
        '<div class="ocr-st" id="eOcrSt" style="display:none"></div>' +
      '</div>' +
      buktiTTDHtml +
      '<div class="confirm-btns">' +
        '<button class="btn btn-outline" id="eCancel" type="button">Batal</button>' +
        '<button class="btn btn-primary" id="eSave" type="button">' + ICONS.save + ' Simpan</button>' +
      '</div>';

    const currentNik = String(p.nik);
    $('eNik').addEventListener('input', e => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 16);
      const nikVal = e.target.value;
      const pv = $('eNikPreview');
      e.target.classList.remove('dup-input', 'ok-input');
      if (nikVal.length < 16) {
        pv.className = 'nik-preview';
        pv.textContent = nikVal.length > 0 ? 'Ketik ' + (16 - nikVal.length) + ' digit lagi...' : '🔒 NIK tidak boleh sama dengan orang lain';
        return;
      }
      const r = parseNIK(nikVal);
      if (!r.valid) {
        pv.className = 'nik-preview error';
        pv.textContent = '⚠️ ' + r.msg;
        return;
      }
      if (nikVal === currentNik) {
        pv.className = 'nik-preview';
        pv.innerHTML = '👤 <b>' + r.jenisKelamin + '</b> • 🎂 ' + r.tglText + ' • 📅 Usia <b>' + r.usia + '</b>';
        return;
      }
      pv.className = 'nik-preview checking';
      pv.innerHTML = '👤 <b>' + r.jenisKelamin + '</b> • 🎂 ' + r.tglText + ' • 📅 Usia <b>' + r.usia + '</b><br>🔍 Mengecek...';
      clearTimeout(state.nikCheckTimer);
      state.nikCheckTimer = setTimeout(() => {
        google.script.run
          .withSuccessHandler(chk => {
            const pv2 = $('eNikPreview');
            const inp = $('eNik');
            if (!pv2 || !inp) return;
            if (!chk.ok) {
              pv2.className = 'nik-preview error';
              pv2.textContent = '⚠️ ' + chk.message;
              return;
            }
            if (chk.tersedia) {
              inp.classList.add('ok-input');
              pv2.className = 'nik-preview';
              pv2.innerHTML = '✅ NIK tersedia • 👤 <b>' + r.jenisKelamin + '</b> • 📅 Usia <b>' + r.usia + '</b>';
            } else {
              inp.classList.add('dup-input');
              pv2.className = 'nik-preview dup';
              pv2.innerHTML = '❌ <b>NIK SUDAH DIPAKAI!</b><br>👤 ' + esc(chk.duplikat[0].nama) + ' • ' + esc(chk.duplikat[0].kampung) + ' ' + rtLabel(chk.duplikat[0].rt);
            }
          })
          .withFailureHandler(err => {
            const pv2 = $('eNikPreview');
            if (pv2) {
              pv2.className = 'nik-preview error';
              pv2.textContent = '⚠️ Gagal cek NIK';
            }
          })
          .apiCheckNik({ nik: nikVal, excludeId: p.id });
      }, 300);
    });

    // Sama dengan halaman Input: kamera berbingkai KTP + editor putar/crop fleksibel
    state.editFotoSrc = null;
    $('eBtnKamera').addEventListener('click', () => openKtpCamera('edit'));
    $('eBtnGaleri').addEventListener('click', () => $('editGalleryInput').click());
    $('editCameraInput').onchange = e => handleGalleryFileForCrop(e, 'edit');
    $('editGalleryInput').onchange = e => handleGalleryFileForCrop(e, 'edit');
    $('eBtnFotoEdit').addEventListener('click', () => {
      if (state.editFotoSrc) openCropModal(state.editFotoSrc, 'edit');
      else if (p.fotoKTP) openCropFromUrl(p.fotoKTP);
    });

    // Tombol "Scan Ulang KTP" — ambil foto dari server, OCR, isi kolom kosong
    const btnScanKtp = $('eBtnScanKtp');
    if (btnScanKtp && p.fotoKTPId) {
      btnScanKtp.addEventListener('click', () => runKtpOcrEdit(p.fotoKTPId));
    }

    if (isVerified) {
      const btnTTDKamera = $('eBtnTTDKamera');
      const btnTTDGaleri = $('eBtnTTDGaleri');
      const btnTTDHapus = $('eBtnTTDHapus');

      if (btnTTDKamera) btnTTDKamera.addEventListener('click', () => $('editTTDCameraInput').click());
      if (btnTTDGaleri) btnTTDGaleri.addEventListener('click', () => $('editTTDGalleryInput').click());
      $('editTTDCameraInput').onchange = handleEditTTDInput;
      $('editTTDGalleryInput').onchange = handleEditTTDInput;

      if (btnTTDHapus) {
        btnTTDHapus.addEventListener('click', () => {
          state.editHapusTTD = true;
          state.editFotoTTDBase64 = null;
          state.editFotoTTDMime = null;
          $('eTTDPreview').style.display = 'none';
          $('eTTDPreview').src = '';
          $('eTTDPlaceholder').style.display = 'block';
          $('eTTDBox').classList.remove('has-foto');
          btnTTDHapus.style.display = 'none';
          toast('Bukti TTD akan dihapus saat simpan', 'warn');
        });
      }
    }

    $('eCancel').addEventListener('click', () => {
      $('modalEdit').classList.remove('show');
      state.editId = null;
      state.fotoBase64 = null;
      state.fotoMime = null;
      state.editFotoTTDBase64 = null;
      state.editFotoTTDMime = null;
      state.editHapusTTD = false;
      setEditOcrStatus(null, '');
    });

    $('eSave').addEventListener('click', saveEdit);

    $('modalEdit').classList.add('show');
  }

  function handleEditTTDInput(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast('Foto maksimal 8 MB', 'error');
      e.target.value = '';
      return;
    }
    compressImage(file, (base64, mime) => {
      if (!base64) {
        toast('Gagal memproses foto', 'error');
        e.target.value = '';
        return;
      }
      state.editFotoTTDBase64 = base64;
      state.editFotoTTDMime = mime;
      state.editHapusTTD = false;
      const pv = $('eTTDPreview');
      if (pv) {
        pv.src = base64;
        pv.style.display = 'block';
        $('eTTDPlaceholder').style.display = 'none';
        $('eTTDBox').classList.add('has-foto');
        const btnHapus = $('eBtnTTDHapus');
        if (btnHapus) btnHapus.style.display = 'flex';
      }
      e.target.value = '';
    });
  }

  function saveEdit() {
    const id = state.editId;
    const nama = $('eNama').value.trim();
    const nik = $('eNik').value.trim();
    const kampung = $('eKampung').value;
    const rt = normRT($('eRt').value);
    if (!nama || !/^\d{16}$/.test(nik)) {
      toast('Periksa nama & NIK', 'error');
      return;
    }

    const btn = $('eSave');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;margin:0;border-color:rgba(255,255,255,.4);border-top-color:#fff"></div>';

    const payload = Object.assign({
      id, nama, nik, kampung, rt,
      fotoBase64: state.fotoBase64,
      fotoMime: state.fotoMime
    }, readDataDiriFields('e'));

    if (state.editFotoTTDBase64) {
      payload.fotoTTDBase64 = state.editFotoTTDBase64;
      payload.fotoTTDMime = state.editFotoTTDMime;
    }

    google.script.run
      .withSuccessHandler(r => {
        btn.disabled = false;
        btn.innerHTML = ICONS.save + ' Simpan';
        if (r.ok) {
          toast('✅ ' + r.message, 'success');
          $('modalEdit').classList.remove('show');
          state.editId = null;
          state.fotoBase64 = null;
          state.fotoMime = null;
          state.editFotoTTDBase64 = null;
          state.editFotoTTDMime = null;
          state.editHapusTTD = false;
          setEditOcrStatus(null, '');
          if (r.version) state.version = r.version;
          state.prevIds = {};
          state.dashboardCache = null;
          fetchAndReplace(false);
        } else {
          if (r.duplikat && r.duplikat.length) showDupWarning(r.duplikat);
          else toast('❌ ' + r.message, 'error');
        }
      })
      .withFailureHandler(e => {
        btn.disabled = false;
        btn.innerHTML = ICONS.save + ' Simpan';
        toast('Gagal: ' + e.message, 'error');
      })
      .apiUpdate(payload);
  }

  // ============================================================ //
  // SCAN DUPLIKAT                                                 //
  // ============================================================ //
  $('fabInput').addEventListener('click', () => { if (canOperate()) setPage('input'); });

  $('fabScan').addEventListener('click', () => {
    state.scanResult = null;
    renderScanIntro();
    $('modalScanDup').classList.add('show');
  });

  $('scanCloseBtn').addEventListener('click', () => {
    $('modalScanDup').classList.remove('show');
  });

  function renderScanIntro() {
    const wrap = $('scanResultWrap');
    if (!wrap) return;
    wrap.innerHTML =
      '<div class="scan-intro">' +
        '<div class="scan-intro-ico">🔍</div>' +
        '<h4>Siap Memindai Database</h4>' +
        '<p>Klik tombol di bawah untuk memeriksa apakah ada NIK yang terdaftar lebih dari sekali di seluruh database.</p>' +
        '<button class="scan-start-btn" id="btnScanStart" type="button">' + ICONS.dupScan + ' Mulai Scan Sekarang</button>' +
      '</div>';
    $('btnScanStart').addEventListener('click', () => startScanDup());
  }

  function renderScanLoading() {
    const wrap = $('scanResultWrap');
    if (!wrap) return;
    wrap.innerHTML =
      '<div class="scan-loading">' +
        '<div class="scan-spin"></div>' +
        '<h4>Memindai Database...</h4>' +
        '<p>Mohon tunggu sebentar, memeriksa semua NIK</p>' +
      '</div>';
  }

  function startScanDup() {
    renderScanLoading();
    google.script.run
      .withSuccessHandler(r => {
        if (!r.ok) {
          toast('Gagal scan: ' + r.message, 'error');
          renderScanIntro();
          return;
        }
        state.scanResult = r;
        renderScanResult(r);
        updateFabBadge(r.totalGroup || 0);
      })
      .withFailureHandler(e => {
        toast('Gagal scan: ' + e.message, 'error');
        renderScanIntro();
      })
      .apiScanDuplikat();
  }

  function updateFabBadge(count) {
    const badge = $('fabBadge');
    const fab = $('fabScan');
    if (!badge || !fab) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = 'flex';
      fab.classList.add('pulse');
    } else {
      badge.style.display = 'none';
      fab.classList.remove('pulse');
    }
  }

  function renderScanResult(r) {
    const wrap = $('scanResultWrap');
    if (!wrap) return;

    if (r.totalGroup === 0) {
      wrap.innerHTML =
        '<div class="scan-ok">' +
          '<div class="scan-ok-ico">' + ICONS.check + '</div>' +
          '<h4>Database Bersih! 🎉</h4>' +
          '<p>Tidak ada NIK duplikat. Semua data pendukung sudah unik.</p>' +
          '<div class="scan-ok-stats">' +
            '<div class="st"><div class="n">0</div><div class="l">Duplikat</div></div>' +
            '<div class="st"><div class="n">' + (state.allData ? state.allData.length : 0) + '</div><div class="l">Total NIK</div></div>' +
          '</div>' +
        '</div>';
      return;
    }

    let html =
      '<div class="scan-found-head">' +
        '<div class="ttl">⚠️ Ditemukan Duplikat!</div>' +
        '<div class="big">' + r.totalGroup + '</div>' +
        '<div class="desc">NIK unik yang terdaftar lebih dari 1 kali</div>' +
      '</div>' +
      '<div class="scan-summary-row">' +
        '<div class="scan-summary-item"><div class="n">' + r.totalGroup + '</div><div class="l">Grup NIK</div></div>' +
        '<div class="scan-summary-item"><div class="n">' + r.totalBaris + '</div><div class="l">Total Baris</div></div>' +
      '</div>';

    r.duplikat.forEach(g => {
      html +=
        '<div class="scan-group">' +
          '<div class="scan-group-head">' +
            '<div class="scan-group-nik">' +
              '<span>🔢</span>' +
              '<span>' + esc(g.nik) + '</span>' +
              '<span class="badge">' + g.entries.length + 'x</span>' +
            '</div>' +
          '</div>';
      g.entries.forEach(e => {
        html +=
          '<div class="scan-entry">' +
            '<div class="scan-entry-num">#' + e.rowNum + '</div>' +
            '<div class="scan-entry-info">' +
              '<div class="scan-entry-name">' + esc(e.nama) + '</div>' +
              '<div class="scan-entry-meta">' + esc(e.kampung) + ' • ' + rtLabel(e.rt) + '</div>' +
            '</div>' +
            '<button class="scan-entry-del" data-action="del-dup" data-id="' + esc(e.id) + '" data-nama="' + esc(e.nama) + '" type="button">Hapus</button>' +
          '</div>';
      });
      html += '</div>';
    });

    html +=
      '<div class="scan-actions">' +
        '<button class="scan-btn-rescan" id="btnRescan" type="button">' + ICONS.refresh + ' Scan Ulang</button>' +
        '<button class="scan-btn-done" id="btnScanDone" type="button">' + ICONS.check + ' Selesai</button>' +
      '</div>';

    wrap.innerHTML = html;

    wrap.querySelectorAll('[data-action="del-dup"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const nama = btn.getAttribute('data-nama');
        window.__deleteData(id, nama);
      });
    });

    const btnRescan = $('btnRescan');
    if (btnRescan) btnRescan.addEventListener('click', () => startScanDup());

    const btnDone = $('btnScanDone');
    if (btnDone) btnDone.addEventListener('click', () => {
      $('modalScanDup').classList.remove('show');
    });
  }

  // ============================================================ //
  // HALAMAN PENGATURAN                                            //
  // ============================================================ //
  function renderPengaturan() {
    const c = $('appContent');
    if (!c) return;
    if (!isAdmin()) { c.innerHTML = emptyState('🔒', 'Khusus Super Admin', 'Pengaturan hanya bisa diubah oleh Super Admin.'); return; }
    if (state.offline) { c.innerHTML = emptyState('📴', 'Butuh internet', 'Pengaturan hanya bisa dibuka saat online.'); return; }
    const token = state.pageToken;

    if (state.cfgCache && state.dashboardCache) {
      renderPengaturanUI();
      refreshPengaturanData(token);
      return;
    }
    if (state.cfgCache) {
      renderPengaturanUI();
      refreshPengaturanData(token);
      return;
    }

    c.innerHTML = '<div class="page-loading"><div class="spinner"></div><p>Memuat pengaturan...</p></div>';

    google.script.run
      .withSuccessHandler(cfgR => {
        if (!isStillOn(token, 'pengaturan')) return;
        if (cfgR.ok) applyConfig(cfgR.data);
        google.script.run
          .withSuccessHandler(r => {
            if (!isStillOn(token, 'pengaturan')) return;
            if (r.ok) {
              state.dashboardCache = r.data;
              STATS_PER_KAMPUNG = r.data.perKampung || {};
              STATS_VERIFIED_PER_KAMPUNG = r.data.kampungVerified || {};
              if (r.data.kampungList && !state.cfgCache) applyConfig(r.data);
            }
            renderPengaturanUI();
          })
          .withFailureHandler(() => {
            if (!isStillOn(token, 'pengaturan')) return;
            renderPengaturanUI();
          })
          .apiGetDashboard();
      })
      .withFailureHandler(() => {
        if (!isStillOn(token, 'pengaturan')) return;
        renderPengaturanUI();
      })
      .apiGetConfig();
  }

  function refreshPengaturanData(token) {
    google.script.run
      .withSuccessHandler(cfgR => {
        if (!isStillOn(token, 'pengaturan')) return;
        if (cfgR.ok) applyConfig(cfgR.data);
        google.script.run
          .withSuccessHandler(r => {
            if (!isStillOn(token, 'pengaturan')) return;
            if (r.ok) {
              state.dashboardCache = r.data;
              STATS_PER_KAMPUNG = r.data.perKampung || {};
              STATS_VERIFIED_PER_KAMPUNG = r.data.kampungVerified || {};
              rerenderPengaturanKeep(); // jangan hapus isian yang sedang diketik
            }
          })
          .withFailureHandler(() => {})
          .apiGetDashboard();
      })
      .withFailureHandler(() => {})
      .apiGetConfig();
  }

  function renderPengaturanUI() {
    const c = $('appContent');
    if (!c) return;

    let totalTargetKampung = 0, totalRealisasi = 0, totalVerified = 0;
    KAMPUNG_LIST.forEach(k => {
      totalTargetKampung += parseInt(TARGET_PER_KAMPUNG[k] || 0, 10);
      totalRealisasi += parseInt(STATS_PER_KAMPUNG[k] || 0, 10);
      totalVerified += parseInt(STATS_VERIFIED_PER_KAMPUNG[k] || 0, 10);
    });
    const targetEffective = TARGET_TOTAL > 0 ? TARGET_TOTAL : totalTargetKampung;
    const pctTotal = targetEffective > 0 ? Math.min(100, Math.round((totalRealisasi / targetEffective) * 100)) : 0;

    let kampungCards = '';
    KAMPUNG_LIST.forEach((k, idx) => {
      const target = parseInt(TARGET_PER_KAMPUNG[k] || 0, 10);
      const realisasi = parseInt(STATS_PER_KAMPUNG[k] || 0, 10);
      const verif = parseInt(STATS_VERIFIED_PER_KAMPUNG[k] || 0, 10);
      const pct = target > 0 ? Math.min(100, Math.round((realisasi / target) * 100)) : 0;

      let fillClass = '', pctClass = '';
      if (target > 0) {
        if (pct >= 100) pctClass = 'done';
        else if (pct >= 60) { fillClass = ''; pctClass = ''; }
        else if (pct >= 30) { fillClass = 'warn'; pctClass = 'med'; }
        else { fillClass = 'danger'; pctClass = 'low'; }
      }

      let progressHtml = '';
      if (target > 0) {
        progressHtml =
          '<div class="cfg-kk-progress">' +
            '<div class="cfg-kk-progress-head">' +
              '<span class="val">' + fmtNum(realisasi) + ' <span style="color:var(--muted);font-weight:600">/ ' + fmtNum(target) + '</span></span>' +
              '<span class="pct ' + pctClass + '">' + pct + '%</span>' +
            '</div>' +
            '<div class="cfg-kk-progress-bar">' +
              '<div class="cfg-kk-progress-fill ' + fillClass + '" style="width:' + pct + '%"></div>' +
            '</div>' +
          '</div>';
      } else {
        progressHtml = '<div class="cfg-kk-target-info empty">' + ICONS.info + ' Target belum diset • Realisasi: <b style="color:var(--text)">' + fmtNum(realisasi) + '</b> orang</div>';
      }

      let verifHtml = '';
      if (realisasi > 0) {
        const pctV = Math.round((verif / realisasi) * 100);
        verifHtml = '<div class="cfg-kk-target-info" style="background:#ecfdf5;color:#065f46;margin-top:6px">' + ICONS.shield + ' <b>' + fmtNum(verif) + '</b> pasti (' + pctV + '%)</div>';
      }

      kampungCards +=
        '<div class="cfg-kampung-card">' +
          '<div class="cfg-kk-head">' +
            '<div class="cfg-kk-avatar">' + esc(initialsOf(k)) + '</div>' +
            '<div class="cfg-kk-info">' +
              '<div class="cfg-kk-name">' + esc(k) + '</div>' +
              '<div class="cfg-kk-sub">' + (target > 0 ? 'Target ' + fmtNum(target) + ' suara' : 'Tanpa target khusus') + '</div>' +
            '</div>' +
            '<div class="cfg-kk-actions">' +
              '<button class="cfg-kk-btn edit" data-act="edit-kampung" data-idx="' + idx + '" title="Edit" type="button">' + ICONS.edit + '</button>' +
              '<button class="cfg-kk-btn del" data-act="del-kampung" data-idx="' + idx + '" title="Hapus" type="button">' + ICONS.trash + '</button>' +
            '</div>' +
          '</div>' +
          progressHtml +
          verifHtml +
        '</div>';
    });

    if (KAMPUNG_LIST.length === 0) {
      kampungCards = '<div class="cfg-empty"><div class="ico">🏘️</div><p>Belum ada kampung.<br>Klik tombol di bawah untuk menambahkan.</p></div>';
    }

    c.innerHTML =
      '<div class="cfg-hero">' +
        '<div class="cfg-hero-content">' +
          '<div class="cfg-hero-label">' + ICONS.settings + ' PENGATURAN APLIKASI</div>' +
          '<div class="cfg-hero-title">' + esc(NAMA_PILKADES) + '</div>' +
          '<div class="cfg-hero-cand">Kandidat: ' + esc(NAMA_KANDIDAT) + '</div>' +
        '</div>' +
        '<div class="cfg-hero-stats">' +
          '<div class="cfg-hero-stat"><div class="lbl">Kampung</div><div class="val">' + KAMPUNG_LIST.length + '</div></div>' +
          '<div class="cfg-hero-stat"><div class="lbl">Target Total</div><div class="val">' + fmtNum(targetEffective) + '<span class="unit">suara</span></div></div>' +
          '<div class="cfg-hero-stat"><div class="lbl">Realisasi</div><div class="val">' + fmtNum(totalRealisasi) + '<span class="unit">orang</span></div></div>' +
          '<div class="cfg-hero-stat"><div class="lbl">Pasti</div><div class="val">' + fmtNum(totalVerified) + '<span class="unit">✅</span></div></div>' +
        '</div>' +
      '</div>' +

      '<div class="cfg-section">' +
        '<div class="cfg-section-head">' +
          '<div class="cfg-section-ico">' + ICONS.flag + '</div>' +
          '<div><div class="cfg-section-title">Info Pilkades</div><div class="cfg-section-sub">Nama kegiatan & kandidat</div></div>' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="form-label">Nama Pilkades</label>' +
          '<input type="text" class="form-input" id="cfgNamaPilkades" value="' + esc(NAMA_PILKADES) + '" placeholder="Pilkades Seruni Mumbul 2026">' +
        '</div>' +
        '<div class="form-group" style="margin-bottom:0">' +
          '<label class="form-label">Nama Kandidat</label>' +
          '<input type="text" class="form-input" id="cfgNamaKandidat" value="' + esc(NAMA_KANDIDAT) + '" placeholder="Pak Muhaimin (Pak Emen)">' +
        '</div>' +
        '<div class="cfg-actions"><button class="btn btn-primary" id="btnSaveInfo" type="button">' + ICONS.save + ' Simpan Info Pilkades</button></div>' +
      '</div>' +

      '<div class="cfg-section">' +
        '<div class="cfg-section-head">' +
          '<div class="cfg-section-ico">' + ICONS.target + '</div>' +
          '<div><div class="cfg-section-title">Target Suara</div><div class="cfg-section-sub">Target total & per kampung</div></div>' +
        '</div>' +
        '<div class="form-group" style="margin-bottom:12px">' +
          '<label class="form-label">🎯 Target Total Suara</label>' +
          '<div class="target-input-group">' +
            '<input type="number" id="cfgTargetTotal" value="' + targetEffective + '" min="1" inputmode="numeric" placeholder="500">' +
            '<div class="unit">Suara</div>' +
          '</div>' +
          '<div class="form-hint">Total target untuk menang Pilkades.</div>' +
        '</div>' +
        '<div class="cfg-info">' + ICONS.info + '<div>Total target per kampung: <b>' + fmtNum(totalTargetKampung) + ' suara</b>. Realisasi: <b>' + fmtNum(totalRealisasi) + ' orang</b> (' + fmtNum(totalVerified) + ' pasti).</div></div>' +
        '<div class="cfg-actions"><button class="btn btn-primary" id="btnSaveTarget" type="button">' + ICONS.save + ' Simpan Target Suara</button></div>' +
      '</div>' +

      '<div class="cfg-section">' +
        '<div class="cfg-section-head">' +
          '<div class="cfg-section-ico">' + ICONS.home + '</div>' +
          '<div><div class="cfg-section-title">Daftar Kampung</div><div class="cfg-section-sub">' + KAMPUNG_LIST.length + ' kampung terdaftar</div></div>' +
        '</div>' +
        '<div>' + kampungCards + '</div>' +
        '<button class="cfg-add-btn" id="btnTambahKampung" type="button">' + ICONS.plus + ' Tambah Kampung Baru</button>' +
        '<div class="cfg-info">' + ICONS.info + '<div>Kalau Anda <b>rename</b> kampung, semua data pendukung dengan kampung lama akan otomatis diupdate ke nama baru.</div></div>' +
        (KAMPUNG_DIRTY ? '<div class="cfg-info warn">' + ICONS.warn + '<div>Ada perubahan daftar kampung yang <b>belum disimpan</b>. Klik <b>Simpan Daftar Kampung</b> untuk menerapkan.</div></div>' : '') +
        '<div class="cfg-actions"><button class="btn btn-primary" id="btnSaveKampung" type="button">' + ICONS.save + ' Simpan Daftar Kampung</button></div>' +
      '</div>' +

      '<div class="cfg-section" id="hariHSection">' +
        '<div class="cfg-section-head">' +
          '<div class="cfg-section-ico">' + ICONS.calendar + '</div>' +
          '<div><div class="cfg-section-title">Hari H Pemilihan</div><div class="cfg-section-sub">Tanggal pemilihan untuk hitung mundur di Dashboard</div></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label class="form-label" for="hhJudul">Nama acara</label>' +
            '<input type="text" class="form-input" id="hhJudul" maxlength="80" value="' + esc(HARI_H ? HARI_H.judul : 'Pemilihan Kepala Desa') + '" placeholder="Pemilihan Kepala Desa"></div>' +
          '<div class="form-group"><label class="form-label" for="hhTanggal">Tanggal <span class="req">*</span></label>' +
            '<input type="date" class="form-input" id="hhTanggal" value="' + esc(HARI_H ? HARI_H.tanggal : '') + '"></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-group"><label class="form-label" for="hhJam">Jam <span class="hh-opt">(opsional, ' + HH_LABEL + ')</span></label>' +
            '<input type="time" class="form-input" id="hhJam" value="' + esc(HARI_H ? HARI_H.jam : '') + '"></div>' +
          '<div class="form-group"><label class="form-label" for="hhLokasi">Lokasi <span class="hh-opt">(opsional)</span></label>' +
            '<input type="text" class="form-input" id="hhLokasi" maxlength="120" value="' + esc(HARI_H ? HARI_H.lokasi : '') + '" placeholder="Mis. TPS Balai Desa"></div>' +
        '</div>' +
        '<div class="hh-actions">' +
          '<button class="btn btn-primary" id="btnSaveHariH" type="button">' + ICONS.save + ' Simpan Hari H</button>' +
          (HARI_H ? '<button class="btn btn-outline" id="btnClearHariH" type="button">Hapus Hari H</button>' : '') +
        '</div>' +
      '</div>';

    document.querySelectorAll('[data-act="edit-kampung"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        openEditKampungModal(idx);
      });
    });

    document.querySelectorAll('[data-act="del-kampung"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        deleteKampungDraft(idx);
      });
    });

    const btnTambah = $('btnTambahKampung');
    if (btnTambah) btnTambah.addEventListener('click', () => openEditKampungModal(-1));

    const btnInfo = $('btnSaveInfo'); if (btnInfo) btnInfo.addEventListener('click', saveInfoPilkades);
    const btnTarget = $('btnSaveTarget'); if (btnTarget) btnTarget.addEventListener('click', saveTargetSuara);
    const btnKamp = $('btnSaveKampung'); if (btnKamp) btnKamp.addEventListener('click', saveDaftarKampung);
    const btnHH = $('btnSaveHariH');
    if (btnHH) btnHH.addEventListener('click', () => saveHariH(false));
    const btnHHc = $('btnClearHariH');
    if (btnHHc) btnHHc.addEventListener('click', () => saveHariH(true));
  }

  function saveHariH(clear) {
    const payload = clear
      ? { tanggal: '' }
      : { judul: $('hhJudul').value.trim(), tanggal: $('hhTanggal').value, jam: $('hhJam').value, lokasi: $('hhLokasi').value.trim() };
    if (!clear && !payload.tanggal) { toast('Pilih tanggal Hari H', 'error'); $('hhTanggal').focus(); return; }
    const btn = $(clear ? 'btnClearHariH' : 'btnSaveHariH');
    if (btn) btn.disabled = true;
    google.script.run
      .withSuccessHandler(r => {
        if (btn) btn.disabled = false;
        if (r.ok) {
          HARI_H = r.hariH || null;
          if (state.cfgCache) state.cfgCache.hariH = HARI_H;
          state.dashboardCache = null;
          toast(clear ? '🗑️ Hari H dihapus' : '✅ Hari H tersimpan — tampil di Dashboard', 'success');
          rerenderPengaturanKeep(clear ? ['hhJudul', 'hhTanggal', 'hhJam', 'hhLokasi'] : ['hhJudul', 'hhTanggal', 'hhJam', 'hhLokasi']);
        } else toast('❌ ' + (r.message || 'Gagal menyimpan'), 'error');
      })
      .withFailureHandler(e => { if (btn) btn.disabled = false; toast('Gagal: ' + e.message, 'error'); })
      .apiSaveHariH({ hariH: payload });
  }


  function openEditKampungModal(idx) {
    const isEdit = idx >= 0;
    const oldName = isEdit ? KAMPUNG_LIST[idx] : '';
    const oldTarget = isEdit ? (parseInt(TARGET_PER_KAMPUNG[oldName] || 0, 10)) : 0;
    const realisasi = isEdit ? (parseInt(STATS_PER_KAMPUNG[oldName] || 0, 10)) : 0;
    const verif = isEdit ? (parseInt(STATS_VERIFIED_PER_KAMPUNG[oldName] || 0, 10)) : 0;

    $('modalKampungEditContent').innerHTML =
      '<div class="mk-modal-head">' +
        '<div class="mk-modal-ico">' + (isEdit ? ICONS.edit : ICONS.plus) + '</div>' +
        '<div class="mk-modal-head-txt">' +
          '<h3>' + (isEdit ? 'Edit Kampung' : 'Tambah Kampung Baru') + '</h3>' +
          '<p>' + (isEdit ? 'Ubah nama dan/atau target suara' : 'Isi nama kampung dan target (opsional)') + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Nama Kampung <span class="req">*</span></label>' +
        '<input type="text" class="form-input" id="mkNama" placeholder="Contoh: Sasak" value="' + esc(oldName) + '" autocomplete="off">' +
        (isEdit ? '<div class="form-hint">⚠️ Mengubah nama akan mengupdate semua data terkait</div>' : '') +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">🎯 Target Suara <span style="color:var(--muted);font-weight:400;font-size:11px">(opsional)</span></label>' +
        '<div class="target-input-group">' +
          '<input type="number" id="mkTarget" placeholder="0" value="' + (oldTarget || '') + '" min="0" inputmode="numeric">' +
          '<div class="unit">Suara</div>' +
        '</div>' +
      '</div>' +
      (isEdit && realisasi > 0
        ? '<div class="cfg-info" style="margin-top:0">' + ICONS.info + '<div>Realisasi: <b>' + fmtNum(realisasi) + ' orang</b> (' + fmtNum(verif) + ' sudah pasti)</div></div>'
        : ''
      ) +
      '<div class="confirm-btns" style="margin-top:20px">' +
        '<button class="btn btn-outline" id="mkCancel" type="button">Batal</button>' +
        '<button class="btn btn-primary" id="mkSave" type="button">' + ICONS.save + ' Simpan</button>' +
      '</div>';

    $('mkCancel').addEventListener('click', () => $('modalKampungEdit').classList.remove('show'));

    $('mkSave').addEventListener('click', () => {
      const nama = $('mkNama').value.trim();
      const target = parseInt($('mkTarget').value, 10) || 0;
      if (!nama) { toast('Nama kampung wajib', 'error'); return; }
      for (let i = 0; i < KAMPUNG_LIST.length; i++) {
        if (i !== idx && KAMPUNG_LIST[i].toLowerCase() === nama.toLowerCase()) {
          toast('Nama kampung sudah ada', 'error');
          return;
        }
      }
      if (isEdit) {
        const lama = KAMPUNG_LIST[idx];
        if (lama !== nama) {
          const btn = $('mkSave');
          btn.disabled = true;
          btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;margin:0;border-color:rgba(255,255,255,.4);border-top-color:#fff"></div> Mengubah...';
          google.script.run
            .withSuccessHandler(r => {
              btn.disabled = false;
              btn.innerHTML = ICONS.save + ' Simpan';
              if (r.ok) {
                toast('✅ ' + r.message, 'success');
                KAMPUNG_DIRTY = false;
                applyConfig(r.data);
                KAMPUNG_LIST[idx] = nama;
                if (target > 0) TARGET_PER_KAMPUNG[nama] = target;
                else delete TARGET_PER_KAMPUNG[nama];
                if (STATS_PER_KAMPUNG[lama] !== undefined) {
                  STATS_PER_KAMPUNG[nama] = STATS_PER_KAMPUNG[lama];
                  delete STATS_PER_KAMPUNG[lama];
                }
                if (STATS_VERIFIED_PER_KAMPUNG[lama] !== undefined) {
                  STATS_VERIFIED_PER_KAMPUNG[nama] = STATS_VERIFIED_PER_KAMPUNG[lama];
                  delete STATS_VERIFIED_PER_KAMPUNG[lama];
                }
                $('modalKampungEdit').classList.remove('show');
                state.allData = null;
                state.dashboardCache = null;
                renderPengaturanUI();
                fetchAndReplace(true);
              } else toast('❌ ' + r.message, 'error');
            })
            .withFailureHandler(e => {
              btn.disabled = false;
              btn.innerHTML = ICONS.save + ' Simpan';
              toast('Gagal: ' + e.message, 'error');
            })
            .apiRenameKampung(lama, nama);
          return;
        }
        if (target > 0) TARGET_PER_KAMPUNG[nama] = target;
        else delete TARGET_PER_KAMPUNG[nama];
      } else {
        KAMPUNG_LIST.push(nama);
        if (target > 0) TARGET_PER_KAMPUNG[nama] = target;
      }
      $('modalKampungEdit').classList.remove('show');
      KAMPUNG_DIRTY = true;
      renderPengaturanUI();
      toast('Perubahan belum tersimpan. Klik "Simpan Daftar Kampung" untuk menerapkan.', 'warn');
    });

    $('modalKampungEdit').classList.add('show');
  }

  function deleteKampungDraft(idx) {
    const nama = KAMPUNG_LIST[idx];
    if (!nama) return;
    if (KAMPUNG_LIST.length <= 1) {
      toast('Minimal harus ada 1 kampung', 'error');
      return;
    }
    google.script.run
      .withSuccessHandler(r => {
        const count = r.ok ? r.count : 0;
        let msg = 'Kampung <b>' + esc(nama) + '</b> akan dihapus dari daftar.';
        if (count > 0) msg += '<br><br>⚠️ Ada <b>' + count + '</b> data pendukung dengan kampung ini. Data tidak akan ikut terhapus, tapi tidak akan muncul di filter sampai Anda rename ulang.';
        $('confirmTitle').textContent = 'Hapus Kampung?';
        $('confirmMsg').innerHTML = msg;
        $('confirmYes').textContent = 'Ya, Hapus';
        state.confirmCb = () => {
          closeConfirm();
          KAMPUNG_LIST.splice(idx, 1);
          delete TARGET_PER_KAMPUNG[nama];
          KAMPUNG_DIRTY = true;
          renderPengaturanUI();
          toast('Kampung dihapus dari daftar. Klik "Simpan Daftar Kampung" untuk menerapkan.', 'warn');
        };
        $('modalConfirm').classList.add('show');
      })
      .withFailureHandler(() => {
        state.confirmCb = () => {
          closeConfirm();
          KAMPUNG_LIST.splice(idx, 1);
          delete TARGET_PER_KAMPUNG[nama];
          KAMPUNG_DIRTY = true;
          renderPengaturanUI();
        };
        $('confirmTitle').textContent = 'Hapus Kampung?';
        $('confirmMsg').innerHTML = 'Kampung <b>' + esc(nama) + '</b> akan dihapus dari daftar.';
        $('confirmYes').textContent = 'Ya, Hapus';
        $('modalConfirm').classList.add('show');
      })
      .apiCountKampung(nama);
  }

  // ---------- Simpan pengaturan PER BAGIAN (masing-masing section punya tombol sendiri) ---------- //
  const CFG_INPUT_IDS = ['cfgNamaPilkades', 'cfgNamaKandidat', 'cfgTargetTotal', 'hhJudul', 'hhTanggal', 'hhJam', 'hhLokasi'];

  // Render ulang halaman pengaturan TANPA menghapus isian bagian lain yang sedang diketik
  function rerenderPengaturanKeep(exceptIds) {
    const snap = {};
    CFG_INPUT_IDS.forEach(id => { const el = $(id); if (el) snap[id] = el.value; });
    renderPengaturanUI();
    CFG_INPUT_IDS.forEach(id => {
      const el = $(id);
      if (el && snap[id] !== undefined && (!exceptIds || exceptIds.indexOf(id) === -1)) el.value = snap[id];
    });
  }

  function persistCfgCache() {
    try { sessionStorage.setItem('pendukung_config', JSON.stringify(state.cfgCache || {})); } catch (e) {}
  }

  function saveConfigPart(payload, btnId, label, onOk) {
    const btn = $(btnId);
    const orig = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0;border-color:rgba(255,255,255,.4);border-top-color:#fff"></div> Menyimpan...';
    }
    const restore = () => { if (btn) { btn.disabled = false; btn.innerHTML = orig; } };
    google.script.run
      .withSuccessHandler(r => {
        restore();
        if (!r.ok) { toast('❌ ' + (r.message || 'Gagal menyimpan'), 'error'); return; }
        state.cfgCache = state.cfgCache || {};
        onOk(r.data || {});
        persistCfgCache();
        state.version = '0|empty';
        state.dashboardCache = null;
        toast('✅ ' + label + ' tersimpan', 'success');
      })
      .withFailureHandler(e => { restore(); toast('Gagal: ' + e.message, 'error'); })
      .apiSaveConfig(payload);
  }

  function saveInfoPilkades() {
    const namaPilkades = $('cfgNamaPilkades').value.trim();
    const namaKandidat = $('cfgNamaKandidat').value.trim();
    if (!namaPilkades) { toast('Nama Pilkades wajib diisi', 'error'); $('cfgNamaPilkades').focus(); return; }
    if (!namaKandidat) { toast('Nama Kandidat wajib diisi', 'error'); $('cfgNamaKandidat').focus(); return; }
    saveConfigPart({ namaPilkades, namaKandidat }, 'btnSaveInfo', 'Info Pilkades', d => {
      NAMA_PILKADES = d.namaPilkades || namaPilkades;
      NAMA_KANDIDAT = d.namaKandidat || namaKandidat;
      state.cfgCache.namaPilkades = NAMA_PILKADES;
      state.cfgCache.namaKandidat = NAMA_KANDIDAT;
      const sub = $('loginSub'); if (sub) sub.textContent = NAMA_PILKADES;
      document.title = 'Suara Pendukung — ' + NAMA_KANDIDAT;
      rerenderPengaturanKeep(['cfgNamaPilkades', 'cfgNamaKandidat']);
    });
  }

  function saveTargetSuara() {
    const targetTotal = parseInt($('cfgTargetTotal').value, 10) || 0;
    if (targetTotal <= 0) { toast('Target total harus lebih dari 0', 'error'); $('cfgTargetTotal').focus(); return; }
    saveConfigPart({ targetTotal }, 'btnSaveTarget', 'Target Suara', d => {
      TARGET_TOTAL = d.targetTotal || targetTotal;
      state.cfgCache.targetTotal = TARGET_TOTAL;
      rerenderPengaturanKeep(['cfgTargetTotal']);
    });
  }

  function saveDaftarKampung() {
    if (KAMPUNG_LIST.length === 0) { toast('Minimal 1 kampung', 'error'); return; }
    saveConfigPart({ kampungList: KAMPUNG_LIST.slice(), targetPerKampung: Object.assign({}, TARGET_PER_KAMPUNG) }, 'btnSaveKampung', 'Daftar Kampung', d => {
      KAMPUNG_LIST = (d.kampungList || KAMPUNG_LIST).slice();
      TARGET_PER_KAMPUNG = d.targetPerKampung || TARGET_PER_KAMPUNG;
      state.cfgCache.kampungList = KAMPUNG_LIST.slice();
      state.cfgCache.targetPerKampung = Object.assign({}, TARGET_PER_KAMPUNG);
      KAMPUNG_DIRTY = false;
      fetchAndReplace(true);
      rerenderPengaturanKeep();
    });
  }

  // ============================================================ //
  // UTILITIES                                                     //
  // ============================================================ //
  function emptyState(ico, title, msg) {
    return '<div class="empty-state">' +
      '<div class="big">' + ico + '</div>' +
      '<h3>' + esc(title) + '</h3>' +
      '<p>' + esc(msg || '') + '</p>' +
    '</div>';
  }

  function debounce(fn, ms) {
    let t;
    return function() {
      const a = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(ctx, a), ms);
    };
  }

  document.querySelectorAll('.modal-bg').forEach(m => {
    m.addEventListener('click', e => {
      if (e.target === m) {
        if (m.id === 'modalEdit') {
          state.editId = null;
          state.fotoBase64 = null;
          state.fotoMime = null;
          state.editFotoTTDBase64 = null;
          state.editFotoTTDMime = null;
          state.editHapusTTD = false;
        }
        if (m.id === 'modalDetailWarga') state.detailWargaId = null;
        if (m.id === 'modalVerifTTD') {
          state.verifyId = null;
          state.verifyFotoTTDBase64 = null;
          state.verifyFotoTTDMime = null;
        }
        if (m.id === 'modalCropFoto') { closeCropModal(); return; }
        if (m.id === 'modalBulkKtp') { closeBulkKtp(); return; }
        m.classList.remove('show');
      }
    });
  });

  $('bulkKtpClose').addEventListener('click', closeBulkKtp);

  const modalFotoClose = $('modalFotoClose');
  if (modalFotoClose) {
    modalFotoClose.addEventListener('click', () => {
      $('modalFoto').classList.remove('show');
    });
  }

  // ⭐ Crop Foto KTP — wiring global (modal ada di luar appContent)
  function applyCropRotation() {
    if (!cropperInstance) return;
    const fine = parseFloat($('cropFine').value) || 0;
    cropperInstance.rotateTo(cropRotBase + fine);
    $('cropFineVal').textContent = (fine > 0 ? '+' : '') + fine.toFixed(1).replace(/\.0$/, '') + '°';
  }
  $('cropReset').addEventListener('click', () => {
    if (!cropperInstance) return;
    cropRotBase = 0;
    $('cropFine').value = 0;
    $('cropFineVal').textContent = '0°';
    cropperInstance.reset();
    cropperInstance.rotateTo(0);
  });
  $('cropRotL').addEventListener('click', () => { cropRotBase = (cropRotBase - 90) % 360; applyCropRotation(); });
  $('cropRotR').addEventListener('click', () => { cropRotBase = (cropRotBase + 90) % 360; applyCropRotation(); });
  $('cropFine').addEventListener('input', applyCropRotation);
  $('cropFineZero').addEventListener('click', () => { $('cropFine').value = 0; applyCropRotation(); });
  $('cropZoomIn').addEventListener('click', () => { if (cropperInstance) cropperInstance.zoom(0.15); });
  $('cropZoomOut').addEventListener('click', () => { if (cropperInstance) cropperInstance.zoom(-0.15); });
  $('cropRatioToggle').addEventListener('click', () => {
    if (!cropperInstance) return;
    cropIsFreeRatio = !cropIsFreeRatio;
    cropperInstance.setAspectRatio(cropIsFreeRatio ? NaN : KTP_RATIO);
    $('cropRatioToggle').classList.toggle('active', cropIsFreeRatio);
    $('cropRatioLbl').textContent = cropIsFreeRatio ? 'Rasio Bebas' : 'Rasio KTP';
  });
  $('cropCancelBtn').addEventListener('click', closeCropModal);
  $('cropConfirmBtn').addEventListener('click', () => {
    if (!cropperInstance) return;
    // resolusi tinggi (untuk OCR & disimpan dikecilkan di finalizeFotoKTP); sudut kosong akibat miring diisi putih
    const canvas = cropperInstance.getCroppedCanvas({
      maxWidth: 2000, maxHeight: 2000,
      fillColor: '#ffffff',
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high'
    });
    if (!canvas) { toast('Gagal memproses foto', 'error'); return; }
    const hi = canvas.toDataURL('image/jpeg', 0.92);
    const target = cropTarget;
    closeCropModal();
    if (target === 'edit') setEditFoto(hi); else finalizeFotoKTP(hi, hi);
  });

  // ============================================================ //
  // EKSPOR UNTUK pages.js (halaman admin & profil)                //
  // ============================================================ //
  window.__app = { $, esc, toast, ICONS, emptyState, fmtNum, isAdmin, canOperate, userRole, ROLE_LABEL, setPage, offSave, isOffline: () => !!state.offline, syncNow: () => syncData(true),
    offInfo: () => { const sn = offRead(); const at = Math.max(offOnlineAt(), (sn && sn.savedAt) || 0); return sn && sn.boot ? { at, until: at + OFF_MAX_AGE, count: (sn.boot.list || []).length } : null; }, reloadData: cb => fetchAndReplace(true, cb), state: state };

})();
