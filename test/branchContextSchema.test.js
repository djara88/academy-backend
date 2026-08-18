const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'branchContext.js'), 'utf8');

test('branchContext no consulta una columna jugadores.telefono inexistente', () => {
  assert.doesNotMatch(source, /tutor_id,telefono,alerta_medica/);
  assert.match(source, /telefono:telefono_apoderado/);
});
