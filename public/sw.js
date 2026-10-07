/* ============================================================
 * Service Worker — PWA Data Pendukung
 * Strategi:
 *  - App shell & vendor  : cache-first (precache saat install)
 *  - Navigasi (HTML)     : network-first (maks 6 dtk) → fallback cache → offline.html (Mode Offline)
 *  - /api/photo          : cache-first di perangkat (dihapus saat logout)
 *  - /api/* lainnya      : network-only (data selalu fresh)
 * ============================================================ */
const VERSION = 'pendukung-v40';
const PHOTO_CACHE = 'pendukung-foto-v1';   // foto KTP/TTD (id file tak pernah berubah) — dihapus saat logout
const PHOTO_MAX = 400;                      // batas jumlah foto tersimpan di perangkat
const SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/css/style.css',
  '/js/api-shim.js',
  '/js/ktpcam.js',
  '/js/sapaan.js',
  '/js/ttdpad.js',
  '/js/kotaksuara.js',
  '/js/fotoaman.js',
  '/js/app.js',
  '/js/pages.js',
  '/js/notif.js',
  '/js/pwa.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/logo-64.png',
  '/icons/logo-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/vendor/jspdf.umd.min.js',
  '/vendor/jspdf.plugin.autotable.min.js',
  '/js/xlsx-writer.js',
  '/vendor/cropper.min.js',
  '/vendor/cropper.min.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then(async (cache) => {
      // Precache satu per satu — satu file gagal tidak membatalkan semuanya
      await Promise.all(SHELL.map(u =>
        cache.add(new Request(u, { cache: 'reload' })).catch(() => {})
      ));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== VERSION && k !== PHOTO_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // abaikan resource eksternal

  // Foto: cache-first di perangkat (kunci = id file saja, tanda tangan URL berganti mingguan)
  if (url.pathname === '/api/photo' && url.searchParams.get('id') && url.searchParams.get('download') !== '1') {
    event.respondWith(photoFromCache(req, url.searchParams.get('id') + (url.searchParams.get('b') === '1' ? ':b' : '')));
    return;
  }

  // API lain: selalu network (data realtime)
  if (url.pathname.startsWith('/api/')) return;

  // Navigasi halaman: network-first
  if (req.mode === 'navigate') {
    event.respondWith(
      fetchTimeout(req, 6000)                 // sinyal lemah: jangan menunggu lama, langsung pakai salinan
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match('/index.html').then(hit => hit || caches.match('/offline.html'))
            .then(hit => hit || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }))
        )
    );
    return;
  }

  // Aset statis: cache-first, lalu isi ulang di belakang
  event.respondWith(
    caches.match(req).then(hit => {
      if (hit) {
        fetch(req).then(res => {
          if (res && res.ok) caches.open(VERSION).then(c => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => new Response('', { status: 504 }));
    })
  );
});

function fetchTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then(r => { clearTimeout(t); resolve(r); }, e => { clearTimeout(t); reject(e); });
  });
}

async function photoFromCache(req, id) {
  const key = '/__foto/' + encodeURIComponent(id);
  const cache = await caches.open(PHOTO_CACHE);
  const hit = await cache.match(key);
  if (hit) return hit;
  let res;
  try { res = await fetch(req); }
  catch (e) { return new Response('', { status: 504, statusText: 'Offline' }); }   // offline & belum tersimpan
  if (res && res.ok && (res.headers.get('Content-Type') || '').startsWith('image/')) {
    try {
      await cache.put(key, res.clone());
      const keys = await cache.keys();
      for (let i = 0; i < keys.length - PHOTO_MAX; i++) await cache.delete(keys[i]);   // buang yang tertua
    } catch (e) { /* kuota penyimpanan penuh → abaikan */ }
  }
  return res;
}

// Logout: hapus foto tersimpan (privasi di perangkat bersama)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'clear-photos') event.waitUntil(caches.delete(PHOTO_CACHE));
});

/* ============================================================
 * NOTIFIKASI PUSH — "Data baru" & "Suara PASTI"
 *  - Aplikasi sedang terbuka & terlihat → tidak tampil di panel HP;
 *    aplikasi diberi tahu agar langsung sinkron (notifikasi dalam aplikasi).
 *  - Banyak kejadian dalam 2 menit → DIGABUNG jadi satu notifikasi
 *    ("5 data baru oleh Sari, Budi"); hanya yang pertama berbunyi.
 *  - Diketuk → aplikasi dibuka langsung ke detail data.
 * ============================================================ */
const GROUP_MS = 2 * 60 * 1000;
let pushChain = Promise.resolve();          // push yang datang bersamaan diproses berurutan agar penggabungan akurat

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { nama: event.data ? event.data.text() : '' }; }
  event.waitUntil(pushChain = pushChain.catch(() => {}).then(async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const aktif = wins.find(c => c.visibilityState === 'visible' && c.focused);
    if (aktif) { aktif.postMessage({ type: 'push', data: d }); return; }

    const type = d.type === 'pasti' ? 'pasti' : 'baru';
    const tag = 'sp-' + type;
    const lama = (await self.registration.getNotifications({ tag }))[0];
    const ld = lama && lama.data;
    const gabung = ld && ld.start && (Date.now() - ld.start) < GROUP_MS;
    const count = gabung ? (ld.count || 1) + 1 : 1;
    const olehList = gabung ? Array.from(new Set((ld.olehList || []).concat(d.oleh || []))).slice(0, 3) : (d.oleh ? [d.oleh] : []);
    const label = type === 'pasti' ? 'suara PASTI' : 'data baru';
    const title = count > 1
      ? (type === 'pasti' ? '✅ ' : '🆕 ') + count + ' ' + label + (olehList.length ? ' oleh ' + olehList.join(', ') : '')
      : (type === 'pasti' ? '✅ Suara PASTI' : '🆕 Data pendukung baru');
    const body = (count > 1 ? 'Terakhir: ' : '') + (d.nama || '') + (d.lokasi ? ' • ' + d.lokasi : '') +
      (count === 1 && d.oleh ? '\nOleh ' + d.oleh + (d.peran ? ' (' + d.peran + ')' : '') : '');
    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: !gabung,                 // hanya notifikasi pertama dalam satu kelompok yang berbunyi
      icon: '/icons/icon-192.png',
      badge: '/icons/favicon-32.png',
      data: { id: d.id, count, olehList, start: gabung ? ld.start : Date.now(), multi: count > 1 }
    });
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const url = d.id && !d.multi ? '/?open=' + encodeURIComponent(d.id) : '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find(c => new URL(c.url).origin === self.location.origin);
    if (w) {
      await w.focus();
      if (d.id && !d.multi) w.postMessage({ type: 'open-detail', id: d.id });
      else w.postMessage({ type: 'push' });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
