(function () {
  'use strict';
  const button = document.getElementById('fabScan');
  if (!button) return;
  const key = 'pendukung_scan_position_v1';
  let position = null, drag = null, suppressClick = false;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) position = saved;
  } catch (e) {}
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  function bounds() {
    const rect = button.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    let bottom = window.innerHeight;
    const nav = document.querySelector('.bottom-nav');
    if (nav) {
      const n = nav.getBoundingClientRect();
      if (n.width && n.height && n.top > 0) bottom = Math.min(bottom, n.top);
    }
    return { minX: 8, minY: 8, maxX: Math.max(8, window.innerWidth - rect.width - 8),
      maxY: Math.max(8, bottom - rect.height - 8) };
  }
  function place(x, y, b) {
    const left = clamp(x, b.minX, b.maxX), top = clamp(y, b.minY, b.maxY);
    button.style.left = left + 'px'; button.style.top = top + 'px';
    button.style.right = 'auto'; button.style.bottom = 'auto';
    position = { x: (left - b.minX) / (b.maxX - b.minX || 1), y: (top - b.minY) / (b.maxY - b.minY || 1) };
  }
  function restore() {
    if (!position || drag) return;
    const b = bounds(); if (!b) return;
    place(b.minX + position.x * (b.maxX - b.minX), b.minY + position.y * (b.maxY - b.minY), b);
  }
  button.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button !== 0) return;
    suppressClick = false;
    const rect = button.getBoundingClientRect();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false };
    button.setPointerCapture(e.pointerId);
  });
  button.addEventListener('pointermove', e => {
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
    const b = bounds(); if (!b) return;
    drag.moved = true; button.classList.add('dragging');
    place(drag.left + e.clientX - drag.x, drag.top + e.clientY - drag.y, b);
    e.preventDefault();
  });
  function finish(e) {
    if (!drag || drag.id !== e.pointerId) return;
    suppressClick = drag.moved;
    if (drag.moved) { try { localStorage.setItem(key, JSON.stringify(position)); } catch (err) {} }
    drag = null; button.classList.remove('dragging');
    if (button.hasPointerCapture(e.pointerId)) button.releasePointerCapture(e.pointerId);
    restore();
  }
  button.addEventListener('pointerup', finish);
  button.addEventListener('pointercancel', finish);
  button.addEventListener('lostpointercapture', finish);
  button.addEventListener('click', e => {
    if (suppressClick && e.detail !== 0) { e.preventDefault(); e.stopImmediatePropagation(); }
    suppressClick = false;
  }, true);
  window.addEventListener('resize', restore);
  new MutationObserver(restore).observe(button, { attributes: true, attributeFilter: ['class'] });
  button.title = 'Scan Duplikat NIK — seret untuk memindahkan';
  restore();
})();
