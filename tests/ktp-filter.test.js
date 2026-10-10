const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const domain = require('../lib/domain');
const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
function fn(name) {
  const start = app.indexOf('  function ' + name + '(');
  return app.slice(start, app.indexOf('\n  function ', start + 1));
}
test('without KTP, old printed flags are not applicable', () => {
  const row = ['1', '', 'Uji', '', '', '', '', 'Sasak', '001', '', '', false, '', '', true];
  assert.equal(domain.rowToPendukung(row, 2).dicetak, null);
  row[10] = 'ktp'; assert.equal(domain.rowToPendukung(row, 2).dicetak, true);
  row[14] = false; assert.equal(domain.rowToPendukung(row, 2).dicetak, false);
});
test('KTP filter combines with search, location and print filters without mutating data', () => {
  const ctx = { state: { filter: {}, allData: [
    { id: '1', nama: 'Ana', kampung: 'Sasak', rt: '001', fotoKTPId: '', dicetak: true },
    { id: '2', nama: 'Budi', kampung: 'Sasak', rt: '001', fotoKTPId: 'ktp', dicetak: false },
    { id: '3', nama: 'Cici', kampung: 'Mandar', rt: '002', fotoKTPId: 'ktp2', dicetak: true }
  ] }, normRT: String };
  vm.createContext(ctx); vm.runInContext(fn('hasKtp') + fn('printLabel') + fn('getFilteredData'), ctx);
  const ids = () => Array.from(ctx.getFilteredData(), p => p.id);
  ctx.state.filter.ktp = 'false'; assert.deepEqual(ids(), ['1']);
  ctx.state.filter.ktp = 'true'; assert.deepEqual(ids(), ['2', '3']);
  ctx.state.filter.dicetak = 'false'; assert.deepEqual(ids(), ['2']);
  ctx.state.filter.ktp = 'false'; assert.deepEqual(ids(), []);
  ctx.state.filter = { q: 'budi', kampung: 'Sasak', rt: '001', ktp: 'true' }; assert.deepEqual(ids(), ['2']);
  assert.equal(ctx.state.allData.length, 3);
  assert.equal(ctx.printLabel(ctx.state.allData[0]), 'Tidak ada KTP');
});
