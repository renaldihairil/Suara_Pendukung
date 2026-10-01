/* ============================================================
 * api-shim.js — jembatan kompatibilitas.
 * Frontend lama memanggil google.script.run.withSuccessHandler(cb)
 *   .withFailureHandler(cb).<apiFn>(args)
 * Shim ini menggantikannya dengan fetch() ke /api/rpc tanpa
 * mengubah kode aplikasi. Dimuat SEBELUM app.js.
 * ============================================================ */
(function () {
  'use strict';

  const ENDPOINT = '/api/rpc';

  async function callApi(fnName, args) {
    if (window.__offlineMode) throw new Error('📴 Tidak ada internet — fitur ini butuh koneksi');
    const payload = args && args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
      ? args[0]
      : (args && args.length ? { args } : {});
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(Object.assign({ action: fnName }, payload))
      });
    } catch (e) {
      throw new Error('Tidak bisa terhubung ke server. Periksa koneksi internet.');
    }
    if (res.status === 401) {
      try { sessionStorage.removeItem('pendukung_auth'); } catch (e) {}
      if (!window.__sessionExpiredShown) {
        window.__sessionExpiredShown = true;
        alert('Sesi berakhir. Halaman akan dimuat ulang — silakan login kembali.');
        location.reload();
      }
      throw new Error('Unauthorized');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      throw new Error((data && data.message) ? data.message : ('HTTP ' + res.status));
    }
    return data;
  }

  function makeRunner() {
    const runner = {
      _ok: null,
      _fail: null,
      withSuccessHandler(cb) { this._ok = cb; return this; },
      withFailureHandler(cb) { this._fail = cb; return this; }
    };
    // Properti apa pun (apiGetList, apiAdd, ...) = panggilan RPC
    return new Proxy(runner, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== 'string') return undefined;
        return function (...args) {
          callApi(prop, args).then(
            r => { if (typeof target._ok === 'function') target._ok(r); },
            e => { if (typeof target._fail === 'function') target._fail(e); else console.error('[api]', prop, e); }
          );
          return undefined; // ala google.script.run: hasil lewat callback
        };
      }
    });
  }

  window.google = window.google || {};
  google.script = google.script || {};
  // Setiap akses google.script.run = runner BARU (handler tidak saling tabrakan)
  Object.defineProperty(google.script, 'run', {
    get() { return makeRunner(); },
    configurable: true
  });

  window.__fetchPhotoUrl = function (id) {
    return '/api/photo?id=' + encodeURIComponent(id);
  };
})();
