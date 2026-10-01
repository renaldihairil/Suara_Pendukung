/* ============================================================
 * fotoaman.js — Tampilan foto KTP/TTD yang TIDAK bisa disimpan
 * lewat menu browser (tekan lama → "Download gambar"/"Simpan").
 *
 *  - Foto digambar ke <canvas> (bukan <img>), jadi browser tidak
 *    menawarkan menu simpan/salin/buka gambar di tab baru.
 *  - Setiap foto diberi tanda air (watermark) nama & waktu
 *    orang yang melihat → bila difoto layar, sumbernya tetap terlacak.
 *  - Menu konteks, seret (drag) & salin gambar diblokir di aplikasi.
 *
 *  FotoAman.html(url, alt)   → HTML penampung (dipakai di detail)
 *  FotoAman.hydrate(root)    → gambar semua penampung di root
 *  FotoAman.draw(canvas,url) → Promise, gambar satu foto ke canvas
 *  FotoAman.setViewer(teks)  → identitas untuk watermark
 * ============================================================ */
(function () {
  'use strict';

  let viewer = '';
  const cache = new Map();          // url → Promise<ImageBitmap|HTMLImageElement> (maks 24)

  function setViewer(t) { viewer = String(t || '').trim(); }

  function load(url) {
    if (cache.has(url)) return cache.get(url);
    const pr = fetch(url, { credentials: 'same-origin' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(b => {
        if (window.createImageBitmap) return createImageBitmap(b);
        return new Promise((res, rej) => {
          const u = URL.createObjectURL(b), im = new Image();
          im.onload = () => { URL.revokeObjectURL(u); res(im); };
          im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('decode')); };
          im.src = u;
        });
      });
    cache.set(url, pr);
    pr.catch(() => cache.delete(url));
    if (cache.size > 24) cache.delete(cache.keys().next().value);
    return pr;
  }

  function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** Watermark miring berulang: "RAHASIA • nama • waktu" */
  function watermark(g, W, H) {
    const text = 'RAHASIA • ' + (viewer || 'Suara Pendukung') + ' • ' + stamp();
    const fs = Math.max(12, Math.round(W / 26));
    g.save();
    g.translate(W / 2, H / 2);
    g.rotate(-Math.PI / 7);
    g.font = '700 ' + fs + 'px Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const tw = g.measureText(text).width + fs * 3;
    const step = fs * 3.4;
    const span = Math.hypot(W, H);
    for (let y = -span / 2; y <= span / 2; y += step) {
      const off = (Math.round(y / step) % 2) * tw / 2;
      for (let x = -span / 2 - tw; x <= span / 2 + tw; x += tw) {
        g.lineWidth = Math.max(1, fs / 9);
        g.strokeStyle = 'rgba(0,0,0,.16)';
        g.strokeText(text, x + off, y);
        g.fillStyle = 'rgba(255,255,255,.34)';
        g.fillText(text, x + off, y);
      }
    }
    g.restore();
  }

  /** Gambar foto ke canvas (lebar maks. 1600 px) + watermark */
  function draw(cv, url) {
    return load(url).then(img => {
      const nw = img.width || img.naturalWidth, nh = img.height || img.naturalHeight;
      const k = Math.min(1, 1600 / nw);
      const W = Math.max(1, Math.round(nw * k)), H = Math.max(1, Math.round(nh * k));
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0, W, H);
      watermark(g, W, H);
      cv.setAttribute('data-ready', '1');
      return cv;
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function html(url, alt) {
    return '<div class="foto-wrap is-loading pf" data-pf="' + esc(url) + '"><span class="foto-spin"></span>' +
      '<canvas class="warga-foto pf-cv" role="img" aria-label="' + esc(alt || 'Foto') + '"></canvas></div>';
  }

  function hydrate(root) {
    (root || document).querySelectorAll('[data-pf]:not([data-pf-done])').forEach(w => {
      w.setAttribute('data-pf-done', '1');
      const cv = w.querySelector('canvas');
      draw(cv, w.getAttribute('data-pf'))
        .then(() => w.classList.remove('is-loading'))
        .catch(() => { w.classList.remove('is-loading'); w.classList.add('is-err'); });
    });
  }

  /* ---- blokir cara menyimpan gambar lewat browser ---- */
  const isMedia = el => el && el.closest && el.closest('img, canvas, .foto-wrap, .modal-foto, .pf');
  document.addEventListener('contextmenu', e => { if (isMedia(e.target)) e.preventDefault(); }, true);
  document.addEventListener('dragstart', e => { if (isMedia(e.target)) e.preventDefault(); }, true);
  document.addEventListener('copy', e => { if (isMedia(e.target) || (document.activeElement && isMedia(document.activeElement))) e.preventDefault(); }, true);

  window.FotoAman = { html, hydrate, draw, setViewer };
})();
