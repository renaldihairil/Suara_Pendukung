/* ============================================================
 * pages.js — halaman admin tambahan & profil.
 * Bergantung pada state/$/esc/toast/ICONS dll dari app.js
 * (diekspos lewat window.__app di akhir app.js).
 * ============================================================ */
(function () {
  'use strict';
  const A = window.__app || {};
  const $ = A.$ || (id => document.getElementById(id));
  const esc = A.esc || (s => String(s == null ? '' : s));
  const toast = A.toast || (() => {});
  const ICONS = A.ICONS || {};
  const fmtNum = A.fmtNum || (n => String(n));
  const state = A.state || {}; // state bersama dari app.js
  window.state = state;       // dipakai fungsi global lama (renderUsers dll)

  /* ============================================================ */
  /* KELOLA USER (admin)                                           */
  /* ============================================================ */
  window.renderUsers = function () {
    const c = $('appContent');
    if (!c) return;
    if (!A.isAdmin || !A.isAdmin()) { c.innerHTML = A.emptyState ? A.emptyState('🔒', 'Khusus Admin', '') : 'Khusus admin'; return; }

    if (!state.usersCache) {
      c.innerHTML = '<div class="page-loading"><div class="spinner"></div><p>Memuat user...</p></div>';
      return google.script.run
        .withSuccessHandler(r => {
          if (r.ok) { state.usersCache = r.data; renderUsers(); }
          else c.innerHTML = (A.emptyState ? A.emptyState('⚠️', 'Gagal memuat', r.message) : esc(r.message));
        })
        .withFailureHandler(e => { c.innerHTML = A.emptyState ? A.emptyState('⚠️', 'Gagal memuat', e.message) : esc(e.message); })
        .apiGetUsers();
    }

    const users = state.usersCache;
    let rows = '';
    users.forEach(u => {
      const roleCls = u.role === 'admin' ? 'verified' : 'unverified';
      const roleLbl = u.role === 'admin' ? 'ADMIN' : 'USER';
      const aktif = u.aktif !== false && u.aktif !== 'false';
      rows +=
        '<div class="cfg-kampung-card user-card' + (aktif ? '' : ' user-off') + '">' +
          '<div class="cfg-kk-head">' +
            '<div class="cfg-kk-avatar">' + esc((u.nama || u.username || '?').slice(0, 2).toUpperCase()) + '</div>' +
            '<div class="cfg-kk-info">' +
              '<div class="cfg-kk-name">' + esc(u.nama || u.username) + ' <span class="person-verify-tag ' + roleCls + '" style="margin-left:6px">' + (ICONS.shield || '') + ' ' + roleLbl + '</span></div>' +
              '<div class="cfg-kk-sub">@' + esc(u.username) + ' • Login terakhir: ' + esc(u.lastLogin ? String(u.lastLogin).replace('T', ' ').slice(0, 16) : 'belum pernah') + '</div>' +
            '</div>' +
            '<div class="cfg-kk-actions">' +
              '<button class="cfg-kk-btn edit" data-uact="edit" data-id="' + esc(u.id) + '" title="Edit user" type="button">' + (ICONS.edit || '') + '</button>' +
              '<button class="cfg-kk-btn del" data-uact="reset" data-id="' + esc(u.id) + '" title="Reset password" type="button">🔑</button>' +
              '<button class="cfg-kk-btn del" data-uact="toggle" data-id="' + esc(u.id) + '" title="' + (aktif ? 'Nonaktifkan' : 'Aktifkan') + '" type="button">' + (aktif ? (ICONS.close || '⏸') : (ICONS.check || '▶')) + '</button>' +
            '</div>' +
          '</div>' +
          (!aktif ? '<div class="cfg-kk-target-info" style="background:#fef2f2;color:#991b1b;margin-top:6px">⛔ Akun nonaktif — tidak bisa login</div>' : '') +
        '</div>';
    });

    c.innerHTML =
      '<div class="cfg-hero">' +
        '<div class="cfg-hero-content">' +
          '<div class="cfg-hero-label">' + (ICONS.users || '') + ' ADMIN PANEL</div>' +
          '<div class="cfg-hero-title">Kelola User</div>' +
          '<div class="cfg-hero-cand">Tambah user, atur role, aktif/nonaktif, reset password</div>' +
        '</div>' +
        '<div class="cfg-hero-stats">' +
          '<div class="cfg-hero-stat"><div class="lbl">Total User</div><div class="val">' + users.length + '</div></div>' +
          '<div class="cfg-hero-stat"><div class="lbl">Admin</div><div class="val">' + users.filter(u => u.role === 'admin').length + '</div></div>' +
          '<div class="cfg-hero-stat"><div class="lbl">Aktif</div><div class="val">' + users.filter(u => u.aktif !== false && u.aktif !== 'false').length + '</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="cfg-section">' +
        '<div class="cfg-section-head">' +
          '<div class="cfg-section-ico">' + (ICONS.users || '') + '</div>' +
          '<div><div class="cfg-section-title">Daftar User</div><div class="cfg-section-sub">' + users.length + ' akun terdaftar</div></div>' +
          '<button class="cfg-kk-btn edit" id="btnUserAdd" title="Tambah user" type="button" style="width:auto;padding:0 12px;height:36px;border-radius:10px">' + (ICONS.plus || '+') + ' Tambah</button>' +
        '</div>' +
        '<div>' + rows + '</div>' +
        '<div class="cfg-info">' + (ICONS.info || '') + '<div>User role <b>User</b> hanya bisa melihat dashboard & data (termasuk foto). Hanya admin yang bisa input/ubah/hapus.</div></div>' +
      '</div>';

    const btnAdd = $('btnUserAdd');
    if (btnAdd) btnAdd.addEventListener('click', () => openUserModal(null));

    c.querySelectorAll('[data-uact]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.getAttribute('data-uact');
        const id = btn.getAttribute('data-id');
        const u = users.find(x => x.id === id);
        if (!u) return;
        if (act === 'edit') openUserModal(u);
        else if (act === 'reset') resetPasswordUser(u);
        else if (act === 'toggle') toggleAktifUser(u);
      });
    });
  };

  function openUserModal(u) {
    const isEdit = !!u;
    $('muTitle').textContent = isEdit ? 'Edit User: ' + (u.nama || u.username) : 'Tambah User';
    $('muUsername').value = isEdit ? u.username : '';
    $('muUsername').disabled = isEdit;
    $('muNama').value = isEdit ? (u.nama || '') : '';
    $('muRole').value = isEdit ? u.role : 'user';
    $('muPass').value = '';
    $('muPassGroup').style.display = isEdit ? 'none' : '';
    $('modalUser').classList.add('show');

    $('muSave').onclick = () => {
      const nama = $('muNama').value.trim();
      const role = $('muRole').value;
      const pass = $('muPass').value;
      const btn = $('muSave');
      btn.disabled = true;
      const selesai = r => {
        btn.disabled = false;
        $('modalUser').classList.remove('show');
        state.usersCache = null;
        if (r && r.ok) { toast('✅ User tersimpan', 'success'); renderUsers(); }
        else toast('❌ ' + ((r && r.message) || 'Gagal'), 'error');
      };
      if (isEdit) {
        google.script.run.withSuccessHandler(selesai).withFailureHandler(e => selesai({ ok: false, message: e.message }))
          .apiUpdateUser({ id: u.id, nama, role });
      } else {
        google.script.run.withSuccessHandler(selesai).withFailureHandler(e => selesai({ ok: false, message: e.message }))
          .apiSaveUsers({ user: { username: $('muUsername').value.trim(), nama, role, password: pass } });
      }
    };
    $('muCancel').onclick = () => $('modalUser').classList.remove('show');
  }

  function resetPasswordUser(u) {
    const pw = prompt('Password baru untuk ' + (u.nama || u.username) + ' (min. 6 karakter):');
    if (pw === null) return;
    if (pw.length < 6) { toast('Password minimal 6 karakter', 'error'); return; }
    google.script.run
      .withSuccessHandler(r => {
        if (r.ok) toast('✅ Password ' + (u.nama || u.username) + ' direset', 'success');
        else toast('❌ ' + r.message, 'error');
      })
      .withFailureHandler(e => toast('❌ ' + e.message, 'error'))
      .apiResetUserPassword({ id: u.id, password: pw });
  }

  function toggleAktifUser(u) {
    const target = !(u.aktif !== false && u.aktif !== 'false');
    if (!target && A.state && A.state.user && u.username === A.state.user.username) {
      toast('Tidak bisa menonaktifkan akun sendiri', 'error');
      return;
    }
    google.script.run
      .withSuccessHandler(r => {
        if (r.ok) { toast(target ? '✅ User diaktifkan' : '⛔ User dinonaktifkan', 'success'); state.usersCache = null; renderUsers(); }
        else toast('❌ ' + r.message, 'error');
      })
      .withFailureHandler(e => toast('❌ ' + e.message, 'error'))
      .apiUpdateUser({ id: u.id, aktif: target });
  }

  /* ============================================================ */
  /* LOG AKTIVITAS (admin)                                         */
  /* ============================================================ */
  window.renderLogs = function () {
    const c = $('appContent');
    if (!c) return;
    if (!A.isAdmin || !A.isAdmin()) { c.innerHTML = A.emptyState ? A.emptyState('🔒', 'Khusus Admin', '') : 'Khusus admin'; return; }

    if (!state.logsCache) {
      c.innerHTML = '<div class="page-loading"><div class="spinner"></div><p>Memuat log...</p></div>';
      return google.script.run
        .withSuccessHandler(r => {
          if (r.ok) { state.logsCache = r.data; renderLogs(); }
          else c.innerHTML = A.emptyState ? A.emptyState('⚠️', 'Gagal memuat', r.message) : esc(r.message);
        })
        .withFailureHandler(e => { c.innerHTML = A.emptyState ? A.emptyState('⚠️', 'Gagal memuat', e.message) : esc(e.message); })
        .apiGetLogs({ limit: 300 });
    }

    const logs = state.logsCache;
    const cls = a => {
      if (/GAGAL|DITOLAK/.test(a)) return 'unverified';
      if (/LOGIN|LOGOUT/.test(a)) return 'unprinted';
      return 'verified';
    };
    let rows = '';
    logs.forEach(l => {
      rows +=
        '<div class="log-row">' +
          '<div class="log-aksi"><span class="person-verify-tag ' + cls(l.aksi) + '">' + esc(l.aksi) + '</span></div>' +
          '<div class="log-info"><b>' + esc(l.username || '-') + '</b> — ' + esc(l.keterangan || '') +
            '<div class="log-time">' + esc(String(l.timestamp).replace('T', ' ').slice(0, 19)) + '</div>' +
          '</div>' +
        '</div>';
    });
    if (!logs.length) rows = '<div class="empty-state"><div class="big">📭</div><h3>Belum ada log</h3></div>';

    c.innerHTML =
      '<div class="cfg-hero">' +
        '<div class="cfg-hero-content">' +
          '<div class="cfg-hero-label">📋 ADMIN PANEL</div>' +
          '<div class="cfg-hero-title">Log Aktivitas</div>' +
          '<div class="cfg-hero-cand">Semua aksi penting tercatat (login, CRUD, verifikasi, cetak)</div>' +
        '</div>' +
        '<div class="cfg-hero-stats">' +
          '<div class="cfg-hero-stat"><div class="lbl">Entri</div><div class="val">' + logs.length + '</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="cfg-section"><div class="cfg-section-head">' +
        '<div class="cfg-section-ico">📋</div>' +
        '<div><div class="cfg-section-title">Riwayat</div><div class="cfg-section-sub">300 terbaru</div></div>' +
        '<button class="cfg-kk-btn edit" id="btnLogRefresh" type="button" style="width:auto;padding:0 12px;height:36px;border-radius:10px" title="Refresh">↻</button>' +
      '</div>' + rows + '</div>';

    $('btnLogRefresh').addEventListener('click', () => { state.logsCache = null; renderLogs(); });
  };

  /* ============================================================ */
  /* PROFIL & GANTI PASSWORD (semua role)                          */
  /* ============================================================ */
  window.renderProfil = function () {
    const c = $('appContent');
    if (!c) return;
    const u = A.state ? A.state.user : null;
    const admin = A.isAdmin && A.isAdmin();
    c.innerHTML =
      '<div class="cfg-hero">' +
        '<div class="cfg-hero-content">' +
          '<div class="cfg-hero-label">👤 AKUN SAYA</div>' +
          '<div class="cfg-hero-title">' + esc(u ? (u.nama || u.username) : '-') + '</div>' +
          '<div class="cfg-hero-cand">@' + esc(u ? u.username : '') + ' • Role: <b>' + (admin ? 'Admin' : 'User') + '</b></div>' +
        '</div>' +
        '<div class="cfg-hero-stats">' +
          '<div class="cfg-hero-stat"><div class="lbl">Akses</div><div class="val" style="font-size:16px">' + (admin ? 'Penuh' : 'Lihat') + '</div></div>' +
        '</div>' +
      '</div>' +
      (admin ?
      '<div class="cfg-section mobile-only">' +
        '<div class="cfg-section-head">' +
          '<div class="cfg-section-ico">' + (ICONS.settings || '') + '</div>' +
          '<div><div class="cfg-section-title">Pengelolaan</div><div class="cfg-section-sub">Menu khusus admin</div></div>' +
        '</div>' +
        '<div class="menu-list">' +
          '<button class="menu-item" data-goto="users" type="button"><span class="mi-ico">' + (ICONS.users || '') + '</span><span class="mi-txt">Kelola User</span><span class="mi-chev">' + (ICONS.next || '›') + '</span></button>' +
          '<button class="menu-item" data-goto="logs" type="button"><span class="mi-ico">' + (ICONS.card || '') + '</span><span class="mi-txt">Log Aktivitas</span><span class="mi-chev">' + (ICONS.next || '›') + '</span></button>' +
        '</div>' +
      '</div>' : '') +
      '<div id="profilZoneCard" class="profil-push"></div>' +
      '<div id="profilPushCard" class="profil-push"></div>' +
      '<div class="cfg-section">' +
        '<div class="cfg-section-head">' +
          '<div class="cfg-section-ico">🔑</div>' +
          '<div><div class="cfg-section-title">Keamanan</div><div class="cfg-section-sub">Ganti password akun ini</div></div>' +
        '</div>' +
        '<button class="cfg-add-btn" id="btnGantiPw" type="button">' + (ICONS.save || '') + ' Ganti Password</button>' +
        '<div class="cfg-info">' + (ICONS.info || '') + '<div>Setelah password diganti, sesi tetap aktif di perangkat ini. Perangkat lain yang belum login tidak terpengaruh.</div></div>' +
      '</div>' +
      '<div class="cfg-section">' +
        '<div class="cfg-section-head">' +
          '<div class="cfg-section-ico">📲</div>' +
          '<div><div class="cfg-section-title">Aplikasi (PWA)</div><div class="cfg-section-sub">Pasang di home screen / desktop</div></div>' +
        '</div>' +
        '<div class="cfg-info">' + (ICONS.info || '') + '<div>Android/Chrome: menu ⋮ → <b>Install app</b>. iPhone/Safari: Share → <b>Add to Home Screen</b>. Desktop: ikon install di address bar.</div></div>' +
        '<button class="cfg-add-btn" id="btnInstallHere" type="button" style="display:none">⬇️ Install App Sekarang</button>' +
      '</div>' +
      '<button class="logout-card mobile-only" id="btnProfilLogout" type="button">' + (ICONS.close || '') + ' Keluar Aplikasi</button>';

    if (window.__notif && window.__notif.mountPushCard) window.__notif.mountPushCard('profilPushCard');
    if (window.__agenda && window.__agenda.mountZoneCard) window.__agenda.mountZoneCard('profilZoneCard');
    c.querySelectorAll('[data-goto]').forEach(btn => {
      btn.addEventListener('click', () => { if (A.setPage) A.setPage(btn.getAttribute('data-goto')); });
    });
    const lo = $('btnProfilLogout');
    if (lo) lo.addEventListener('click', () => { const b = $('logoutBtn'); if (b) b.click(); });
    $('btnGantiPw').addEventListener('click', () => {
      $('pwOld').value = ''; $('pwNew').value = ''; $('pwNew2').value = '';
      $('modalPass').classList.add('show');
    });
    const ib = $('btnInstallHere');
    if (ib && window.__deferredInstallPrompt) {
      ib.style.display = '';
      ib.addEventListener('click', () => window.__triggerInstall());
    }
  };

  // Wiring modal ganti password (dipasang sekali)
  function wirePasswordModal() {
    const save = $('pwSave');
    const cancel = $('pwCancel');
    if (!save || save._wired) return;
    save._wired = true;
    save.addEventListener('click', () => {
      const oldPw = $('pwOld').value;
      const newPw = $('pwNew').value;
      const newPw2 = $('pwNew2').value;
      if (!oldPw || !newPw) { toast('Lengkapi password lama & baru', 'error'); return; }
      if (newPw.length < 6) { toast('Password baru minimal 6 karakter', 'error'); return; }
      if (newPw !== newPw2) { toast('Ulangi password tidak sama', 'error'); return; }
      save.disabled = true;
      google.script.run
        .withSuccessHandler(r => {
          save.disabled = false;
          if (r.ok) { $('modalPass').classList.remove('show'); toast('✅ Password berhasil diganti', 'success'); }
          else toast('❌ ' + r.message, 'error');
        })
        .withFailureHandler(e => { save.disabled = false; toast('❌ ' + e.message, 'error'); })
        .apiChangeOwnPassword({ oldPassword: oldPw, newPassword: newPw });
    });
    cancel.addEventListener('click', () => $('modalPass').classList.remove('show'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wirePasswordModal);
  else wirePasswordModal();
})();
