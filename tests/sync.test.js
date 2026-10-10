const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
function appFunction(name) {
  const start = app.indexOf('  function ' + name + '(');
  const next = app.indexOf('\n  function ', start + 1);
  return app.slice(start, next);
}
function frontend(extra = {}) {
  let handlers, calls = 0;
  const runner = { withSuccessHandler(cb) { handlers.ok = cb; return this; },
    withFailureHandler(cb) { handlers.fail = cb; return this; }, apiGetBootstrap() { calls++; } };
  const ctx = { state: { page: 'dashboard', pageToken: 1 }, console, Date, window: {},
    $: () => null, setSyncStatus(s) { ctx.state.syncStatus = s; },
    applyBootstrap(r) { ctx.state.allData = r.list; ctx.state.rev = r.rev; },
    refreshOpenDetail() {}, showPullIndicator() {}, toast() {}, ...extra,
    google: { script: { get run() { handlers = {}; return runner; } } } };
  vm.createContext(ctx); vm.runInContext(appFunction('fetchAndReplace'), ctx);
  return { ctx, calls: () => calls, succeed: r => handlers.ok(r), fail: e => handlers.fail(e) };
}
const boot = { ok: true, list: [{ id: '1' }], dashboard: { total: 1 }, rev: 'new' };
test('concurrent callers share one request and receive its result', () => {
  const f = frontend(); const results = [];
  f.ctx.fetchAndReplace(true, x => results.push(x));
  f.ctx.fetchAndReplace(true, x => results.push(x));
  assert.equal(f.calls(), 1); f.succeed(boot);
  assert.deepEqual(results, [true, true]); assert.equal(f.ctx.state.isFetching, false);
});
test('failed request releases lock and permits retry', () => {
  const f = frontend(); let result;
  f.ctx.fetchAndReplace(true, x => result = x); f.fail(new Error('HTTP 503'));
  assert.equal(result, false); assert.equal(f.ctx.state.syncStatus, 'stale');
  f.ctx.fetchAndReplace(true); assert.equal(f.calls(), 2);
});
test('invalid bootstrap preserves previous data and reports failure', () => {
  const f = frontend(); f.ctx.state.allData = [{ id: 'old' }]; let result;
  f.ctx.fetchAndReplace(true, x => result = x); f.succeed({ ok: true });
  assert.equal(result, false); assert.equal(f.ctx.state.allData[0].id, 'old');
});
test('response updates current page after navigation during request', () => {
  let rendered = 0; const f = frontend({ $: () => ({}), renderFilteredGrid() { rendered++; } });
  f.ctx.fetchAndReplace(true); f.ctx.state.page = 'data'; f.ctx.state.pageToken++;
  f.succeed(boot); assert.equal(rendered, 1);
});
test('reconnect fetches and restarts polling only after response', () => {
  let polls = 0; const f = frontend({ clearInterval() {}, sessionStorage: { setItem() {} },
    offTouch() {}, setOfflineUI() {}, applyRoleUI() {}, renderCurrentPage() {},
    startPolling() { polls++; }, watchModals() {}, window: {} });
  vm.runInContext(appFunction('goOnline'), f.ctx);
  f.ctx.state.offline = true; f.ctx.state.offlineBoot = true; f.ctx.state._failUntil = Infinity;
  f.ctx.goOnline({ username: 'admin' }); assert.equal(f.calls(), 1); assert.equal(polls, 0);
  f.succeed(boot); assert.equal(polls, 1); assert.equal(f.ctx.state.isFetching, false);
});
function storeHarness() {
  let reads = 0, fail = false;
  let rows = [['ID'], ['1', '2026-10-10', 'Satu', '123', 'Laki-laki', '', '', 'Sasak', '001', '', '', true, '', '', true],
    ['2', '', 'Dua', '456', 'Perempuan', '', '', 'Sasak', '002', '', '', false]];
  const cfgRows = [['Key', 'Value']];
  const sheets = { SHEET_PENDUKUNG: 'Pendukung', SHEET_CONFIG: 'Config',
    async readSheets() { reads++; if (fail) throw new Error('429 quota'); return [rows, cfgRows]; },
    async readSheet() { throw new Error('Unexpected extra read'); } };
  const cfg = { kampungList: ['Sasak'], targetPerKampung: {}, targetTotal: 750 };
  const domain = { parseConfigFromRows: () => cfg, normRT: String,
    normVerified: Boolean, normBool: Boolean,
    rowToPendukung: r => r[0] ? { id: r[0], timestamp: r[1], nama: r[2], nik: r[3],
      jenisKelamin: r[4], kampung: r[7], rt: r[8], verified: !!r[11], dicetak: !!r[14] } : null };
  const ctx = { module: { exports: {} }, console, require(n) {
    if (n === './gsheets') return sheets; if (n === './domain') return domain;
    if (n === './gdrive' || n === './roles') return {}; return require(n);
  } };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(root, 'lib/store.js'), 'utf8'), ctx);
  return { store: ctx.module.exports, reads: () => reads, fail() { fail = true; },
    add() { rows = [...rows, ['3', '', 'Tiga', '123', 'Perempuan', '', '', 'Sasak', '003']]; } };
}
test('bootstrap list, totals and revision use one read, even with cached old version', async () => {
  const h = storeHarness(); const old = await h.store.getVersion(); h.add();
  const r = await h.store.getBootstrap({ fresh: true });
  assert.equal(h.reads(), 2); assert.equal(r.list.length, 3); assert.equal(r.dashboard.total, 3);
  assert.equal(r.dashboard.laki, 1); assert.equal(r.dashboard.perempuan, 2);
  assert.equal(r.dashboard.verified, 1); assert.equal(r.dashboard.dicetak, 1);
  assert.equal(r.dupGroups, 1); assert.notEqual(r.version, old);
  assert.equal(r.dashboard.version, r.version); assert.equal(r.rev, h.store.revOf(r.version));
});
test('filters retain grand total and verification/print behavior', async () => {
  const h = storeHarness(); const r = await h.store.getBootstrap();
  const snapshot = { rows: [['ID'], ['1', '', 'Satu', '123', '', '', '', 'Sasak', '001', '', '', true, '', '', true],
    ['2', '', 'Dua', '456', '', '', '', 'Sasak', '002']], cfg: r.config, version: r.version };
  const filtered = await h.store.getList({ q: 'satu', verified: 'true', dicetak: 'true' }, snapshot);
  assert.equal(filtered.total, 1); assert.equal(filtered.grandTotal, 2);
});
test('Sheets failure returns revision HTTP 503, not success', async () => {
  const h = storeHarness(); h.fail(); await assert.rejects(h.store.getVersion(), /429/);
  const ctx = { module: { exports: {} }, require: () => h.store };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(root, 'api/rev.js'), 'utf8'), ctx);
  const res = { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
  await ctx.module.exports({}, res); assert.equal(res.statusCode, 503); assert.equal(res.body.ok, false);
});
test('offline/cache dashboard totals match list and label is not realtime', () => {
  const ctx = { state: {}, Date, TARGET_TOTAL: 750, TARGET_PER_KAMPUNG: {}, KAMPUNG_LIST: ['Sasak'],
    NAMA_PILKADES: '', NAMA_KANDIDAT: '', HARI_H: null };
  vm.createContext(ctx); vm.runInContext(appFunction('dashboardFromList'), ctx);
  vm.runInContext(appFunction('liveTagHtml'), ctx);
  const d = ctx.dashboardFromList([{ jenisKelamin: 'Perempuan', verified: true, dicetak: true, kampung: 'Sasak' }]);
  assert.equal(d.total, 1); assert.equal(d.perempuan, 1); assert.equal(d.verified, 1);
  assert.match(ctx.liveTagHtml(), /Data tersimpan/); ctx.state.offline = true;
  assert.match(ctx.liveTagHtml(), /Offline/); ctx.state.offline = false; ctx.state.syncStatus = 'online';
  assert.match(ctx.liveTagHtml(), /Realtime/);
});

test('remote revision refreshes data; matching revision avoids a heavy request', async () => {
  const f = frontend({ fetchJsonTimeout: async () => ({ ok: true, rev: 'new' }),
    offTouch() {}, navigator: { onLine: true } });
  vm.runInContext(appFunction('syncData'), f.ctx);
  f.ctx.state.rev = 'old'; f.ctx.state.allData = [{ id: 'old' }];
  f.ctx.syncData(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls(), 1); f.succeed(boot);
  f.ctx.syncData(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls(), 1); assert.equal(f.ctx.state.syncStatus, 'online');
});

test('revision failure releases its lock and does not falsely enter offline mode', async () => {
  let offline = 0;
  const f = frontend({ fetchJsonTimeout: async () => { throw new Error('HTTP 503'); },
    navigator: { onLine: true }, enterOffline() { offline++; } });
  vm.runInContext(appFunction('syncData'), f.ctx); f.ctx.state.allData = [];
  f.ctx.syncData(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.ctx.state.isRevChecking, false); assert.equal(f.ctx.state.syncStatus, 'stale');
  assert.equal(offline, 0);
});

test('RPC timeout covers response body and subsequent calls can succeed', async () => {
  let abortTimer, cleared = 0, signal;
  const ctx = { window: {}, console, AbortController, setTimeout(cb) { abortTimer = cb; return 1; },
    clearTimeout() { cleared++; }, fetch: async (url, opts) => {
      signal = opts.signal;
      return { ok: true, status: 200, json: () => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }) };
    } };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/api-shim.js'), 'utf8'), ctx);
  const failed = new Promise(resolve => ctx.google.script.run.withFailureHandler(resolve).apiGetBootstrap());
  await new Promise(resolve => setImmediate(resolve)); abortTimer();
  assert.match((await failed).message, /Timeout/); assert.equal(cleared, 1);
  ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const result = await new Promise(resolve => ctx.google.script.run.withSuccessHandler(resolve).apiGetBootstrap());
  assert.equal(result.ok, true); assert.equal(cleared, 2);
});
