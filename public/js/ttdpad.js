/* ============================================================
 * ttdpad.js — Bidang TANDA TANGAN DIGITAL (jari / stylus / mouse)
 *
 *  const pad = TtdPad.create(hostEl, { onChange })
 *  pad.isEmpty() / pad.isTooShort() / pad.clear() / pad.undo()
 *  pad.setFull(true|false)            → mode layar penuh (lebih leluasa di HP)
 *  pad.toProof(meta) → dataURL JPEG   → lembar bukti: identitas warga, pernyataan,
 *                                       tanda tangan, waktu (WITA) & saksi
 *  pad.destroy()
 *
 * Coretan disimpan dalam koordinat ternormalisasi (0..1) sehingga tetap utuh
 * saat ukuran bidang berubah (putar layar / layar penuh).
 * ============================================================ */
(function () {
  'use strict';

  const INK = '#0b2a6b';

  /** Gambar satu coretan halus (kurva kuadratik lewat titik tengah, tebal mengikuti kecepatan) */
  function drawStroke(g, pts, map, scale) {
    if (!pts.length) return;
    g.strokeStyle = INK;
    g.fillStyle = INK;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (pts.length === 1) {                                   // titik (mis. titik pada huruf i)
      const p = map(pts[0]);
      g.beginPath(); g.arc(p.x, p.y, 1.6 * scale, 0, Math.PI * 2); g.fill();
      return;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = map(pts[i - 1]), b = map(pts[i]);
      const c = i < pts.length - 1 ? map(pts[i + 1]) : b;
      const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const m2 = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
      g.lineWidth = (pts[i].w || 2.4) * scale;
      g.beginPath();
      g.moveTo(i === 1 ? a.x : m1.x, i === 1 ? a.y : m1.y);
      g.quadraticCurveTo(b.x, b.y, m2.x, m2.y);
      g.stroke();
    }
  }

  function create(host, opts) {
    opts = opts || {};
    host.classList.add('ttdpad');
    host.innerHTML =
      '<div class="ttdpad-top">' +
        '<span class="ttdpad-title">✍️ Tanda tangan warga</span>' +
        '<button type="button" class="ttdpad-done">Selesai</button>' +
      '</div>' +
      '<div class="ttdpad-area">' +
        '<canvas></canvas>' +
        '<div class="ttdpad-line"></div>' +
        '<div class="ttdpad-hint">Tanda tangan di sini</div>' +
      '</div>' +
      '<div class="ttdpad-tools">' +
        '<button type="button" data-t="undo" disabled>↶ Urungkan</button>' +
        '<button type="button" data-t="clear" disabled>🗑 Ulangi</button>' +
        '<button type="button" data-t="full">⛶ Layar penuh</button>' +
      '</div>';
    const area = host.querySelector('.ttdpad-area');
    const cv = host.querySelector('canvas');
    const hint = host.querySelector('.ttdpad-hint');
    const g = cv.getContext('2d');
    const strokes = [];
    let cur = null, W = 0, H = 0, dpr = 1, last = null;

    function size() {
      const r = area.getBoundingClientRect();
      if (!r.width || !r.height) return;
      dpr = Math.min(3, window.devicePixelRatio || 1);
      W = r.width; H = r.height;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      redraw();
    }
    function redraw() {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const map = p => ({ x: p.x * W, y: p.y * H });
      const k = Math.max(0.75, Math.min(1.6, Math.min(W, H * 2.2) / 520));   // tebal sebanding ukuran bidang
      strokes.forEach(s => drawStroke(g, s, map, k));
      if (cur) drawStroke(g, cur, map, k);
    }
    function changed() {
      const empty = !strokes.length;
      hint.style.display = empty && !cur ? '' : 'none';
      host.querySelector('[data-t="undo"]').disabled = empty;
      host.querySelector('[data-t="clear"]').disabled = empty;
      if (opts.onChange) opts.onChange(api);
    }
    function pt(e) {
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, t: e.timeStamp || Date.now() };
    }
    function down(e) {
      if (e.button != null && e.button > 0) return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch (x) { /* abaikan */ }
      const p = pt(e); p.w = 2.6;
      cur = [p]; last = p;
      hint.style.display = 'none';
      redraw();
    }
    function move(e) {
      if (!cur) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      (evs.length ? evs : [e]).forEach(ev => {
        const p = pt(ev);
        const dx = (p.x - last.x) * W, dy = (p.y - last.y) * H;
        const dist = Math.hypot(dx, dy);
        if (dist < 0.8) return;
        const v = dist / Math.max(1, p.t - last.t);              // px/ms
        const target = Math.max(1.3, Math.min(3.4, 3.6 - v * 1.1));
        p.w = (last.w || 2.6) * 0.65 + target * 0.35;             // perubahan tebal yang halus
        cur.push(p); last = p;
      });
      redraw();
    }
    function up() {
      if (!cur) return;
      strokes.push(cur); cur = null; last = null;
      redraw(); changed();
    }
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', e => { if (cur && e.pointerType === 'mouse') up(); });
    cv.style.touchAction = 'none';

    host.querySelector('[data-t="undo"]').addEventListener('click', () => { strokes.pop(); redraw(); changed(); });
    host.querySelector('[data-t="clear"]').addEventListener('click', () => { strokes.length = 0; redraw(); changed(); });
    host.querySelector('[data-t="full"]').addEventListener('click', () => setFull(!host.classList.contains('full')));
    host.querySelector('.ttdpad-done').addEventListener('click', () => setFull(false));

    function setFull(on) {
      host.classList.toggle('full', !!on);
      document.body.classList.toggle('ttdpad-full-open', !!on);
      host.querySelector('[data-t="full"]').textContent = on ? '⤡ Perkecil' : '⛶ Layar penuh';
      requestAnimationFrame(size);
    }

    const ro = window.ResizeObserver ? new ResizeObserver(() => size()) : null;
    if (ro) ro.observe(area); else window.addEventListener('resize', size);
    requestAnimationFrame(size);

    /** Panjang total coretan (px pada bidang 600 px) — tolak coretan asal-asalan */
    function inkLength() {
      let L = 0;
      strokes.forEach(s => { for (let i = 1; i < s.length; i++) L += Math.hypot((s[i].x - s[i - 1].x) * 600, (s[i].y - s[i - 1].y) * 260); });
      return L;
    }

    function wrap(ctx, text, maxW) {
      const words = String(text).split(/\s+/), lines = [];
      let line = '';
      words.forEach(w => {
        const t = line ? line + ' ' + w : w;
        if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
      });
      if (line) lines.push(line);
      return lines;
    }

    /**
     * Lembar bukti (JPEG 1200×800): judul, identitas, pernyataan, tanda tangan, waktu & saksi.
     * meta: { nama, nik, kampung, rt, pernyataan, waktu, saksi, aplikasi }
     */
    function toProof(meta) {
      meta = meta || {};
      const PW = 1200, PH = 800, pad = 56;
      const c = document.createElement('canvas');
      c.width = PW; c.height = PH;
      const x = c.getContext('2d');
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, PW, PH);
      // kepala
      x.fillStyle = '#10284f'; x.fillRect(0, 0, PW, 92);
      x.fillStyle = '#ffffff'; x.font = '700 30px Arial, sans-serif'; x.textBaseline = 'middle';
      x.fillText('BUKTI DUKUNGAN — TANDA TANGAN DIGITAL', pad, 46);
      x.font = '600 18px Arial, sans-serif'; x.textAlign = 'right';
      x.fillText(meta.aplikasi || 'Suara Pendukung', PW - pad, 46);
      x.textAlign = 'left'; x.textBaseline = 'alphabetic';
      // identitas
      const rows = [['Nama', meta.nama], ['NIK', meta.nik], ['Alamat', meta.kampung ? meta.kampung + (meta.rt ? ' • ' + meta.rt : '') : '-']];
      let y = 142;
      rows.forEach(([k, v]) => {
        x.fillStyle = '#64748b'; x.font = '600 20px Arial, sans-serif'; x.fillText(k, pad, y);
        x.fillStyle = '#0f172a'; x.font = '700 24px Arial, sans-serif'; x.fillText(': ' + (v || '-'), pad + 110, y);
        y += 38;
      });
      // pernyataan
      y += 6;
      x.fillStyle = '#1e293b'; x.font = 'italic 20px Arial, sans-serif';
      wrap(x, meta.pernyataan || '', PW - pad * 2).forEach(l => { x.fillText(l, pad, y); y += 28; });
      // kotak tanda tangan
      const bx = pad, by = y + 14, bw = PW - pad * 2, bh = PH - by - 120;
      x.strokeStyle = '#cbd5e1'; x.lineWidth = 2; x.setLineDash([10, 8]);
      x.strokeRect(bx, by, bw, bh); x.setLineDash([]);
      // skala coretan agar pas di kotak (jaga perbandingan)
      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      strokes.forEach(s => s.forEach(p => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }));
      const sw = Math.max(0.0001, (maxX - minX) * W), sh = Math.max(0.0001, (maxY - minY) * H);
      const k = Math.min((bw - 60) / sw, (bh - 50) / sh, 3);
      const ox = bx + (bw - sw * k) / 2, oy = by + (bh - sh * k) / 2;
      const map = p => ({ x: ox + (p.x - minX) * W * k, y: oy + (p.y - minY) * H * k });
      strokes.forEach(s => drawStroke(x, s, map, Math.max(1, Math.min(2.4, k))));
      // nama di bawah tanda tangan
      x.fillStyle = '#0f172a'; x.font = '700 22px Arial, sans-serif'; x.textAlign = 'center';
      x.fillText('( ' + (meta.nama || '') + ' )', PW / 2, by + bh + 34);
      // kaki
      x.textAlign = 'left'; x.fillStyle = '#475569'; x.font = '18px Arial, sans-serif';
      x.fillText('Ditandatangani: ' + (meta.waktu || ''), pad, PH - 46);
      if (meta.saksi) x.fillText('Disaksikan oleh: ' + meta.saksi, pad, PH - 20);
      return c.toDataURL('image/jpeg', 0.9);
    }

    const api = {
      isEmpty: () => !strokes.length,
      isTooShort: () => inkLength() < 140,
      clear: () => { strokes.length = 0; redraw(); changed(); },
      undo: () => { strokes.pop(); redraw(); changed(); },
      setFull,
      toProof,
      destroy: () => { if (ro) ro.disconnect(); setFull(false); host.innerHTML = ''; }
    };
    changed();
    return api;
  }

  window.TtdPad = { create };
})();
