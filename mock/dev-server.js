'use strict';
/* ============================================================
 * Dev server lokal untuk QA TANPA kredensial Google.
 * Menjalankan handler /api/* ASLI (api/rpc.js, api/auth.js,
 * api/photo.js) dengan lapisan googleapis di-mock in-memory —
 * jadi logika store, auth, dan role benar-benar diuji.
 * Frontend dilayani dari ../public.
 *
 * Jalankan: npm run dev  →  http://localhost:4173
 * Login admin: admin / admin123
 * ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = (parseInt(process.env.PORT, 10) > 0) ? parseInt(process.env.PORT, 10) : 4173;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/* ---------- ENV mock ---------- */
process.env.GOOGLE_CREDENTIALS = JSON.stringify({ client_email: 'mock@mock', private_key: 'mock' });
process.env.SPREADSHEET_ID = 'MOCK';
process.env.JWT_SECRET = 'dev-secret-untuk-qa-lokal-0123456789abcdef';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin123';

/* ---------- Data mock in-memory (baris 0 = header) ---------- */
const mockSheets = {
  Pendukung: [['ID', 'Timestamp', 'Nama', 'NIK', 'JenisKelamin', 'TanggalLahir', 'Usia', 'Kampung', 'RT', 'FotoKTP', 'FotoKTPId', 'Verified', 'FotoTTD', 'FotoTTDId', 'Dicetak']],
  Log: [['Timestamp', 'Aksi', 'Username', 'Keterangan']],
  Config: [['Key', 'Value']],
  Users: [['ID', 'Username', 'PasswordHash', 'Nama', 'Role', 'Aktif', 'CreatedAt', 'LastLogin']]
};
const mockFiles = {}; // fileId → { name, mime, bytes, isFolder }
let fileSeq = 0;

/* ---------- Mock googleapis (intersepsi require) ---------- */
const Module = require('module');
const gauthAbs = require.resolve('../lib/gauth');
const origLoad = Module._load;

function colToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Uji kinerja: MOCK_LATENCY_MS meniru latensi Google Sheets; hitungan panggilan di global.__gcalls
global.__gcalls = 0;
const lat = async () => { global.__gcalls++; const ms = Number(process.env.MOCK_LATENCY_MS || 0); if (ms) await new Promise(r => setTimeout(r, ms)); };
const sheetsApi = {
  spreadsheets: {
    async get() {
        await lat();
      return { data: { sheets: Object.keys(mockSheets).map(t => ({ properties: { title: t, sheetId: t } })) } };
    },
    async batchUpdate(opts) {
        await lat();
      for (const req of (opts.resource.requests || [])) {
        if (req.addSheet) mockSheets[req.addSheet.properties.title] = [];
        if (req.deleteDimension) {
          const title = req.deleteDimension.range.sheetId;
          if (mockSheets[title]) mockSheets[title].splice(req.deleteDimension.range.startIndex, 1);
        }
      }
      return { data: {} };
    },
    values: {
      async get(opts) {
        await lat();
        const m = String(opts.range).match(/^'(.+)'!(.+)$/);
        const title = m[1];
        const rows = mockSheets[title] || [];
        const range = m[2];
        // Pola: A1:C1 (cek header) | A1:Z (baca semua)
        const hm = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
        if (hm) {
          const r1 = parseInt(hm[2], 10), c1 = colToIndex(hm[1]), c2 = colToIndex(hm[3]);
          const out = [];
          for (let r = r1; r <= parseInt(hm[4], 10); r++) {
            const row = rows[r - 1] || [];
            const vals = [];
            for (let c = c1; c <= c2; c++) vals.push(row[c] !== undefined ? row[c] : null);
            out.push(vals);
          }
          return { data: { values: out } };
        }
        return { data: { values: rows.map(r => r.slice()) } };
      },
      async batchGet(opts) {
        await lat();
        const valueRanges = [];
        for (const range of opts.ranges) {
          const r = await sheetsApi.spreadsheets.values.get({ range, _internal: true });
          valueRanges.push({ range, values: r.data.values });
        }
        return { data: { valueRanges } };
      },
      async update(opts) {
        await lat();
        const m = String(opts.range).match(/^'(.+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
        const title = m[1];
        const r1 = parseInt(m[3], 10), c1 = colToIndex(m[2]);
        const rows = mockSheets[title];
        const vals = opts.resource.values.map(r => r.slice());
        // Google menulis sepanjang data bila range hanya menyebut sel awal (mis. A5)
        const c2 = m[4] ? colToIndex(m[4]) : c1 + Math.max(0, (vals[0] || []).length - 1);
        for (let i = 0; i < vals.length; i++) {
          const rowNum = r1 + i;
          while (rows.length < rowNum) rows.push([]);
          for (let c = c1; c <= c2; c++) rows[rowNum - 1][c] = vals[i][c - c1];
        }
        return { data: {} };
      },
      async append(opts) {
        await lat();
        const m = String(opts.range).match(/^'(.+)'!/);
        (mockSheets[m[1]] || (mockSheets[m[1]] = [])).push(opts.resource.values[0].slice());
        return { data: {} };
      }
    }
  }
};

const fakeSheetsPkg = {
  auth: { JWT: function () {} },
  sheets: () => sheetsApi
};

Module._load = function (request, parent, isMain) {
  if (request === '@googleapis/sheets' && parent && parent.filename === gauthAbs) {
    return fakeSheetsPkg;
  }
  return origLoad.apply(this, arguments);
};

/* ---------- Static file server ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon'
};
function serveStatic(res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.join(PUBLIC_DIR, decodeURIComponent(p));
  if (!full.startsWith(PUBLIC_DIR)) { res.statusCode = 403; return res.end('Forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) {
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.statusCode = 404; return res.end('Not found'); }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(idx);
      });
    }
    res.setHeader('Content-Type', MIME[path.extname(full)] || 'application/octet-stream');
    res.end(data);
  });
}

/* ---------- Mock jembatan foto Apps Script (Web App doPost) ---------- */
process.env.APPSCRIPT_PHOTO_URL = process.env.APPSCRIPT_PHOTO_URL || 'https://script.google.com/macros/s/MOCK/exec';
process.env.APPSCRIPT_PHOTO_KEY = process.env.APPSCRIPT_PHOTO_KEY || 'kunci-uji-minimal-24-karakter-x';
(function () {
  const realFetch = global.fetch;
  const KEY = 'kunci-uji-minimal-24-karakter-x';
  global.fetch = async function (url, opt) {
    if (String(url).startsWith('https://script.google.com/macros/s/MOCK')) {
      if (process.env.MOCK_GW_HTML) return { ok: true, status: 200, text: async () => '<html>Login</html>' };
      const req = JSON.parse((opt && opt.body) || '{}');
      // Uji: Apps Script lambat (MOCK_GW_DELAY_MS untuk op ocr); menghormati AbortSignal seperti fetch asli
      const delay = req.op === 'ocr' ? Number(process.env.MOCK_GW_DELAY_MS || 0) : 0;
      if (delay) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, delay);
          if (opt && opt.signal) opt.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
        });
      }
      const out = o => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
      if (req.key !== KEY) return out({ ok: false, message: 'Kunci salah' });
      if (req.op === 'ping') return out({ ok: true, user: 'pemilik@example.com', cap: { drive: true, email: true, dokumen: !process.env.MOCK_GW_NO_DOCS, driveApi: !process.env.MOCK_GW_NO_DRIVE } });
      if (req.op === 'upload') {
        const id = 'G' + (++fileSeq);
        mockFiles[id] = { id, name: req.name, mime: req.mime, bytes: Buffer.from(req.base64, 'base64'), folder: req.folder };
        return out({ ok: true, fileId: id });
      }
      if (req.op === 'get') {
        const f = mockFiles[req.fileId];
        if (!f) return out({ ok: false, message: 'File tidak ditemukan' });
        return out({ ok: true, mime: f.mime, base64: f.bytes.toString('base64') });
      }
      if (req.op === 'ocr') return out(process.env.MOCK_GW_NO_DRIVE ? { ok: false, code: 'NO_DRIVE_SERVICE', message: 'Layanan lanjutan Drive API belum ditambahkan' } : { ok: true, text: 'NIK : 5203083112950231\nNama : JUMADIL\nTempat/Tgl Lahir : X, 31-12-1995' });
      if (req.op === 'trash') { delete mockFiles[req.fileId]; return out({ ok: true }); }
      return out({ ok: false, message: 'op tidak dikenal' });
    }
    return realFetch.apply(this, arguments);
  };
})();

/* ---------- Mock OCR (tanpa Google Vision) ---------- */
(function () {
  const ocr = require('../lib/ocr');
  const SAMPLE = process.env.MOCK_OCR_TEXT ||
    'PROVINSI NUSA TENGGARA BARAT\nKABUPATEN LOMBOK BARAT\nNIK : 5201012503900001\nNama : MUHAIMIN SAPUTRA\nTempat/Tgl Lahir : MATARAM, 25-03-1990\nJenis Kelamin : LAKI-LAKI Gol. Darah : O\nAlamat : DS SERUNI';
  ocr.recognize = async function () { await new Promise(r => setTimeout(r, 300)); return { text: global.__MOCK_OCR_TEXT || SAMPLE }; };
})();

/* ---------- Server ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/__gcalls') { res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({ n: global.__gcalls })); }
    if (u.pathname === '/api/rpc') return await require('../api/rpc')(req, res);
    if (u.pathname === '/api/auth') return await require('../api/auth')(req, res);
    if (u.pathname === '/api/photo') return await require('../api/photo')(req, res);
    if (u.pathname === '/api/health') return await require('../api/health')(req, res);
    return serveStatic(res, u.pathname);
  } catch (e) {
    console.error('[dev-server]', e);
    if (!res.headersSent) { res.statusCode = 500; }
    res.end(JSON.stringify({ ok: false, message: e.message }));
  }
});

server.listen(PORT, () => {
  console.log('============================================================');
  console.log('  DEV SERVER (mock Google) → http://localhost:' + PORT);
  console.log('  Login admin : admin / admin123');
  console.log('  Data & user di memori (hilang saat restart)');
  console.log('============================================================');
});
