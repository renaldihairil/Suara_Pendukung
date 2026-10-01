/* ============================================================
 * fotoaman.js — Tampilan foto KTP/TTD yang TIDAK bisa disimpan
 * lewat menu browser (tekan lama → "Download gambar"/"Simpan").
 *
 *  - Foto digambar ke <canvas> (bukan <img>), jadi browser tidak
 *    menawarkan menu simpan/salin/buka gambar di tab baru.
 *  - Menu konteks, seret (drag) & salin gambar diblokir di aplikasi.
 *
 *  FotoAman.html(url, alt)   → HTML penampung (dipakai di detail)
 *  FotoAman.hydrate(root)    → gambar semua penampung di root
 *  FotoAman.draw(canvas,url) → Promise, gambar satu foto ke canvas
 * ============================================================ */
(function () {
  'use strict';

  const cache = new Map();          // url → Promise<ImageBitmap|HTMLImageElement> (maks 24)

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

  /** Foto versi disamarkan dari server (±28 px) → dibesarkan halus + blur + label */
  function drawBlurred(cv, img) {
    const nw = img.width || img.naturalWidth || 28, nh = img.height || img.naturalHeight || 18;
    const W = 800, H = Math.max(1, Math.round(W * nh / nw));
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    if ('filter' in g) g.filter = 'blur(14px)';
    g.drawImage(img, -30, -30, W + 60, H + 60);                // lebih lebar agar tepi blur tidak pudar
    if ('filter' in g) g.filter = 'none';
    g.fillStyle = 'rgba(15,23,42,.18)'; g.fillRect(0, 0, W, H);
    const fs = Math.round(W / 22);
    g.font = '800 ' + fs + 'px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const t = '🔒 Foto disamarkan', tw = g.measureText(t).width + fs * 1.6;
    g.fillStyle = 'rgba(15,23,42,.72)';
    const bx = (W - tw) / 2, by = H / 2 - fs * 0.95, bh = fs * 1.9, r = bh / 2;
    g.beginPath(); g.moveTo(bx + r, by); g.arcTo(bx + tw, by, bx + tw, by + bh, r); g.arcTo(bx + tw, by + bh, bx, by + bh, r);
    g.arcTo(bx, by + bh, bx, by, r); g.arcTo(bx, by, bx + tw, by, r); g.closePath(); g.fill();
    g.fillStyle = '#fff'; g.fillText(t, W / 2, H / 2 + 1);
    return { g, W, H };
  }

  /** Gambar foto ke canvas (lebar maks. 1600 px) */
  function draw(cv, url) {
    return load(url).then(img => {
      if (/[?&]b=1(&|$)/.test(url)) {                            // akun peran User: versi kabur
        const d = drawBlurred(cv, img);
        cv.setAttribute('data-ready', '1');
        cv.setAttribute('data-blur', '1');
        return cv;
      }
      const nw = img.width || img.naturalWidth, nh = img.height || img.naturalHeight;
      const k = Math.min(1, 1600 / nw);
      const W = Math.max(1, Math.round(nw * k)), H = Math.max(1, Math.round(nh * k));
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0, W, H);
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

  window.FotoAman = { html, hydrate, draw };
})();
