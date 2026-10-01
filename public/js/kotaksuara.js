/* ============================================================
 * kotaksuara.js — Animasi "kertas suara masuk kotak suara"
 * untuk proses simpan. Kertas BARU masuk ke kotak setelah server
 * benar-benar membalas berhasil.
 *
 *   const ks = KotakSuara.show({ tone: 'abu' | 'hijau', title, step })
 *   ks.step('Menyimpan data…')                  → ganti teks proses
 *   ks.success({ title, sub }) → Promise         → kertas masuk, centang (±1 dtk), lalu tutup
 *   ks.fail(pesan) → Promise                      → kertas bergoyang merah & kembali, lalu tutup
 *   ks.close()
 *
 *  tone 'abu'   = Data Baru (kotak abu-abu)
 *  tone 'hijau' = Suara PASTI (kotak hijau)
 * ============================================================ */
(function () {
  'use strict';

  const CSS = `
.ks-ov{position:fixed;inset:0;z-index:600;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(10,24,52,.55);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);opacity:0;transition:opacity .2s}
.ks-ov.show{opacity:1}
.ks-card{width:100%;max-width:320px;background:#fff;border-radius:22px;padding:22px 20px 20px;text-align:center;box-shadow:0 24px 60px rgba(10,24,52,.35);transform:translateY(10px) scale(.97);transition:transform .25s}
.ks-ov.show .ks-card{transform:none}
.ks-svg{width:200px;height:200px;display:block;margin:0 auto 6px;overflow:visible}
.ks-title{font-size:17px;font-weight:800;color:#0f172a;line-height:1.3;min-height:22px}
.ks-sub{font-size:13px;color:#64748b;margin-top:5px;line-height:1.45;min-height:19px}
.ks-slow{font-size:12px;color:#b45309;margin-top:8px;display:none}
.ks-ov.slow .ks-slow{display:block}
.ks-ov.ok .ks-slow,.ks-ov.fail .ks-slow{display:none}
.ks-ov.ok .ks-title{color:var(--ks-c)}
.ks-ov.fail .ks-title{color:#dc2626}
.ks-skip{font-size:11px;color:#94a3b8;margin-top:10px;opacity:0;transition:opacity .2s}
.ks-ov.ok .ks-skip{opacity:1}

.ks-paper{transform-box:view-box;transform-origin:120px 50px;animation:ksBob 1.5s ease-in-out infinite}
.ks-ov.ok .ks-paper{animation:ksDrop .5s cubic-bezier(.55,0,.8,.3) forwards}
.ks-ov.fail .ks-paper{animation:ksShake .55s ease both}
.ks-ov.fail .ks-paper-face{fill:#fee2e2;stroke:#dc2626}
.ks-body{transform-box:view-box;transform-origin:120px 216px}
.ks-ov.ok .ks-body{animation:ksBounce .38s .46s ease-out}
.ks-newpile{opacity:0;transition:opacity .2s .5s}
.ks-ov.ok .ks-newpile{opacity:1}
.ks-badge{transform-box:view-box;transform-origin:200px 74px;transform:scale(0)}
.ks-ov.ok .ks-badge{animation:ksPop .32s .56s cubic-bezier(.3,1.6,.6,1) forwards}
.ks-slotglow{opacity:0}
.ks-ov.ok .ks-slotglow{animation:ksGlow .5s .3s ease-out}
.ks-dots i{display:inline-block;width:5px;height:5px;margin:0 2px;border-radius:50%;background:var(--ks-c);opacity:.25;animation:ksDot 1.2s infinite}
.ks-dots i:nth-child(2){animation-delay:.2s}.ks-dots i:nth-child(3){animation-delay:.4s}
.ks-ov.ok .ks-dots,.ks-ov.fail .ks-dots{display:none}
@keyframes ksBob{0%,100%{transform:translateY(-7px) rotate(-2deg)}50%{transform:translateY(-15px) rotate(2deg)}}
@keyframes ksDrop{0%{transform:translateY(-10px)}100%{transform:translateY(96px)}}
@keyframes ksShake{0%,100%{transform:translateY(-9px)}20%{transform:translate(-7px,2px) rotate(-6deg)}40%{transform:translate(7px,2px) rotate(6deg)}60%{transform:translate(-5px,0) rotate(-4deg)}80%{transform:translate(4px,-2px) rotate(3deg)}}
@keyframes ksBounce{0%{transform:scale(1,1)}35%{transform:scale(1.04,.95)}70%{transform:scale(.98,1.03)}100%{transform:scale(1,1)}}
@keyframes ksPop{to{transform:scale(1)}}
@keyframes ksGlow{0%{opacity:.9}100%{opacity:0}}
@keyframes ksDot{0%,100%{opacity:.25}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.ks-paper,.ks-ov.ok .ks-paper,.ks-ov.ok .ks-body,.ks-ov.fail .ks-paper{animation:none}.ks-ov.ok .ks-paper{opacity:0}.ks-ov.ok .ks-badge{animation:none;transform:scale(1)}}
`;

  const TONE = {
    abu:   { c: '#64748b', dark: '#475569', light: '#e2e8f0', glass: 'rgba(100,116,139,.16)', mark: 'person' },
    hijau: { c: '#16a34a', dark: '#15803d', light: '#dcfce7', glass: 'rgba(22,163,74,.15)',   mark: 'check' }
  };

  let seq = 0;
  function svg(t) {
    const id = 'ksClip' + (++seq), sh = 'ksShine' + seq;
    const mark = t.mark === 'check'
      ? '<circle cx="120" cy="58" r="9" fill="' + t.light + '" stroke="' + t.c + '" stroke-width="1.6"/><path d="M115.5 58.2l3.2 3.2 6-6.4" fill="none" stroke="' + t.c + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<circle cx="120" cy="54" r="4.2" fill="' + t.c + '"/><path d="M112.5 66c.8-5 4-7.5 7.5-7.5s6.7 2.5 7.5 7.5" fill="' + t.c + '"/>';
    return '<svg class="ks-svg" viewBox="0 0 240 240" aria-hidden="true">' +
      '<defs><clipPath id="' + id + '"><rect x="0" y="-60" width="240" height="155"/></clipPath>' +
      '<linearGradient id="' + sh + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>' +
      // bayangan lantai
      '<ellipse cx="120" cy="222" rx="92" ry="7" fill="#0f172a" opacity=".08"/>' +
      '<g class="ks-body">' +
        // tumpukan kertas di dalam kotak (terlihat dari dinding transparan)
        '<g opacity=".9">' +
          '<rect x="58" y="192" width="44" height="16" rx="2" fill="#fff" stroke="' + t.light + '" transform="rotate(-8 80 200)"/>' +
          '<rect x="104" y="196" width="46" height="14" rx="2" fill="#fff" stroke="' + t.light + '" transform="rotate(6 127 203)"/>' +
          '<rect x="140" y="190" width="40" height="15" rx="2" fill="#fff" stroke="' + t.light + '" transform="rotate(-4 160 197)"/>' +
          '<rect class="ks-newpile" x="92" y="182" width="52" height="16" rx="2" fill="#fff" stroke="' + t.c + '" stroke-width="1.2" transform="rotate(-3 118 190)"/>' +
        '</g>' +
        // badan kotak transparan
        '<rect x="30" y="104" width="180" height="112" rx="9" fill="' + t.glass + '" stroke="' + t.c + '" stroke-width="2.5"/>' +
        '<path d="M44 112 L92 112 L52 208 L44 208 Z" fill="url(#' + sh + ')" opacity=".7"/>' +
        // tutup (tampak atas) + celah
        '<path d="M50 84 H190 L212 104 H28 Z" fill="' + t.light + '" stroke="' + t.c + '" stroke-width="2.5" stroke-linejoin="round"/>' +
        '<rect x="26" y="102" width="188" height="10" rx="3" fill="' + t.c + '"/>' +
        '<rect x="88" y="91" width="64" height="7" rx="3.5" fill="' + t.dark + '"/>' +
        '<rect class="ks-slotglow" x="84" y="88" width="72" height="13" rx="6.5" fill="#fff"/>' +
        // label
        '<rect x="66" y="138" width="108" height="30" rx="6" fill="' + t.c + '"/>' +
        '<text x="120" y="158" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" font-weight="700" fill="#fff" letter-spacing="1">KOTAK SUARA</text>' +
      '</g>' +
      // kertas suara (terpotong di celah → tampak masuk ke kotak)
      '<g clip-path="url(#' + id + ')"><g class="ks-paper">' +
        '<rect class="ks-paper-face" x="96" y="18" width="48" height="70" rx="3" fill="#fff" stroke="#94a3b8" stroke-width="1.5"/>' +
        '<path d="M96 40 H144" stroke="#e2e8f0" stroke-width="1.2"/>' +
        '<rect x="102" y="24" width="36" height="5" rx="2.5" fill="' + t.c + '" opacity=".85"/>' +
        '<rect x="102" y="32" width="24" height="3" rx="1.5" fill="#cbd5e1"/>' +
        mark +
        '<rect x="104" y="74" width="32" height="3" rx="1.5" fill="#e2e8f0"/>' +
        '<rect x="108" y="80" width="24" height="3" rx="1.5" fill="#e2e8f0"/>' +
      '</g></g>' +
      // lencana centang
      '<g class="ks-badge"><circle cx="200" cy="74" r="17" fill="' + t.c + '"/><circle cx="200" cy="74" r="17" fill="none" stroke="#fff" stroke-width="3"/>' +
        '<path d="M192.5 74.5l5 5 10-10.5" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></g>' +
    '</svg>';
  }

  let styled = false;
  function ensureCss() {
    if (styled) return;
    styled = true;
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function show(opts) {
    opts = opts || {};
    ensureCss();
    const t = TONE[opts.tone] || TONE.abu;
    const ov = document.createElement('div');
    ov.className = 'ks-ov';
    ov.setAttribute('role', 'status');
    ov.setAttribute('aria-live', 'polite');
    ov.style.setProperty('--ks-c', t.c);
    ov.innerHTML = '<div class="ks-card">' + svg(t) +
      '<div class="ks-title"></div>' +
      '<div class="ks-sub"><span class="ks-step"></span> <span class="ks-dots"><i></i><i></i><i></i></span></div>' +
      '<div class="ks-slow">Sinyal lambat, mohon tunggu — jangan tutup aplikasi</div>' +
      '<div class="ks-skip">Ketuk untuk lanjut</div></div>';
    document.body.appendChild(ov);
    const $t = ov.querySelector('.ks-title'), $s = ov.querySelector('.ks-step');
    $t.textContent = opts.title || 'Menyimpan…';
    $s.textContent = opts.step || 'Mohon tunggu';
    requestAnimationFrame(() => ov.classList.add('show'));
    const slowT = setTimeout(() => ov.classList.add('slow'), opts.slowMs || 15000);
    let done = false, closed = false;

    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(slowT);
      ov.classList.remove('show');
      setTimeout(() => ov.remove(), 220);
    }
    function finish(cls, title, sub, ms) {
      if (done) return Promise.resolve();
      done = true;
      clearTimeout(slowT);
      ov.classList.add(cls);
      $t.textContent = title || '';
      $s.textContent = sub || '';
      return new Promise(res => {
        const end = () => { ov.removeEventListener('click', end); close(); res(); };
        const tm = setTimeout(end, ms);
        if (cls === 'ok') ov.addEventListener('click', () => { clearTimeout(tm); end(); });
      });
    }
    return {
      el: ov,
      step: txt => { if (!done) $s.textContent = txt; },
      success: o => finish('ok', (o && o.title) || 'Berhasil disimpan', (o && o.sub) || '', (o && o.ms) || 1150),
      fail: msg => finish('fail', 'Gagal menyimpan', msg || 'Silakan coba lagi', 1500),
      close
    };
  }

  window.KotakSuara = { show };
})();
