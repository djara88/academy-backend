const fs = require('node:fs');

for (const file of ['routes/importaciones.js', 'routes/importacionesMultirama.js']) {
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes('parseStrictIsoDate')) {
    throw new Error(`Strict date audit failed: ${file} must use parseStrictIsoDate.`);
  }
  if (/new Date\(value\)/.test(source) || /value instanceof Date/.test(source)) {
    throw new Error(`Strict date audit failed: ambiguous date parsing returned in ${file}.`);
  }
}
const sheet = fs.readFileSync('routes/importacionesMultirama.js', 'utf8');
if (!/cellDates:\s*false/.test(sheet)) {
  throw new Error('Strict date audit failed: spreadsheet parser must not auto-convert date cells.');
}
console.log('Strict import date audit passed.');
