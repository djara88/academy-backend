const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'professorOps.js'), 'utf8');

test('los casos pueden existir sin alumno y no generan un UUID "null"', () => {
  assert.match(source, /jugador_id:\s*null/);
  assert.match(source, /value\s*!==\s*null\s*&&\s*value\s*!==\s*undefined/);
  const filterIndex = source.indexOf('.filter((value) => value !== null');
  const mapIndex = source.indexOf('.map((value) => String(value).trim())');
  assert.ok(filterIndex >= 0, 'uniqueIds debe filtrar null/undefined');
  assert.ok(mapIndex >= 0, 'uniqueIds debe normalizar los IDs a texto');
  assert.ok(filterIndex < mapIndex, 'null debe filtrarse antes de convertir el valor a String');
});

test('la bandeja del profesor sigue decorando los casos sin exigir jugador_id', () => {
  assert.match(source, /router\.get\('\/me\/casos'/);
  assert.match(source, /playerIds\s*=\s*uniqueIds\(cases\.map\(\(item\)\s*=>\s*item\.jugador_id\)\)/);
  assert.match(source, /jugador:\s*item\.jugador_id\s*\?/);
});
