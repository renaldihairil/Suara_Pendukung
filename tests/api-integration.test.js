const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('real API handlers retain login, add, edit, print, filter and delete behavior', async t => {
  const server = spawn(process.execPath, ['mock/dev-server.js'], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: '4174' }, windowsHide: true
  });
  t.after(() => server.kill());
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Mock server did not start')), 10000);
    server.on('error', reject);
    server.on('exit', code => { clearTimeout(timeout); reject(new Error('Mock server exited: ' + code)); });
    server.stdout.on('data', chunk => { if (String(chunk).includes('http://localhost:4174')) { clearTimeout(timeout); resolve(); } });
  });
  const base = 'http://127.0.0.1:4174';
  const login = await fetch(base + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'login', username: 'admin', password: 'admin123' }) });
  assert.equal((await login.json()).ok, true);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function rpc(action, params = {}) {
    const res = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action, ...params }) });
    assert.equal(res.status, 200); const data = await res.json(); assert.equal(data.ok, true, data.message); return data;
  }
  const initial = await rpc('apiGetBootstrap', { fresh: true });
  assert.equal(initial.dashboard.total, initial.list.length);
  const a = await rpc('apiAdd', { nama: 'Uji Sinkron', nik: '5203080101900001', kampung: 'Sasak', rt: '001', fotoBase64: 'dGVzdA==', fotoMime: 'image/jpeg' });
  const b = await rpc('apiAdd', { nama: 'Uji Perempuan', nik: '5203084101900002', kampung: 'Sasak', rt: '002' });
  const afterAdd = await rpc('apiGetBootstrap', { fresh: true });
  assert.equal(afterAdd.list.length, initial.list.length + 2);
  assert.equal(afterAdd.dashboard.total, afterAdd.list.length);
  assert.equal(afterAdd.dashboard.laki, 1); assert.equal(afterAdd.dashboard.perempuan, 1);
  assert.notEqual(afterAdd.rev, initial.rev);
  const rev = await (await fetch(base + '/api/rev')).json(); assert.equal(rev.rev, afterAdd.rev);
  assert.equal(afterAdd.list.find(x => x.id === b.id).dicetak, null);
  assert.equal(afterAdd.dashboard.belumCetak, 1);
  assert.equal((await rpc('apiGetList', { ktp: 'false' })).total, 1);
  assert.equal((await rpc('apiGetList', { dicetak: 'false' })).total, 1);
  const noKtp = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ action: 'apiTogglePrint', args: [b.id, true] }) });
  assert.equal((await noKtp.json()).ok, false);
  const mixed = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ action: 'apiSetPrintBatch', args: [[a.id, b.id], true] }) });
  assert.equal((await mixed.json()).ok, false);
  assert.equal((await rpc('apiGetBootstrap', { fresh: true })).dashboard.dicetak, 0);
  await rpc('apiTogglePrint', { args: [a.id, true] });
  await rpc('apiUpdate', { id: a.id, nama: 'Uji Sinkron', nik: '5203080101900001', kampung: 'Sasak', rt: '001', fotoBase64: 'bmV3', fotoMime: 'image/jpeg' });
  await rpc('apiUpdate', { id: b.id, nama: 'Nama Diperbarui', nik: '5203084101900002', kampung: 'Sasak', rt: '003', fotoBase64: 'dGVzdA==', fotoMime: 'image/jpeg' });
  const changed = await rpc('apiGetBootstrap', { fresh: true });
  assert.equal(changed.dashboard.dicetak, 1);
  assert.equal(changed.dashboard.belumCetak, 1);
  assert.equal(changed.list.find(x => x.id === b.id).dicetak, false);
  assert.equal((await rpc('apiGetList', { ktp: 'true' })).total, 2);
  assert.equal(changed.list.find(x => x.id === b.id).nama, 'Nama Diperbarui');
  assert.notEqual(changed.rev, afterAdd.rev);
  const filtered = await rpc('apiGetList', { q: 'Diperbarui', rt: '003' }); assert.equal(filtered.total, 1);
  const unauthorized = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'apiAdd' }) }); assert.equal(unauthorized.status, 401);
  await rpc('apiDelete', { args: [a.id] }); await rpc('apiDelete', { args: [b.id] });
  const final = await rpc('apiGetBootstrap', { fresh: true });
  assert.equal(final.dashboard.total, initial.dashboard.total); assert.equal(final.list.length, initial.list.length);
});
