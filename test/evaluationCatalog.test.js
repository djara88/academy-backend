const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveEvaluationProfile,
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
