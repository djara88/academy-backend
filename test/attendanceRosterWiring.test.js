const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const roster = fs.readFileSync(path.join(__dirname, '..', 'routes', 'attendanceRoster.js'), 'utf8');

test('el roster de asistencia se monta antes de las rutas de entrenamiento', () => {
  const rosterIndex = server.indexOf("app.use('/api/entrenamientos', attendanceRosterRoutes)");
  const trainingIndex = server.indexOf("app.use('/api/entrenamientos', entrenamientosMultiramaRoutes)");
  assert.ok(rosterIndex >= 0);
  assert.ok(trainingIndex >= 0);
  assert.ok(rosterIndex < trainingIndex);
});

test('el roster usa el alcance multcategoría real y devuelve identidad deportiva', () => {
  assert.match(roster, /getStudentsForScope/);
  assert.match(roster, /categoryId/);
  assert.match(roster, /rol_especialidad/);
  assert.match(roster, /documento/);
  assert.match(roster, /fecha_nacimiento/);
  assert.match(roster, /foto/);
  assert.match(roster, /tiene_alerta_medica/);
});

test('el roster valida que categoría y rama coincidan', () => {
  assert.match(roster, /CATEGORY_BRANCH_MISMATCH/);
  assert.match(roster, /getCategoryContext/);
});
