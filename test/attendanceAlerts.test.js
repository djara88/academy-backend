const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAttendanceAlertRows, countConsecutiveAbsences } = require('../services/attendanceAlerts');

const trainings = [
  { id: 'e3', fecha: '2026-08-14' },
  { id: 'e2', fecha: '2026-08-12' },
  { id: 'e1', fecha: '2026-08-10' },
];

test('activa una alerta al alcanzar tres ausencias consecutivas', () => {
  const attendance = trainings.map((training) => ({ entrenamiento_id: training.id, jugador_id: 'j1', estado: 'Ausente' }));
  const [row] = buildAttendanceAlertRows({ academyId: 'a1', categoryId: 'c1', playerIds: ['j1'], trainings, attendance, now: '2026-08-14T20:00:00Z' });

  assert.equal(countConsecutiveAbsences('j1', trainings, new Map(attendance.map((item) => [`${item.entrenamiento_id}:${item.jugador_id}`, item.estado]))), 3);
  assert.equal(row.racha, 3);
  assert.equal(row.activa, true);
  assert.equal(row.newly_activated, true);
  assert.equal(row.ultima_ausencia, '2026-08-14');
});

test('una asistencia justificada corta la racha', () => {
  const attendance = [
    { entrenamiento_id: 'e3', jugador_id: 'j1', estado: 'Ausente' },
    { entrenamiento_id: 'e2', jugador_id: 'j1', estado: 'Justificado' },
    { entrenamiento_id: 'e1', jugador_id: 'j1', estado: 'Ausente' },
  ];
  const [row] = buildAttendanceAlertRows({ academyId: 'a1', categoryId: 'c1', playerIds: ['j1'], trainings, attendance });
  assert.equal(row.racha, 1);
  assert.equal(row.activa, false);
});

test('una alerta revisada no vuelve a abrirse mientras continúe la misma racha', () => {
  const attendance = trainings.map((training) => ({ entrenamiento_id: training.id, jugador_id: 'j1', estado: 'Ausente' }));
  const [row] = buildAttendanceAlertRows({
    academyId: 'a1', categoryId: 'c1', playerIds: ['j1'], trainings, attendance,
    existingAlerts: [{ jugador_id: 'j1', racha: 3, activa: false, detectada_at: '2026-08-13T20:00:00Z', revisada_at: '2026-08-14T10:00:00Z', revisada_por: 'u1' }],
  });
  assert.equal(row.activa, false);
  assert.equal(row.newly_activated, false);
  assert.equal(row.revisada_por, 'u1');
});
