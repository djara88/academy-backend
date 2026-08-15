const fs = require('fs');
const path = 'routes/importaciones.js';
let source = fs.readFileSync(path, 'utf8');
const oldBlock = `const numberOrZero = (value) => {
  const raw = String(value ?? '').replace(/\\$/g, '').trim();
  if (!raw) return 0;
  const normalized = raw.includes(',') ? raw.replace(/\\./g, '').replace(',', '.') : raw.replace(/\\s/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};`;
const newBlock = `const numberOrZero = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? '').replace(/[$\\s]/g, '').trim();
  if (!raw) return 0;
  let normalized = raw;
  if (/^-?\\d{1,3}(\\.\\d{3})+(,\\d+)?$/.test(raw)) {
    normalized = raw.replace(/\\./g, '').replace(',', '.');
  } else if (/^-?\\d{1,3}(,\\d{3})+(\\.\\d+)?$/.test(raw)) {
    normalized = raw.replace(/,/g, '');
  } else if (raw.includes(',')) {
    normalized = raw.replace(/\\./g, '').replace(',', '.');
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};`;
if (!source.includes(oldBlock)) throw new Error('No se encontró el parser esperado');
source = source.replace(oldBlock, newBlock);
fs.writeFileSync(path, source);
