/* ============================================================
 * notif.js — notifikasi dalam aplikasi + Web Push.
 *  - Lonceng di topbar (badge belum dibaca), panel, halaman Notifikasi
 *  - Polling ringan (20 dtk, hanya saat tab terlihat)
 *  - Berlangganan Web Push (VAPID) per perangkat
 *  - Deep link: /?nav=data&id=<idData> dari klik notifikasi push
 * Bergantung pada window.__app (app.js) dan window.google.script.run.
 * ============================================================ */
(function () {
  'use strict';
  const A = window.__app || {};
  const $ = A.$ || (id => document.getElementById(id));
  const esc = A.esc || (s => String(s == null ? '' : s));
  const toast = A.toast || (() => {});
  const ICONS = A.ICONS || {};
  const state = A.state || {};

  const POLL_MS = 40000; // polling notifikasi (hemat kuota baca Google Sheets)
  const N = {
    items: [],
    unread: 0,
    known: {},          // id → true (untuk mendeteksi notifikasi baru)
    loaded: false,
    timer: null,
    panelOpen: false,
    tab: 'all',         // 'all' | 'unread'  (di halaman)
    push: { ready: false, supported: false, enabled: false, permission: 'default', subscribed: false, busy: false, publicKey: '' },
    started: false
  };

  /* ---------------- util ---------------- */
  const rpc = (fn, params) => new Promise((resolve, reject) => {
    const run = google.script.run.withSuccessHandler(resolve).withFailureHandler(reject);
    run[fn](params || {});
  });

  function timeAgo(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return 'baru saja';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' menit lalu';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' jam lalu';
    const d = Math.round(h / 24);
    if (d < 7) return d + ' hari lalu';
    return new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  const ico = k => ICONS[k] || ICONS.info || '';
  const BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

  // tipe notifikasi → ikon & warna
  const TYPES = {
    data_baru:        ['users', 'green'],
    data_ubah:        ['edit', 'blue'],
    data_hapus:       ['trash', 'red'],
    verifikasi:       ['shield', 'green'],
    batal_verifikasi: ['clock', 'amber'],
    cetak:            ['printer', 'blue'],
    cetak_massal:     ['printer', 'blue'],
    pengaturan:       ['settings', 'slate'],
    kampung:          ['home', 'amber'],
    user_baru:        ['users', 'blue'],
    agenda:           ['calendar', 'blue'],
    agenda_pengingat: ['calendar', 'amber'],
    countdown:        ['calendar', 'green']
  };
  const meta = t => TYPES[t] || ['info', 'slate'];

  /* ---------------- badge ---------------- */
  function updateBadges() {
    const n = N.unread;
    const txt = n > 99 ? '99+' : String(n);
    document.querySelectorAll('.js-notif-badge').forEach(el => {
      el.textContent = txt;
      el.style.display = n > 0 ? 'flex' : 'none';
    });
    const btn = $('notifBtn');
    if (btn) btn.classList.toggle('has-unread', n > 0);
    // judul tab + badge ikon PWA
    const base = document.title.replace(/^\(\d+\+?\)\s*/, '');
    document.title = (n > 0 ? '(' + (n > 99 ? '99+' : n) + ') ' : '') + base;
    try {
      if (navigator.setAppBadge) { if (n > 0) navigator.setAppBadge(n); else navigator.clearAppBadge(); }
    } catch (e) { /* tidak didukung */ }
  }

  /* ---------------- render item ---------------- */
  function itemHtml(n) {
    const m = meta(n.type);
    return '<button type="button" class="nt-item' + (n.read ? '' : ' unread') + '" data-nid="' + esc(n.id) + '">' +
      '<span class="nt-ico tone-' + m[1] + '">' + ico(m[0]) + '</span>' +
      '<span class="nt-body">' +
        '<span class="nt-title">' + esc(n.title) + '</span>' +
        '<span class="nt-msg">' + esc(n.message) + '</span>' +
        '<span class="nt-meta">' + (n.kampung ? '<i class="nt-chip">' + esc(n.kampung) + '</i>' : '') + esc(timeAgo(n.timestamp)) + '</span>' +
      '</span>' +
      (n.read ? '' : '<span class="nt-dot" aria-label="Belum dibaca"></span>') +
    '</button>';
  }

  function emptyHtml(msg) {
    return '<div class="nt-empty"><div class="nt-empty-ico">' + BELL + '</div><b>' + esc(msg || 'Belum ada notifikasi') + '</b>' +
      '<span>Info data baru dan perubahan akan muncul di sini.</span></div>';
  }

  function bindItems(root) {
    root.querySelectorAll('[data-nid]').forEach(el => {
      el.addEventListener('click', () => {
        const n = N.items.find(x => x.id === el.getAttribute('data-nid'));
        if (n) openTarget(n);
      });
    });
  }

  /* ---------------- aksi saat notifikasi diklik ---------------- */
  function whenDataReady(cb, tries) {
    tries = tries || 0;
    if (state.allData) return cb(true);
    if (tries > 40) return cb(false);
    setTimeout(() => whenDataReady(cb, tries + 1), 250);
  }

  function openData(id) {
    A.setPage('data');
    const has = () => (state.allData || []).some(p => String(p.id) === String(id));
    const show = () => { if (window.__openDetailWarga) window.__openDetailWarga(id); };
    whenDataReady(ok => {
      if (ok && has()) return show();
      // data belum ada di cache lokal (mis. baru ditambahkan orang lain) → muat ulang lalu coba lagi
      if (A.reloadData) {
        A.reloadData(() => { if (has()) show(); else toast('Data tidak ditemukan atau sudah dihapus', 'warn'); });
      } else {
        toast('Data tidak ditemukan atau sudah dihapus', 'warn');
      }
    });
  }

  function openTarget(n) {
    closePanel();
    if (n.dataId && n.type !== 'data_hapus') return openData(n.dataId);
    if (n.type === 'user_baru' && A.isAdmin && A.isAdmin()) return A.setPage('users');
    if ((n.type === 'pengaturan' || n.type === 'kampung') && A.isAdmin && A.isAdmin()) return A.setPage('pengaturan');
    if (n.type === 'data_hapus') return A.setPage('data');
    if (n.type === 'agenda' || n.type === 'agenda_pengingat' || n.type === 'countdown') return A.setPage('dashboard');
    if (state.page !== 'notif') A.setPage('notif');
  }

  /* ---------------- ambil data ---------------- */
  async function fetchNotifs(opts) {
    opts = opts || {};
    let r;
    try { r = await rpc('apiNotifList', { limit: 100 }); } catch (e) { return; }
    if (!r || !r.ok) return;
    const fresh = r.items.filter(n => !n.read && !N.known[n.id]);
    r.items.forEach(n => { N.known[n.id] = true; });
    N.items = r.items;
    N.unread = r.unread;
    updateBadges();

    if (N.loaded && fresh.length && !opts.silent) {
      if (!N.panelOpen) {
        toast('🔔 ' + (fresh.length === 1 ? fresh[0].title + ' — ' + fresh[0].message : fresh.length + ' notifikasi baru'), 'success');
      }
    }
    N.loaded = true;
    if (N.panelOpen) renderPanel();
    if (state.page === 'notif' && !opts.skipPage) renderListInPage();
  }

  async function markAllRead(silentUi) {
    if (!N.unread && N.items.every(n => n.read)) return;
    N.items.forEach(n => { n.read = true; });
    N.unread = 0;
    updateBadges();
    try { await rpc('apiNotifMarkRead'); } catch (e) { /* coba lagi pada polling berikutnya */ }
    if (!silentUi) { if (N.panelOpen) renderPanel(); if (state.page === 'notif') renderListInPage(); }
  }

  /* ---------------- panel (popover desktop / sheet mobile) ---------------- */
  function pushBannerHtml() {
    const p = N.push;
    if (!p.enabled || !p.supported || p.subscribed || p.permission === 'denied') return '';
    return '<div class="nt-push-banner"><div class="nt-push-txt"><b>Aktifkan notifikasi push</b><span>Terima info walau aplikasi sedang ditutup.</span></div>' +
      '<button type="button" class="nt-push-btn" id="ntPushEnable"' + (p.busy ? ' disabled' : '') + '>' + (p.busy ? 'Memproses…' : 'Aktifkan') + '</button></div>';
  }

  function renderPanel() {
    const box = $('notifPanel');
    if (!box) return;
    const list = N.items.slice(0, 15);
    box.innerHTML =
      '<div class="nt-head">' +
        '<div class="nt-head-txt"><h3>Notifikasi</h3><span>' + (N.unread ? N.unread + ' belum dibaca' : 'Semua sudah dibaca') + '</span></div>' +
        '<button type="button" class="nt-link" id="ntMarkAll"' + (N.unread ? '' : ' disabled') + '>Tandai dibaca</button>' +
        '<button type="button" class="nt-close" id="ntClose" aria-label="Tutup">' + (ICONS.close || '✕') + '</button>' +
      '</div>' +
      pushBannerHtml() +
      '<div class="nt-list">' + (list.length ? list.map(itemHtml).join('') : emptyHtml()) + '</div>' +
      '<div class="nt-foot"><button type="button" class="nt-link" id="ntAll">Lihat semua notifikasi ' + (ICONS.arrowRight || '→') + '</button></div>';
    bindItems(box);
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('ntClose', closePanel);
    on('ntMarkAll', () => markAllRead());
    on('ntAll', () => { closePanel(); A.setPage('notif'); });
    on('ntPushEnable', () => enablePush());
  }

  function openPanel() {
    N.panelOpen = true;
    renderPanel();
    $('notifPanel').classList.add('show');
    $('notifBackdrop').classList.add('show');
    document.body.classList.add('notif-open');
    fetchNotifs({ silent: true });
  }

  function closePanel() {
    if (!N.panelOpen) return;
    N.panelOpen = false;
    $('notifPanel').classList.remove('show');
    $('notifBackdrop').classList.remove('show');
    document.body.classList.remove('notif-open');
    if (N.unread > 0) markAllRead(true); // membuka panel = sudah melihat
  }

  /* ---------------- halaman Notifikasi ---------------- */
  function pushCardHtml() {
    const p = N.push;
    let body;
    if (!p.ready) {
      body = '<div class="nt-card-note">Memeriksa status notifikasi…</div>';
    } else if (!p.enabled) {
      body = '<div class="nt-card-note">Push belum diaktifkan oleh server. Admin perlu mengisi kunci <code>VAPID_*</code> di pengaturan hosting.</div>';
    } else if (!p.supported) {
      body = '<div class="nt-card-note">Browser ini belum mendukung notifikasi push. Di iPhone: buka lewat Safari → <b>Bagikan</b> → <b>Tambah ke Layar Utama</b>, lalu buka aplikasinya dari layar utama.</div>';
    } else if (p.permission === 'denied') {
      body = '<div class="nt-card-note warn">Izin notifikasi diblokir di browser. Buka pengaturan situs (ikon gembok di address bar) → <b>Notifikasi</b> → <b>Izinkan</b>, lalu muat ulang halaman.</div>';
    } else {
      body =
        '<div class="nt-switch-row">' +
          '<div><b>Notifikasi push di perangkat ini</b><span>' + (p.subscribed ? 'Aktif — Anda akan menerima info walau aplikasi ditutup.' : 'Nonaktif — Anda hanya melihat notifikasi saat membuka aplikasi.') + '</span></div>' +
          '<button type="button" class="nt-switch' + (p.subscribed ? ' on' : '') + '" id="ntPushToggle" role="switch" aria-checked="' + p.subscribed + '"' + (p.busy ? ' disabled' : '') + '><i></i></button>' +
        '</div>' +
        (p.subscribed ? '<button type="button" class="nt-link-btn" id="ntPushTest">Kirim notifikasi tes</button>' : '');
    }
    return '<section class="card nt-push-card"><div class="card-head"><div class="card-title"><span class="ct-ico">' + BELL + '</span>Notifikasi Push</div></div>' + body + '</section>';
  }

  function listForTab() {
    return N.tab === 'unread' ? N.items.filter(n => !n.read) : N.items;
  }

  function renderListInPage() {
    const box = $('ntPageList');
    if (!box) return;
    const items = listForTab();
    box.innerHTML = items.length ? items.map(itemHtml).join('') : emptyHtml(N.tab === 'unread' ? 'Tidak ada yang belum dibaca' : 'Belum ada notifikasi');
    bindItems(box);
    const cnt = $('ntCountUnread');
    if (cnt) cnt.textContent = N.unread;
  }

  function renderPage() {
    const c = $('appContent');
    if (!c) return;
    const token = state.pageToken;
    const head = '<div class="page-head"><div class="ph-txt"><h1 class="ph-title">Notifikasi</h1><p class="ph-sub">Informasi penambahan dan perubahan data terbaru di aplikasi.</p></div>' +
      '<div class="ph-right"><button type="button" class="btn-tool" id="ntPageMarkAll">' + (ICONS.check || '') + ' Tandai semua dibaca</button></div></div>';
    c.innerHTML = head +
      '<div id="ntPushWrap">' + pushCardHtml() + '</div>' +
      '<section class="card nt-page-card">' +
        '<div class="nt-tabs"><button type="button" class="nt-tab' + (N.tab === 'all' ? ' active' : '') + '" data-tab="all">Semua</button>' +
        '<button type="button" class="nt-tab' + (N.tab === 'unread' ? ' active' : '') + '" data-tab="unread">Belum dibaca <span class="count" id="ntCountUnread">' + N.unread + '</span></button></div>' +
        '<div class="nt-list page" id="ntPageList"></div>' +
      '</section>';
    renderListInPage();
    bindPage(c);
    bindPush($('ntPushWrap'));
    fetchNotifs({ silent: true, skipPage: false }).then(() => {
      // setelah daftar tampil sebentar, tandai terbaca (sorotan "baru" tetap terlihat pada render ini)
      setTimeout(() => { if (state.page === 'notif' && state.pageToken === token) markAllRead(true); }, 2500);
    });
  }

  function bindPage(c) {
    c.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
      N.tab = b.getAttribute('data-tab');
      c.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === b));
      renderListInPage();
    }));
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('ntPageMarkAll', () => markAllRead());
  }

  function bindPush(root) {
    if (!root) return;
    const toggle = root.querySelector('#ntPushToggle');
    if (toggle) toggle.addEventListener('click', () => (N.push.subscribed ? disablePush() : enablePush()));
    const test = root.querySelector('#ntPushTest');
    if (test) test.addEventListener('click', sendTest);
  }

  // Kartu pengaturan push bisa tampil di halaman Notifikasi dan halaman Profil
  const PUSH_MOUNTS = ['ntPushWrap', 'profilPushCard'];
  function refreshPushUi() {
    PUSH_MOUNTS.forEach(id => {
      const el = $(id);
      if (el) { el.innerHTML = pushCardHtml(); bindPush(el); }
    });
    if (N.panelOpen) renderPanel();
  }
  function mountPushCard(id) {
    if (PUSH_MOUNTS.indexOf(id) === -1) PUSH_MOUNTS.push(id);
    const el = $(id);
    if (el) { el.innerHTML = pushCardHtml(); bindPush(el); }
  }

  /* ---------------- Web Push ---------------- */
  function b64ToU8(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function getRegistration() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      return await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 4000))]);
    } catch (e) { return null; }
  }

  async function detectPush() {
    const p = N.push;
    p.supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    p.permission = p.supported ? Notification.permission : 'unsupported';
    try {
      const cfg = await rpc('apiPushConfig');
      p.enabled = !!(cfg && cfg.enabled);
      p.publicKey = (cfg && cfg.publicKey) || '';
    } catch (e) { p.enabled = false; }
    p.subscribed = false;
    p.ready = true;
    if (p.supported && p.enabled) {
      const reg = await getRegistration();
      if (reg) {
        try {
          const sub = await reg.pushManager.getSubscription();
          if (sub && p.permission === 'granted') {
            p.subscribed = true;
            // upsert ke server: perangkat yang sama bisa dipakai bergantian oleh user lain
            rpc('apiPushSubscribe', { subscription: sub.toJSON() }).catch(() => {});
          } else if (!sub && p.permission === 'granted') {
            await subscribeNow(reg); // izin sudah ada tapi langganan hilang → pulihkan diam-diam
          }
        } catch (e) { /* abaikan */ }
      }
    }
    refreshPushUi();
    schedulePrompt();
  }

  async function subscribeNow(reg) {
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(N.push.publicKey) });
    const r = await rpc('apiPushSubscribe', { subscription: sub.toJSON() });
    if (!r || !r.ok) { try { await sub.unsubscribe(); } catch (e) {} throw new Error((r && r.message) || 'Gagal menyimpan langganan'); }
    N.push.subscribed = true;
  }

  async function enablePush() {
    const p = N.push;
    if (p.busy) return;
    if (!p.supported) { toast('Browser ini belum mendukung notifikasi push', 'warn'); return; }
    p.busy = true; refreshPushUi();
    try {
      const perm = await Notification.requestPermission();
      p.permission = perm;
      if (perm !== 'granted') { toast(perm === 'denied' ? 'Izin notifikasi ditolak' : 'Izin notifikasi belum diberikan', 'warn'); return; }
      const reg = await getRegistration();
      if (!reg) throw new Error('Service worker belum siap, muat ulang lalu coba lagi');
      await subscribeNow(reg);
      toast('🔔 Notifikasi push diaktifkan', 'success');
    } catch (e) {
      toast('Gagal mengaktifkan push: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      p.busy = false; refreshPushUi();
    }
  }

  async function disablePush() {
    const p = N.push;
    if (p.busy) return;
    p.busy = true; refreshPushUi();
    try {
      const reg = await getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await rpc('apiPushUnsubscribe', { endpoint }).catch(() => {});
      }
      p.subscribed = false;
      setPromptRec({ never: true });
      toast('Notifikasi push dinonaktifkan', 'success');
    } catch (e) {
      toast('Gagal menonaktifkan: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      p.busy = false; refreshPushUi();
    }
  }

  async function sendTest() {
    try {
      const r = await rpc('apiPushTest');
      toast(r && r.ok ? '📨 ' + r.message : '❌ ' + ((r && r.message) || 'Gagal'), r && r.ok ? 'success' : 'error');
    } catch (e) { toast('Gagal: ' + e.message, 'error'); }
  }

  // Saat logout: lepas langganan perangkat ini dari akun (agar tidak menerima push user lama)
  async function onLogout() {
    try {
      if (!N.push.supported) return;
      const reg = await getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) await rpc('apiPushUnsubscribe', { endpoint: sub.endpoint });
    } catch (e) { /* abaikan */ }
  }

  /* ---------------- popup ajakan mengaktifkan push ---------------- */
  const PROMPT_KEY = 'pkd_push_prompt_v1';
  const LATER_MS = 3 * 24 * 3600 * 1000; // "Nanti saja" → tanya lagi setelah 3 hari
  const curUser = () => String((state.user && state.user.username) || '').toLowerCase();
  function promptAll() { try { return JSON.parse(localStorage.getItem(PROMPT_KEY) || '{}'); } catch (e) { return {}; } }
  function getPromptRec() { return promptAll()[curUser()] || {}; }
  function setPromptRec(rec) {
    try { const all = promptAll(); all[curUser()] = Object.assign({}, all[curUser()] || {}, rec); localStorage.setItem(PROMPT_KEY, JSON.stringify(all)); } catch (e) { /* mode privat */ }
  }
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

  function closePrompt() {
    const m = $('modalPushPrompt');
    if (m) m.classList.remove('show');
  }

  function showPrompt(kind) {
    let m = $('modalPushPrompt');
    if (!m) { m = document.createElement('div'); m.className = 'modal-bg'; m.id = 'modalPushPrompt'; document.body.appendChild(m); }
    const art = '<div class="pp-art"><span class="pp-ring r1"></span><span class="pp-ring r2"></span><div class="pp-bell">' + BELL + '</div></div>';
    if (kind === 'ios') {
      m.innerHTML = '<div class="modal-box push-prompt">' + art +
        '<h3>Pasang aplikasi dulu</h3>' +
        '<p>Di iPhone/iPad, notifikasi hanya bisa aktif jika aplikasi dipasang ke layar utama.</p>' +
        '<ol class="pp-steps"><li>Ketuk tombol <b>Bagikan</b> <span class="pp-share">⎙</span> di Safari</li><li>Pilih <b>Tambah ke Layar Utama</b></li><li>Buka aplikasi dari layar utama, lalu aktifkan notifikasi di menu <b>Akun</b></li></ol>' +
        '<button class="btn btn-primary" id="ppOk" type="button">Mengerti</button>' +
        '<button class="pp-never" id="ppNever" type="button">Jangan tampilkan lagi</button></div>';
    } else {
      m.innerHTML = '<div class="modal-box push-prompt">' + art +
        '<h3>Aktifkan notifikasi?</h3>' +
        '<p>Dapatkan info langsung di perangkat ini saat ada perubahan data — walau aplikasi sedang ditutup.</p>' +
        '<ul class="pp-list"><li><i>✓</i>Data baru ditambahkan, lengkap dengan nama &amp; kampung</li><li><i>✓</i>Verifikasi suara dan status cetak KTP</li><li><i>✓</i>Bisa dimatikan kapan saja di menu <b>Akun</b></li></ul>' +
        '<button class="btn btn-primary" id="ppEnable" type="button">Aktifkan Notifikasi</button>' +
        '<button class="pp-later" id="ppLater" type="button">Nanti saja</button>' +
        '<button class="pp-never" id="ppNever" type="button">Jangan tanyakan lagi</button></div>';
    }
    const on = (id, fn) => { const el = m.querySelector('#' + id); if (el) el.addEventListener('click', fn); };
    on('ppEnable', async () => {
      closePrompt();
      await enablePush(); // harus dipanggil dari gestur klik agar izin bisa diminta
      if (N.push.permission !== 'default') setPromptRec({ never: true });
      else setPromptRec({ until: Date.now() + 24 * 3600 * 1000 });
    });
    on('ppLater', () => { setPromptRec({ until: Date.now() + LATER_MS }); closePrompt(); });
    on('ppNever', () => { setPromptRec({ never: true }); closePrompt(); });
    on('ppOk', () => { setPromptRec({ until: Date.now() + 30 * 24 * 3600 * 1000 }); closePrompt(); });
    m.classList.add('show');
  }

  function schedulePrompt(tries) {
    tries = tries || 0;
    const p = N.push;
    if (!p.ready || !p.enabled || !N.started) return;
    const rec = getPromptRec();
    if (rec.never || (rec.until && Date.now() < rec.until)) return;
    let kind = null;
    if (p.supported && p.permission === 'default' && !p.subscribed) kind = 'enable';
    else if (!p.supported && isIOS() && !isStandalone()) kind = 'ios';
    if (!kind) return;
    setTimeout(() => {
      if (!N.started) return;
      // jangan menimpa modal lain; coba lagi sebentar lagi
      if (document.querySelector('.modal-bg.show')) { if (tries < 5) schedulePrompt(tries + 1); return; }
      showPrompt(kind);
    }, tries ? 4000 : 1800);
  }

  /* ---------------- deep link ---------------- */
  function handleUrl(u) {
    let url;
    try { url = new URL(u, location.origin); } catch (e) { return; }
    const nav = url.searchParams.get('nav');
    const id = url.searchParams.get('id');
    if (!nav) return;
    if (nav === 'data' && id) openData(id);
    else if (['dashboard', 'data', 'notif', 'profil', 'input', 'pengaturan', 'users', 'logs'].indexOf(nav) !== -1) A.setPage(nav);
  }

  /* ---------------- start / stop ---------------- */
  function start() {
    if (N.started) return;
    N.started = true;
    N.known = {}; N.loaded = false; N.items = []; N.unread = 0;
    updateBadges();
    if (window.__agenda && window.__agenda.syncZone) window.__agenda.syncZone(); // simpan/ikuti zona waktu perangkat
    fetchNotifs({ silent: true }).then(() => { detectPush(); });
    N.timer = setInterval(() => { if (!document.hidden) fetchNotifs(); }, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    if (location.search.indexOf('nav=') !== -1) {
      handleUrl(location.href);
      try { history.replaceState(null, '', location.pathname); } catch (e) {}
    }
  }

  function stop() {
    N.started = false;
    if (N.timer) { clearInterval(N.timer); N.timer = null; }
    document.removeEventListener('visibilitychange', onVisible);
    N.items = []; N.unread = 0; N.known = {}; N.loaded = false; N.push.ready = false;
    closePrompt();
    updateBadges();
  }

  function onVisible() { if (!document.hidden && N.started) fetchNotifs(); }

  /* ---------------- pemasangan event statis ---------------- */
  function wire() {
    const btn = $('notifBtn');
    if (btn) btn.addEventListener('click', e => { e.stopPropagation(); N.panelOpen ? closePanel() : openPanel(); });
    const bd = $('notifBackdrop');
    if (bd) bd.addEventListener('click', closePanel);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });
    // tutup panel saat pindah halaman lewat menu
    document.querySelectorAll('[data-nav]').forEach(el => el.addEventListener('click', () => closePanel()));
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', ev => {
        if (ev.data && ev.data.type === 'notif-click') { fetchNotifs({ silent: true }); handleUrl(ev.data.url); }
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  window.renderNotif = renderPage;
  window.__notif = { start, stop, onLogout, open: openPanel, close: closePanel, refresh: fetchNotifs, mountPushCard };
})();
