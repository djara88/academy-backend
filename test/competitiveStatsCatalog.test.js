const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveCompetitiveProfile,
  sanitizeCompetitiveMetrics,
  metricsFromRow,
  aggregateCompetitiveStats,
  legacyStatColumns,
} = require('../services/competitiveStatsCatalog');

test('básquetbol usa estadísticas propias y agrega por jugador', () => {
  const profile = resolveCompetitiveProfile({ discipline: 'Básquetbol' });
  assert.equal(profile.code, 'basquetbol');
  assert.deepEqual(profile.metrics.map((item) => item.code), ['puntos', 'rebotes', 'asistencias', 'robos', 'tapones', 'triples']);

  const aggregate = aggregateCompetitiveStats(profile, [
    { disciplina_codigo: 'basquetbol', metricas_competitivas: { puntos: 18, rebotes: 7, asistencias: 4, robos: 2 }, es_mvp: true },
    { disciplina_codigo: 'basquetbol', metricas_competitivas: { puntos: 12, rebotes: 5, asistencias: 6, triples: 2 } },
  ]);
  assert.equal(aggregate.participations, 2);
  assert.equal(aggregate.mvp, 1);
  assert.equal(aggregate.metrics.find((item) => item.code === 'puntos').value, 30);
  assert.equal(aggregate.metrics.find((item) => item.code === 'rebotes').value, 12);
  assert.equal(aggregate.metrics.find((item) => item.code === 'asistencias').value, 10);
});

test('tenis no hereda columnas de fútbol', () => {
  const profile = resolveCompetitiveProfile({ discipline: 'Tenis' });
  const sanitized = sanitizeCompetitiveMetrics({ sets_ganados: 2, games_ganados: 12, goles: 9, tarjetas_rojas: 1 }, profile);
  assert.deepEqual(sanitized, { sets_ganados: 2, games_ganados: 12 });
  assert.deepEqual(legacyStatColumns(profile, sanitized), { goles: 0, asistencias: 0, tarjetas_amarillas: 0, tarjetas_rojas: 0 });
});

test('natación conserva mejor tiempo y suma mejores marcas', () => {
  const profile = resolveCompetitiveProfile({ discipline: 'Natación' });
  const aggregate = aggregateCompetitiveStats(profile, [
    { disciplina_codigo: 'natacion', metricas_competitivas: { pruebas: 2, mejores_marcas: 1, tiempo_segundos: 31.42 } },
    { disciplina_codigo: 'natacion', metricas_competitivas: { pruebas: 3, mejores_marcas: 2, tiempo_segundos: 30.87 } },
  ]);
  assert.equal(aggregate.metrics.find((item) => item.code === 'pruebas').value, 5);
  assert.equal(aggregate.metrics.find((item) => item.code === 'mejores_marcas').value, 3);
  assert.equal(aggregate.metrics.find((item) => item.code === 'tiempo_segundos').value, 30.87);
});

test('atletismo conserva la última marca y acumula PB/SB', () => {
  const profile = resolveCompetitiveProfile({ discipline: 'Atletismo' });
  const aggregate = aggregateCompetitiveStats(profile, [
    { disciplina_codigo: 'atletismo', metricas_competitivas: { marca: 11.24, pb: 1, sb: 1 } },
    { disciplina_codigo: 'atletismo', metricas_competitivas: { marca: 11.40, pb: 0, sb: 1 } },
  ]);
  assert.equal(aggregate.metrics.find((item) => item.code === 'marca').value, 11.24);
  assert.equal(aggregate.metrics.find((item) => item.code === 'pb').value, 1);
  assert.equal(aggregate.metrics.find((item) => item.code === 'sb').value, 2);
});

test('fútbol histórico se interpreta desde columnas legacy', () => {
  const profile = resolveCompetitiveProfile({ discipline: 'Fútbol' });
  const metrics = metricsFromRow({ goles: 3, asistencias: 2, tarjetas_amarillas: 1, tarjetas_rojas: 0 }, profile);
  assert.deepEqual(metrics, { goles: 3, asistencias: 2, tarjetas_amarillas: 1, tarjetas_rojas: 0 });
  assert.deepEqual(legacyStatColumns(profile, metrics), metrics);
});

test('filtra filas de otra disciplina al agregar el historial actual', () => {
  const profile = resolveCompetitiveProfile({ discipline: 'Básquetbol' });
  const aggregate = aggregateCompetitiveStats(profile, [
    { disciplina_codigo: 'basquetbol', metricas_competitivas: { puntos: 20 } },
    { disciplina_codigo: 'futbol', metricas_competitivas: { goles: 4 } },
  ]);
  assert.equal(aggregate.participations, 1);
  assert.equal(aggregate.metrics.find((item) => item.code === 'puntos').value, 20);
});
