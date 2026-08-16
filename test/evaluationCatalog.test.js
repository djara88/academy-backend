const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveEvaluationProfile,
  sanitizeCustomEvaluationConfig,
  sanitizeRadarMetrics,
  selectComparableEvaluations,
} = require('../services/evaluationCatalog');

test('tenis obtiene métricas propias y no métricas de fútbol', () => {
  const profile = resolveEvaluationProfile({ discipline: 'Tenis' });
  assert.equal(profile.code, 'tenis');
  assert.deepEqual(profile.metrics, ['Saque', 'Derecha', 'Revés', 'Volea', 'Movilidad', 'Toma de decisiones']);
  assert.equal(profile.metrics.includes('Remate'), false);
  assert.equal(profile.supportsFootballStats, false);
});

test('arquero de fútbol usa perfil específico', () => {
  const profile = resolveEvaluationProfile({ discipline: 'Fútbol', role: 'Arquero' });
  assert.equal(profile.profileCode, 'futbol:arquero');
  assert.equal(profile.metrics.includes('Reflejos'), true);
  assert.equal(profile.metrics.includes('Juego aéreo'), true);
});

test('disciplina desconocida usa perfil genérico seguro', () => {
  const profile = resolveEvaluationProfile({ discipline: 'Escalada deportiva' });
  assert.equal(profile.code, 'generico');
  assert.equal(profile.metrics.length, 6);
});

test('criterios personalizados quedan ligados a rama y versión', () => {
  const profile = resolveEvaluationProfile({
    discipline: 'Tenis',
    scopeId: 'rama-tenis-1',
    customConfig: { metrics: ['Saque táctico', 'Consistencia', 'Lectura de juego', 'Movilidad'], version: 4 },
  });
  assert.equal(profile.custom, true);
  assert.equal(profile.profileCode, 'tenis:custom:rama-tenis-1');
  assert.equal(profile.metricVersion, 4);
  assert.deepEqual(profile.metrics, ['Saque táctico', 'Consistencia', 'Lectura de juego', 'Movilidad']);
});

test('sanitiza criterios duplicados y exige al menos tres distintos', () => {
  const config = sanitizeCustomEvaluationConfig({
    metrics: [' Técnica ', 'técnica', 'Decisiones', 'Actitud', ''],
  }, 2);
  assert.deepEqual(config.metrics, ['Técnica', 'Decisiones', 'Actitud']);
  assert.equal(config.version, 3);
  assert.throws(
    () => sanitizeCustomEvaluationConfig({ metrics: ['Técnica', 'Actitud'] }, 1),
    /Define entre 3 y 10 criterios/,
  );
});

test('sanitiza valores y descarta métricas ajenas al perfil', () => {
  const profile = resolveEvaluationProfile({ discipline: 'Básquetbol' });
  const radar = sanitizeRadarMetrics({
    'Manejo de balón': 115,
    Pase: 72.6,
    Tiro: -5,
    Remate: 100,
  }, profile.metrics);
  assert.deepEqual(radar, { 'Manejo de balón': 100, Pase: 73, Tiro: 0 });
});

test('solo compara evaluaciones del mismo perfil y versión', () => {
  const evaluations = [
    { id: 'tenis-actual', perfil_evaluacion: 'tenis', metricas_version: 2, datos_radar: { Saque: 80, Derecha: 75, Revés: 70 } },
    { id: 'futbol-intermedia', perfil_evaluacion: 'futbol', metricas_version: 2, datos_radar: { Pase: 80, Remate: 65, Defensa: 60 } },
    { id: 'tenis-anterior', perfil_evaluacion: 'tenis', metricas_version: 2, datos_radar: { Saque: 72, Derecha: 69, Revés: 64 } },
    { id: 'tenis-v1', perfil_evaluacion: 'tenis', metricas_version: 1, datos_radar: { Saque: 60, Derecha: 60, Revés: 60 } },
  ];
  assert.deepEqual(
    selectComparableEvaluations(evaluations).map((evaluation) => evaluation.id),
    ['tenis-actual', 'tenis-anterior'],
  );
});

test('un cambio de versión personalizada no fabrica evolución', () => {
  const evaluations = [
    { id: 'custom-v3', perfil_evaluacion: 'basquetbol:custom:rama-1', metricas_version: 3, datos_radar: { Tiro: 80, Defensa: 70, Liderazgo: 75 } },
    { id: 'custom-v2', perfil_evaluacion: 'basquetbol:custom:rama-1', metricas_version: 2, datos_radar: { Tiro: 78, Defensa: 68, Pase: 80 } },
    { id: 'custom-v3-prev', perfil_evaluacion: 'basquetbol:custom:rama-1', metricas_version: 3, datos_radar: { Tiro: 74, Defensa: 67, Liderazgo: 70 } },
  ];
  assert.deepEqual(
    selectComparableEvaluations(evaluations).map((evaluation) => evaluation.id),
    ['custom-v3', 'custom-v3-prev'],
  );
});

test('historial legado solo se compara cuando conserva exactamente las mismas métricas', () => {
  const evaluations = [
    { id: 'legacy-a', datos_radar: { Velocidad: 80, Pase: 75, Remate: 70 } },
    { id: 'legacy-distinto', datos_radar: { Saque: 80, Derecha: 75, Revés: 70 } },
    { id: 'legacy-b', datos_radar: { Remate: 65, Pase: 70, Velocidad: 74 } },
  ];
  assert.deepEqual(
    selectComparableEvaluations(evaluations).map((evaluation) => evaluation.id),
    ['legacy-a', 'legacy-b'],
  );
});
