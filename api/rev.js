'use strict';
/* ============================================================
 * /api/rev — sinyal "ada perubahan data?" untuk sinkron realtime semua perangkat.
 * Mengembalikan sidik jari versi data (hash; tanpa isi data apa pun).
 * Di-cache CDN Vercel ±2 dtk: berapa pun perangkat yang mengecek tiap 4 dtk,
 * Google Sheets dibaca paling banyak ±1x per 2 dtk (aman untuk kuota 60 baca/menit).
 * ============================================================ */
const store = require('../lib/store');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const version = await store.getVersion({ maxAge: 1500 });
    const rev = store.revOf(version);
    res.statusCode = 200;
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');       // browser: selalu tanya CDN
    res.setHeader('Vercel-CDN-Cache-Control', 'max-age=2');                        // CDN Vercel: 2 dtk
    res.setHeader('CDN-Cache-Control', 'max-age=2');
    res.end(JSON.stringify({ ok: true, rev, t: Date.now() }));
  } catch (e) {
    res.statusCode = 503;
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ ok: false }));
  }
};

