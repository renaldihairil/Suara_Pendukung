/* ============================================================
 * ktpcam.js — Kamera langsung dengan BINGKAI ukuran KTP
 * (rasio ID-1 85,6 × 53,98 mm) + pengecek kualitas foto.
 *
 *  KtpCapture.supported()                  → kamera langsung tersedia?
 *  KtpCapture.open({ onCapture, onError }) → buka kamera; onCapture(dataUrl)
 *       hanya berisi bagian di DALAM bingkai (sudah terpotong).
 *  KtpCapture.quality(canvasOrImg)         → { ok, brightness, sharp, tips[] }
 *  KtpCapture.RATIO
 * ============================================================ */
(function () {
  'use strict';

  const RATIO = 85.6 / 53.98;
  let modal = null, video = null, frame = null, stage = null, hintEl = null, shutter = null;
  let torchBtn = null, zoomWrap = null, zoomInput = null;
  let stream = null, track = null, timer = null, cb = null, busy = false, torchOn = false;

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);
  }

  /* ---------- Kualitas foto (ringan, di canvas kecil) ---------- */
  function quality(src, region) {
    try {
      const sw = src.videoWidth || src.naturalWidth || src.width;
      const sh = src.videoHeight || src.naturalHeight || src.height;
      const r = region || { x: 0, y: 0, w: sw, h: sh };
      const W = 360, H = Math.max(40, Math.round(W * r.h / r.w));
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      const gray = new Float32Array(W * H);
      let sum = 0, bright = 0;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        gray[p] = v; sum += v; if (v > 245) bright++;
      }
      const brightness = sum / gray.length;
      const glare = bright / gray.length;
      // variansi Laplacian = ukuran ketajaman
      let m = 0, m2 = 0, n = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const p = y * W + x;
          const l = 4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - W] - gray[p + W];
          m += l; m2 += l * l; n++;
        }
      }
      const mean = m / n;
      const sharp = m2 / n - mean * mean;
      const tips = [];
      if (brightness < 70) tips.push('Terlalu gelap — cari tempat lebih terang');
      if (glare > 0.12) tips.push('Ada pantulan/silau — miringkan KTP sedikit');
      if (sharp < 45) tips.push('Kurang tajam — tahan kamera stabil & dekatkan');
      return { ok: tips.length === 0, brightness, sharp, glare, tips };
    } catch (e) {
      return { ok: true, brightness: 0, sharp: 0, glare: 0, tips: [] };
    }
  }

  /* ---------- UI ---------- */
  function build() {
    if (modal) return;
    modal = document.createElement('div');
    modal.className = 'kcam';
    modal.innerHTML =
      '<div class="kcam-top">' +
        '<button type="button" class="kcam-x" id="kcamClose" aria-label="Tutup">✕</button>' +
        '<div class="kcam-title">Foto KTP</div>' +
        '<button type="button" class="kcam-torch" id="kcamTorch" style="display:none" aria-label="Senter">🔦</button>' +
      '</div>' +
      '<div class="kcam-stage" id="kcamStage">' +
        '<video id="kcamVideo" playsinline muted autoplay></video>' +
        '<div class="kcam-frame" id="kcamFrame"><i></i><i></i><i></i><i></i></div>' +
        '<div class="kcam-hint" id="kcamHint">Posisikan KTP tepat di dalam bingkai</div>' +
      '</div>' +
      '<div class="kcam-bottom">' +
        '<div class="kcam-zoom" id="kcamZoomWrap" style="display:none"><span>−</span><input type="range" id="kcamZoom" min="1" max="3" step="0.1" value="1"><span>+</span></div>' +
        '<div class="kcam-tips">Letakkan KTP di permukaan rata • cahaya cukup • hindari silau & buram</div>' +
        '<button type="button" class="kcam-shutter" id="kcamShutter" aria-label="Ambil foto"><span></span></button>' +
      '</div>';
    document.body.appendChild(modal);
    stage = modal.querySelector('#kcamStage');
    video = modal.querySelector('#kcamVideo');
    frame = modal.querySelector('#kcamFrame');
    hintEl = modal.querySelector('#kcamHint');
    shutter = modal.querySelector('#kcamShutter');
    torchBtn = modal.querySelector('#kcamTorch');
    zoomWrap = modal.querySelector('#kcamZoomWrap');
    zoomInput = modal.querySelector('#kcamZoom');
    modal.querySelector('#kcamClose').addEventListener('click', close);
    shutter.addEventListener('click', snap);
    torchBtn.addEventListener('click', toggleTorch);
    zoomInput.addEventListener('input', () => {
      if (track && track.applyConstraints) track.applyConstraints({ advanced: [{ zoom: parseFloat(zoomInput.value) }] }).catch(() => {});
    });
    window.addEventListener('resize', layout);
    window.addEventListener('orientationchange', () => setTimeout(layout, 250));
    document.addEventListener('visibilitychange', () => { if (document.hidden && modal.classList.contains('show')) close(); });
  }

  /** Ukuran bingkai mengikuti rasio KTP; selalu dalam stage */
  function layout() {
    if (!stage || !frame) return;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    if (!sw || !sh) return;
    let fw = Math.min(sw * 0.92, sh * 0.78 * RATIO);
    let fh = fw / RATIO;
    frame.style.width = fw + 'px';
    frame.style.height = fh + 'px';
    frame.style.left = ((sw - fw) / 2) + 'px';
    frame.style.top = ((sh - fh) / 2) + 'px';
  }

  async function open(opts) {
    cb = opts || {};
    build();
    if (!supported()) { if (cb.onError) cb.onError('unsupported'); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
    } catch (e) {
      stream = null;
      if (cb.onError) cb.onError(e && e.name === 'NotAllowedError' ? 'denied' : 'unavailable', e);
      return;
    }
    track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    modal.classList.add('show');
    document.body.classList.add('kcam-open');
    requestAnimationFrame(layout);
    try { await video.play(); } catch (e) { /* autoplay sudah diatur */ }
    setTimeout(layout, 150);

    // kemampuan opsional: senter & zoom
    let caps = {};
    try { caps = (track.getCapabilities && track.getCapabilities()) || {}; } catch (e) { /* abaikan */ }
    torchOn = false;
    torchBtn.classList.remove('on');
    torchBtn.style.display = caps.torch ? '' : 'none';
    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      zoomInput.min = caps.zoom.min; zoomInput.max = Math.min(caps.zoom.max, caps.zoom.min * 4);
      zoomInput.step = caps.zoom.step || 0.1; zoomInput.value = caps.zoom.min;
      zoomWrap.style.display = '';
    } else zoomWrap.style.display = 'none';

    clearInterval(timer);
    timer = setInterval(liveHint, 700);
  }

  function frameRegionInVideo() {
    const vw = video.videoWidth, vh = video.videoHeight;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    if (!vw || !vh) return null;
    const s = Math.max(sw / vw, sh / vh);            // object-fit: cover
    const ox = (vw * s - sw) / 2, oy = (vh * s - sh) / 2;
    const fl = parseFloat(frame.style.left), ft = parseFloat(frame.style.top);
    const fw = parseFloat(frame.style.width), fh = parseFloat(frame.style.height);
    const x = Math.max(0, (fl + ox) / s), y = Math.max(0, (ft + oy) / s);
    const w = Math.min(vw - x, fw / s), h = Math.min(vh - y, fh / s);
    return { x, y, w, h };
  }

  function liveHint() {
    if (!video || !video.videoWidth || busy) return;
    const reg = frameRegionInVideo();
    if (!reg) return;
    const q = quality(video, reg);
    hintEl.textContent = q.ok ? '✓ Siap — tekan tombol untuk memotret' : q.tips[0];
    hintEl.classList.toggle('good', q.ok);
  }

  async function toggleTorch() {
    if (!track) return;
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); torchBtn.classList.toggle('on', torchOn); }
    catch (e) { torchOn = false; torchBtn.style.display = 'none'; }
  }

  function snap() {
    if (busy || !video || !video.videoWidth) return;
    const reg = frameRegionInVideo();
    if (!reg) return;
    busy = true;
    const MAXW = 1800;
    const scale = Math.min(1, MAXW / reg.w);
    const c = document.createElement('canvas');
    c.width = Math.round(reg.w * scale); c.height = Math.round(reg.h * scale);
    c.getContext('2d').drawImage(video, reg.x, reg.y, reg.w, reg.h, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.92);
    const q = quality(c);
    close();
    busy = false;
    if (cb && cb.onCapture) cb.onCapture(dataUrl, q);
  }

  function close() {
    clearInterval(timer); timer = null;
    if (stream) { stream.getTracks().forEach(t => { try { t.stop(); } catch (e) { /* abaikan */ } }); stream = null; track = null; }
    if (video) video.srcObject = null;
    if (modal) modal.classList.remove('show');
    document.body.classList.remove('kcam-open');
    busy = false;
  }

  window.KtpCapture = { supported, open, close, quality, RATIO };
})();
