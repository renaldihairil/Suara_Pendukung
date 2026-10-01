/* ============================================================
 * notif.js — Notifikasi "Data baru" & "Suara PASTI"
 *
 * 1) DALAM APLIKASI: memanfaatkan sinkron realtime yang sudah ada
 *    (tanpa permintaan tambahan). Setiap data terbaru dibandingkan
 *    dengan sebelumnya → ID baru = data baru, Belum→PASTI = suara PASTI.
 *    Aksi milik sendiri tidak dinotifikasi. Riwayat 50 terakhir per akun.
 * 2) PUSH: popup ajakan "Aktifkan Notifikasi" muncul SETIAP aplikasi
 *    dibuka selama perangkat ini belum aktif. Satu tombol cukup.
 *    Izin sudah diberikan tapi belum terdaftar (mis. ganti akun) →
 *    didaftarkan otomatis tanpa popup.
 * ============================================================ */
(function () {
  'use strict';
  const A = window.__app || {};
  const $ = id => document.getElementById(id);
  const esc = A.esc || (s => String(s == null ? '' : s));
  const toast = (m, t) => (A.toast ? A.toast(m, t) : null);
  const MAX = 50;

  const me = () => (A.state && A.state.user) || {};
  const key = () => 'pendukung_notif_' + String(me().username || '').toLowerCase();
  function load() { try { return JSON.parse(localStorage.getItem(key()) || '[]'); } catch (e) { return []; } }
  function save(list) { try { localStorage.setItem(key(), JSON.stringify(list.slice(0, MAX))); } catch (e) {} }

  /* ---------------- PUSAT NOTIFIKASI (lonceng) ---------------- */
  function unread() { return load().filter(n => !n.read).length; }
  function renderBadge() {
    const b = $('notifBadge');
    if (!b) return;
    const n = unread();
    b.textContent = n > 99 ? '99+' : String(n);
    b.style.display = n ? 'flex' : 'none';
  }
  function ago(t) {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'baru saja';
    if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
    if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
    return Math.floor(s / 86400) + ' hari lalu';
  }
  function renderPanel() {
    const box = $('notifList');
    if (!box) return;
    const list = load();
    box.innerHTML = list.length ? list.map(n =>
      '<button type="button" class="nt-item' + (n.read ? '' : ' unread') + '" data-pid="' + esc(n.pid) + '">' +
        '<span class="nt-ico nt-' + n.type + '">' + (n.type === 'pasti' ? '✅' : '🆕') + '</span>' +
        '<span class="nt-txt"><b>' + esc(n.title) + '</b><span>' + esc(n.body) + '</span><i>' + esc(ago(n.at)) + '</i></span>' +
      '</button>').join('')
      : '<div class="nt-empty">🔔<br>Belum ada notifikasi.<br><small>Data baru & suara PASTI dari tim akan muncul di sini.</small></div>';
    box.querySelectorAll('[data-pid]').forEach(b => b.addEventListener('click', () => {
      closePanel();
      openDetail(b.getAttribute('data-pid'));
    }));
    const st = $('notifPushState');
    if (st) pushState().then(s => {
      st.innerHTML = s === 'aktif' ? '🔔 Push aktif di perangkat ini'
        : '<button type="button" class="nt-enable" id="ntEnable">Aktifkan notifikasi push</button>';
      const b = $('ntEnable'); if (b) b.onclick = () => { closePanel(); showAjak(true); };
    });
  }
  function openPanel() {
    const p = $('notifPanel');
    if (!p) return;
    renderPanel();
    p.classList.add('show');
    document.body.classList.add('notif-open');
    // dibuka = dibaca
    const list = load(); list.forEach(n => { n.read = true; }); save(list); renderBadge();
  }
  function closePanel() {
    const p = $('notifPanel'); if (p) p.classList.remove('show');
    document.body.classList.remove('notif-open');
  }
  function openDetail(pid) {
    if (!pid) return;
    const has = A.state && (A.state.allData || []).some(x => String(x.id) === String(pid));
    if (has && window.__openDetailWarga) window.__openDetailWarga(pid);
    else toast('Data tidak ditemukan (mungkin sudah dihapus)', 'warn');
  }

  function add(items) {
    if (!items.length) return;
    const list = load();
    items.forEach(it => list.unshift(it));
    save(list);
    renderBadge();
    if ($('notifPanel') && $('notifPanel').classList.contains('show')) renderPanel();
    window.__notifToastAt = Date.now();          // toast notifikasi lebih penting dari "Data diperbarui"
    const baru = items.filter(i => i.type === 'baru').length, pasti = items.length - baru;
    if (items.length === 1) toast((items[0].type === 'pasti' ? '✅ ' : '🆕 ') + items[0].title + ': ' + items[0].body, 'info');
    else toast('🔔 ' + [baru ? baru + ' data baru' : '', pasti ? pasti + ' suara PASTI' : ''].filter(Boolean).join(' • '), 'info');
  }

  const lokasi = p => [p.kampung, p.rt ? 'RT ' + p.rt : ''].filter(Boolean).join(' ');
  const oleh = by => (by && by.n ? ' — oleh ' + by.n + (by.p ? ' (' + by.p + ')' : '') : '');

  /** Dipanggil app.js setiap data baru dari server diterapkan */
  function onData(prev, next) {
    if (!Array.isArray(prev) || !prev.length || !Array.isArray(next)) return;   // muatan pertama: bukan "kejadian"
    const u = String(me().username || '').toLowerCase();
    const old = {};
    prev.forEach(p => { old[p.id] = p; });
    const items = [];
    next.forEach(p => {
      const o = old[p.id];
      if (!o) {
        if (p.inputOleh && String(p.inputOleh.u).toLowerCase() === u) return;     // aksi sendiri
        items.push({ type: 'baru', pid: p.id, at: Date.now(), read: false, title: 'Data baru',
          body: (p.nama || '') + ' • ' + lokasi(p) + oleh(p.inputOleh) });
        if (p.verified !== true) return;
      }
      if (p.verified === true && (!o || o.verified !== true)) {
        if (p.verifOleh && String(p.verifOleh.u).toLowerCase() === u) return;
        items.push({ type: 'pasti', pid: p.id, at: Date.now(), read: false, title: 'Suara PASTI',
          body: (p.nama || '') + ' • ' + lokasi(p) + oleh(p.verifOleh) });
      }
    });
    if (items.length > 40) items.length = 40;                                      // impor massal: cukup ringkas
    add(items);
  }

  /* ---------------- PUSH ---------------- */
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => window.matchMedia && (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true);
  function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }

  function rpc(fn, args) {
    return new Promise((res, rej) => {
      google.script.run.withSuccessHandler(res).withFailureHandler(rej)[fn](args || {});
    });
  }
  function b64ToU8(b64) {
    const pad = '='.repeat((4 - b64.length % 4) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }
  function sameKey(sub, keyU8) {
    try {
      const k = sub.options && sub.options.applicationServerKey;
      if (!k) return true;
      const a = new Uint8Array(k);
      return a.length === keyU8.length && a.every((v, i) => v === keyU8[i]);
    } catch (e) { return true; }
  }
  function perangkat() {
    const ua = navigator.userAgent;
    const os = /Android/.test(ua) ? 'Android' : isIOS ? 'iPhone/iPad' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Lainnya';
    const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    return os + ' • ' + br + (standalone() ? ' (aplikasi)' : '');
  }

  /** 'aktif' | 'izin' (belum diizinkan) | 'ditolak' | 'ios-install' | 'tidak-didukung' */
  let stateMemo = null;
  async function pushState(force) {
    if (stateMemo && !force) return stateMemo;
    if (isIOS && !standalone()) return (stateMemo = 'ios-install');
    if (!pushSupported()) return (stateMemo = 'tidak-didukung');
    if (Notification.permission === 'denied') return (stateMemo = 'ditolak');
    if (Notification.permission !== 'granted') return (stateMemo = 'izin');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const st = await rpc('apiPushStatus', { endpoint: sub.endpoint });
        if (st && st.aktif) return (stateMemo = 'aktif');
      }
      await register(reg);                       // izin sudah ada → daftarkan diam-diam (mis. setelah ganti akun)
      return (stateMemo = 'aktif');
    } catch (e) { return (stateMemo = 'izin'); }
  }

  async function register(reg) {
    reg = reg || await navigator.serviceWorker.ready;
    const k = await rpc('apiPushKey');
    if (!k || !k.publicKey) throw new Error('Kunci notifikasi belum tersedia');
    const keyU8 = b64ToU8(k.publicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, keyU8)) { try { await sub.unsubscribe(); } catch (e) {} sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyU8 });
    const r = await rpc('apiPushSubscribe', { subscription: sub.toJSON ? sub.toJSON() : sub, perangkat: perangkat() });
    if (!r || !r.ok) throw new Error((r && r.message) || 'Gagal mendaftarkan perangkat');
    return { sub, tenang: !!k.tenang };
  }

  async function enable() {
    const btn = $('ajakBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Mengaktifkan…'; }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { stateMemo = perm === 'denied' ? 'ditolak' : 'izin'; renderAjak(stateMemo); return; }
      const reg = await navigator.serviceWorker.ready;
      const r = await register(reg);
      stateMemo = 'aktif';
      closeAjak();
      toast('🔔 Notifikasi aktif di perangkat ini', 'success');
      try {
        await reg.showNotification('Notifikasi aktif ✅', {
          body: 'Anda akan menerima kabar data baru & suara PASTI dari tim.' + (r.tenang ? ' (Saat ini jam tenang 22.00–06.00 WITA.)' : ''),
          icon: '/icons/icon-192.png', badge: '/icons/favicon-32.png', tag: 'sp-aktif'
        });
      } catch (e) { /* abaikan */ }
    } catch (e) {
      toast('Gagal mengaktifkan: ' + (e && e.message ? e.message : e), 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Aktifkan Notifikasi'; }
    }
  }

  function renderAjak(st) {
    const c = $('ajakContent');
    if (!c) return;
    const head = '<div class="ajak-ico">🔔</div><h3>Aktifkan Notifikasi</h3>';
    let body = '';
    if (st === 'ditolak') {
      body = '<p>Notifikasi untuk aplikasi ini <b>sedang diblokir</b> di browser. Izinkan dulu, lalu tekan tombol di bawah:</p>' +
        '<ol class="ajak-steps"><li>Ketuk ikon <b>🔒 / ⓘ</b> di sebelah alamat web (atau ⋮ → <b>Info aplikasi</b> bila sudah di-install)</li>' +
        '<li>Pilih <b>Izin → Notifikasi → Izinkan</b></li><li>Kembali ke sini</li></ol>' +
        '<button type="button" class="btn btn-primary ajak-btn" id="ajakBtn">Saya sudah mengizinkan</button>';
    } else if (st === 'ios-install') {
      body = '<p>Di iPhone/iPad, notifikasi hanya bisa aktif bila aplikasi <b>ditambahkan ke Layar Utama</b>:</p>' +
        '<ol class="ajak-steps"><li>Ketuk tombol <b>Bagikan</b> (kotak dengan panah ke atas) di Safari</li>' +
        '<li>Pilih <b>Tambah ke Layar Utama</b></li><li>Buka aplikasi dari ikon di Layar Utama, lalu aktifkan notifikasi</li></ol>';
    } else {
      body = '<p>Dapatkan kabar langsung saat ada <b>data pendukung baru</b> dan <b>suara PASTI</b> dari tim — walau aplikasi sedang ditutup.</p>' +
        '<ul class="ajak-pts"><li>🆕 Data baru</li><li>✅ Suara PASTI</li><li>🌙 Senyap pukul 22.00–06.00 WITA</li></ul>' +
        '<button type="button" class="btn btn-primary ajak-btn" id="ajakBtn">Aktifkan Notifikasi</button>';
    }
    c.innerHTML = head + body + '<button type="button" class="ajak-later" id="ajakLater">Nanti saja</button>';
    const b = $('ajakBtn');
    if (b) b.onclick = () => (st === 'ditolak' ? pushState(true).then(s => (s === 'aktif' ? (closeAjak(), toast('🔔 Notifikasi aktif', 'success')) : (Notification.permission === 'granted' ? enable() : renderAjak(s)))) : enable());
    $('ajakLater').onclick = closeAjak;
  }
  function showAjak(manual) {
    pushState(true).then(st => {
      if (st === 'aktif') { if (manual) toast('🔔 Notifikasi sudah aktif di perangkat ini', 'success'); return; }
      if (st === 'tidak-didukung') { if (manual) toast('Browser ini belum mendukung notifikasi push', 'warn'); return; }
      renderAjak(st);
      $('modalAjakNotif').classList.add('show');
    });
  }
  function closeAjak() { const m = $('modalAjakNotif'); if (m) m.classList.remove('show'); }

  /** Dipanggil sekali setiap aplikasi dibuka & data awal selesai dimuat */
  let ajakShown = false;
  function onAppReady() {
    renderBadge();
    // dibuka dari notifikasi push → langsung buka detail data
    try {
      const u = new URL(location.href);
      const pid = u.searchParams.get('open');
      if (pid) { history.replaceState(null, '', u.pathname); setTimeout(() => openDetail(pid), 300); }
    } catch (e) {}
    if (ajakShown || window.__suppressNotifPrompt || (A.isOffline && A.isOffline())) return;
    ajakShown = true;                                         // sekali per pembukaan aplikasi
    setTimeout(() => showAjak(false), 1200);
  }

  /** Logout: perangkat ini berhenti menerima push untuk akun yang keluar */
  async function onLogout() {
    try {
      if (!pushSupported()) return;
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) await rpc('apiPushUnsubscribe', { endpoint: sub.endpoint });
    } catch (e) { /* abaikan */ }
  }

  /* ---------------- pesan dari service worker ---------------- */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', e => {
      const d = e.data || {};
      if (d.type === 'open-detail') openDetail(d.id);
      else if (d.type === 'push' && A.syncNow) A.syncNow();          // aplikasi terbuka: sinkron sekarang → notifikasi dalam aplikasi
    });
  }

  // panel & popup dipindah ke tingkat teratas halaman (tidak tertutup kartu/konten mana pun)
  ['notifPanel', 'modalAjakNotif'].forEach(id => { const el = $(id); if (el && el.parentNode !== document.body) document.body.appendChild(el); });

  /* ---------------- tombol lonceng ---------------- */
  document.addEventListener('click', e => {
    if (e.target.closest && e.target.closest('#notifBell')) {
      const p = $('notifPanel');
      if (p && p.classList.contains('show')) closePanel(); else openPanel();
      return;
    }
    const p = $('notifPanel');
    if (p && p.classList.contains('show') && !e.target.closest('#notifPanel')) closePanel();
  });
  const close = $('notifClose'); if (close) close.addEventListener('click', closePanel);
  const clr = $('notifClear'); if (clr) clr.addEventListener('click', () => { save([]); renderPanel(); renderBadge(); });

  window.Notif = { onData, onAppReady, onLogout, showAjak, renderBadge, pushState };
})();
