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

const sheetsApi = {
  spreadsheets: {
    async get() {
      return { data: { sheets: Object.keys(mockSheets).map(t => ({ properties: { title: t, sheetId: t } })) } };
    },
    async batchUpdate(opts) {
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
      async update(opts) {
        const m = String(opts.range).match(/^'(.+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
        const title = m[1];
        const r1 = parseInt(m[3], 10), c1 = colToIndex(m[2]);
        const c2 = m[4] ? colToIndex(m[4]) : c1;
        const rows = mockSheets[title];
        const vals = opts.resource.values.map(r => r.slice());
        for (let i = 0; i < vals.length; i++) {
          const rowNum = r1 + i;
          while (rows.length < rowNum) rows.push([]);
          for (let c = c1; c <= c2; c++) rows[rowNum - 1][c] = vals[i][c - c1];
        }
        return { data: {} };
      },
      async append(opts) {
        const m = String(opts.range).match(/^'(.+)'!/);
        (mockSheets[m[1]] || (mockSheets[m[1]] = [])).push(opts.resource.values[0].slice());
        return { data: {} };
      }
    }
  }
};

const driveApi = {
  files: {
    async list(opts) {
      const nameMatch = String(opts.q || '').match(/name="([^"]+)"/);
      if (nameMatch) {
        for (const f of Object.values(mockFiles)) {
          if (f.isFolder && f.name === nameMatch[1]) return { data: { files: [{ id: f.id, name: f.name }] } };
        }
      }
      return { data: { files: [] } };
    },
    async create(opts) {
      const id = 'F' + (++fileSeq);
      if (opts.requestBody && opts.requestBody.mimeType === 'application/vnd.google-apps.folder') {
        mockFiles[id] = { id, isFolder: true, name: opts.requestBody.name };
      } else {
        const body = opts.media && opts.media.body;
        mockFiles[id] = {
          id,
          name: (opts.requestBody && opts.requestBody.name) || 'file',
          mime: (opts.media && opts.media.mimeType) || 'image/jpeg',
          bytes: Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.alloc(0)
        };
      }
      return { data: { id } };
    },
    async update(opts) { return { data: { id: opts.fileId } }; },
    async get(opts) {
      const f = mockFiles[opts.fileId];
      if (!f || f.isFolder) { const e = new Error('File not found'); e.code = 404; throw e; }
      const buf = f.bytes;
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return { data: ab, headers: { 'content-type': f.mime } };
    }
  }
};

const fakeGoogleapis = {
  google: {
    auth: { JWT: function () {} },
    sheets: () => sheetsApi,
    drive: () => driveApi
  }
};

Module._load = function (request, parent, isMain) {
  if (request === 'googleapis' && parent && parent.filename === gauthAbs) {
    return fakeGoogleapis;
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

/* ---------- Server ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/api/rpc') return await require('../api/rpc')(req, res);
    if (u.pathname === '/api/auth') return await require('../api/auth')(req, res);
    if (u.pathname === '/api/photo') return await require('../api/photo')(req, res);
    if (u.pathname === '/api/cron') return await require('../api/cron')(req, res);
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
