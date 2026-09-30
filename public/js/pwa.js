/* ============================================================
 * pwa.js — registrasi service worker & tombol "Install App"
 * ============================================================ */
(function () {
  'use strict';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  let deferredPrompt = null;
  window.__deferredInstallPrompt = null;

  window.__triggerInstall = function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.finally(() => { deferredPrompt = null; window.__deferredInstallPrompt = null; hideBtn(); });
  };

  function hideBtn() {
    const b = document.getElementById('installBtn');
    if (b) b.style.display = 'none';
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    window.__deferredInstallPrompt = e;
    const b = document.getElementById('installBtn');
    if (b) b.style.display = 'flex';
  });

  window.addEventListener('appinstalled', hideBtn);

  // Sudah terpasang sebagai app? Jangan tampilkan tombol.
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) {
    hideBtn();
  }

  const btn = document.getElementById('installBtn');
  if (btn) {
    btn.addEventListener('click', () => window.__triggerInstall());
  }
})();
