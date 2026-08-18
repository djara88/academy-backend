const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'attendanceRoster.js'), 'utf8');

test('el registro de asistencia contempla feedback inmediato de ausencias', () => {
  assert.match(route, /router\.post\('\/'/);
  assert.match(route, /notifyAbsences/);
  assert.match(route, /attendanceStatus\(item\?\.estado\) === 'Ausente'/);
  assert.match(route, /SEGUIMIENTO DE ASISTENCIA/);
  assert.match(route, /Esperamos que esté bien/);
});

test('el WhatsApp de ausencia puede desactivarse explícitamente sin alterar la sesión', () => {
  assert.match(route, /req\.body\?\.notificar_ausencias !== false/);
  assert.match(route, /avisos_ausencia/);
});

test('justificados y presentes no disparan el seguimiento de ausencia', () => {
  assert.match(route, /attendanceStatus\(item\?\.estado\) === 'Ausente'/);
  assert.doesNotMatch(route, /attendanceStatus\(item\?\.estado\) === 'Justificado'\).*notifyAbsences/);
});
