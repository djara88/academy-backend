const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'alumnos.js'), 'utf8');
const loadAttendance = source.split('const loadAttendance = async')[1]?.split('const normalizeAwards =')[0];
const profileRoute = source.split("router.get('/:id/perfil'")[1]?.split("router.patch('/:id/ramas/")[0];

test('asistencias no tiene academia_id y la ficha limita primero entrenamientos por academia y rama', () => {
  assert.ok(loadAttendance, 'loadAttendance must exist');
  assert.match(loadAttendance, /from\('entrenamientos'\)[\s\S]*?\.eq\('academia_id', academyId\)[\s\S]*?\.eq\('rama_id', branchId\)/);
  assert.match(loadAttendance, /from\('asistencias'\)[\s\S]*?\.eq\('jugador_id', playerId\)[\s\S]*?\.in\('entrenamiento_id', trainingIds\)/);
  const attendanceQuery = loadAttendance.split("from('asistencias')")[1]?.split('if (error)')[0];
  assert.ok(attendanceQuery, 'Attendance query must be present');
  assert.doesNotMatch(attendanceQuery, /\.eq\('academia_id'/, 'asistencias has no academia_id column');
  assert.match(loadAttendance, /if \(!trainingIds\.length\) return/, 'empty academy/branch roster must fail closed');
});

test('ficha del alumno valida que el jugador y la inscripción pertenezcan al tenant', () => {
  assert.ok(profileRoute, 'profile route must exist');
  assert.match(profileRoute, /req\.tenant\.academyId/);
  assert.match(profileRoute, /loadPlayer\(academyId, req\.params\.id\)/);
  assert.match(profileRoute, /loadEnrollments\(academyId, player\.id\)/);
  assert.match(profileRoute, /loadAttendance\(academyId, player\.id, enrollment\.rama_id\)/);
});
