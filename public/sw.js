/* ============================================================
 * Service Worker — PWA Data Pendukung
 * Strategi:
 *  - App shell & vendor  : cache-first (precache saat install)
 *  - Navigasi (HTML)     : network-first → fallback cache → offline.html
 *  - /api/*              : network-only (data selalu fresh; foto no-store)
 * ============================================================ */
const VERSION = 'pendukung-v13';
const SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/css/style.css',
  '/js/api-shim.js',
  '/js/ktpcam.js',
  '/js/app.js',
  '/js/pages.js',
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
      Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // abaikan resource eksternal

  // API & foto: selalu network (data realtime; foto sensitif no-store)
  if (url.pathname.startsWith('/api/')) return;

  // Navigasi halaman: network-first
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
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
