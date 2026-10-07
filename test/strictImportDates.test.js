const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseStrictIsoDate } = require('../services/strictDate');

test('acepta únicamente fechas ISO YYYY-MM-DD válidas', () => {
  assert.equal(parseStrictIsoDate('2026-10-07'), '2026-10-07');
  assert.equal(parseStrictIsoDate('2024-02-29'), '2024-02-29');
  assert.equal(parseStrictIsoDate('2026-02-29'), null);
  assert.equal(parseStrictIsoDate('2026-13-01'), null);
  assert.equal(parseStrictIsoDate('2026-04-31'), null);
});

test('rechaza formatos ambiguos o normalizados implícitamente', () => {
  for (const value of [
    '07/10/2026',
    '10/07/2026',
    '2026/10/07',
    '2026-1-7',
    '2026-10-07T00:00:00Z',
    new Date('2026-10-07T00:00:00Z'),
  ]) {
    assert.equal(parseStrictIsoDate(value), null, `debería rechazar ${String(value)}`);
  }
});

test('importadores masivos usan parser estricto y no new Date(value)', () => {
  const root = path.resolve(__dirname, '..');
  const jsonImport = fs.readFileSync(path.join(root, 'routes/importaciones.js'), 'utf8');
  const sheetImport = fs.readFileSync(path.join(root, 'routes/importacionesMultirama.js'), 'utf8');

  assert.match(jsonImport, /parseStrictIsoDate/);
  assert.match(sheetImport, /parseStrictIsoDate/);
  assert.match(sheetImport, /cellDates:\s*false/);
  assert.doesNotMatch(jsonImport, /new Date\(value\)/);
  assert.doesNotMatch(sheetImport, /value instanceof Date/);
  assert.doesNotMatch(sheetImport, /latin\s*=|\[-\/\]/);
});
