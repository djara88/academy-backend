const test = require('node:test');
const assert = require('node:assert/strict');
const { academyForEnrollmentPdf, mergeAcademyTraining, fromSchedule } = require('../services/enrollmentTrainingSchedule');

const academy = {
  id: 'academy-a', nombre: 'Academia SOL', direccion: 'Dirección central',
  dias_entrenamiento: '', horarios_entrenamiento: '', ubicacion_entrenamiento: '',
};
const site = {
  id: 'site-a', academia_id: 'academy-a', nombre: 'Sede Quilicura',
  direccion: 'La Coruña 501', ubicacion_entrenamiento: 'La Coruña 501',
  dias_entrenamiento: 'MARTES · SABADO',
  horarios_entrenamiento: 'MARTES: 18:30–21:00 | SABADO: 10:00–12:00',
  horarios_config: [
    { dias: 'MARTES', inicio: '18:30', fin: '21:00' },
    { dias: 'SABADO', inicio: '10:00', fin: '12:00' },
  ],
  principal: true,
};

const fakeDb = ({ sites = [site], branches = [] } = {}) => ({
  from(table) {
    const filters = [];
    const query = {
      select() { return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      order() { return query; },
      limit() { return query; },
      async maybeSingle() {
        const rows = table === 'sedes' ? sites : table === 'ramas' ? branches : [];
        return {
          data: rows.find((row) => filters.every(([key, value]) => row[key] === value)) || null,
          error: null,
        };
      },
    };
    return query;
  },
});

test('la matrícula usa exactamente la sede del deportista y no los campos globales', async () => {
  const anotherSite = { ...site, id: 'site-b', dias_entrenamiento: 'DOMINGO', horarios_entrenamiento: '08:00–09:00', direccion: 'Otra dirección' };
  const result = await academyForEnrollmentPdf(fakeDb({ sites: [anotherSite, site] }), academy, { sede_id: 'site-a' });
  assert.equal(result.dias_entrenamiento, 'MARTES · SABADO');
  assert.equal(result.horarios_entrenamiento, 'MARTES: 18:30–21:00 | SABADO: 10:00–12:00');
  assert.equal(result.ubicacion_entrenamiento, 'La Coruña 501');
  assert.equal(result.nombre, academy.nombre);
});

test('si solo tiene rama, se obtiene su sede y no otra academia', async () => {
  const branches = [{ id: 'rama-a', academia_id: academy.id, sede_id: 'site-a' }];
  const result = await academyForEnrollmentPdf(fakeDb({ branches }), academy, { rama_id: 'rama-a' });
  assert.equal(result.dias_entrenamiento, site.dias_entrenamiento);
});

test('la sede conserva el resumen de bloques aun si los campos legacy están vacíos', () => {
  const onlyBlocks = { ...site, dias_entrenamiento: '', horarios_entrenamiento: '' };
  const result = mergeAcademyTraining(academy, onlyBlocks);
  assert.equal(result.dias_entrenamiento, 'MARTES · SABADO');
  assert.equal(result.horarios_entrenamiento, 'MARTES: 18:30–21:00 | SABADO: 10:00–12:00');
  assert.equal(fromSchedule(onlyBlocks.horarios_config).dias, 'MARTES · SABADO');
});

test('datos de sede ausentes mantienen compatibilidad con la configuración histórica', async () => {
  const legacyAcademy = { ...academy, dias_entrenamiento: 'VIERNES', horarios_entrenamiento: '17:00–18:00' };
  const result = await academyForEnrollmentPdf(fakeDb({ sites: [] }), legacyAcademy, { sede_id: 'site-missing' });
  assert.equal(result.dias_entrenamiento, 'VIERNES');
  assert.equal(result.horarios_entrenamiento, '17:00–18:00');
});

test('no se cargan horarios de una sede que pertenece a otra academia', async () => {
  const external = { ...site, academia_id: 'academy-b' };
  const result = await academyForEnrollmentPdf(fakeDb({ sites: [external] }), academy, { sede_id: 'site-a' });
  assert.equal(result.dias_entrenamiento, '');
  assert.equal(result.ubicacion_entrenamiento, '');
});

test('nunca retorna otra sede si el alumno identifica una que no existe', async () => {
  const result = await academyForEnrollmentPdf(fakeDb(), academy, { sede_id: 'site-inexistente' });
  assert.equal(result.dias_entrenamiento, '');
  assert.equal(result.horarios_entrenamiento, '');
});
