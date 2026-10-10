const test = require('node:test');
const assert = require('node:assert/strict');
const domain = require('../lib/domain');

function row(timestamp, birth = '') {
  return ['id', timestamp, 'Uji', '5203080101900001', 'Laki-laki', birth, 36, 'Sasak', '001'];
}
test('Sheets serial dates and fractional time retain their ISO values', () => {
  assert.equal(domain.rowToPendukung(row(25569.5), 2).timestamp, '1970-01-01T12:00:00.000Z');
});
test('Unix millisecond timestamps do not get converted as Sheets serial dates', () => {
  const stamp = 1791592375112;
  assert.equal(domain.rowToPendukung(row(stamp), 2).timestamp, new Date(stamp).toISOString());
});
test('invalid numeric and Date timestamps never discard the supporter row', () => {
  for (const value of [NaN, Infinity, -Infinity, 1e20, new Date('invalid')]) {
    const result = domain.rowToPendukung(row(value, Infinity), 2);
    assert.equal(result.id, 'id'); assert.equal(result.timestamp, '');
    assert.equal(result.tanggalLahir, '');
  }
});
test('string and empty timestamps retain compatibility', () => {
  for (const value of ['', '2026-10-10T00:00:00Z', 'tanggal lama']) {
    assert.equal(domain.rowToPendukung(row(value), 2).timestamp, value);
  }
});
