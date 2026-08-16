const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveEvaluationProfile, sanitizeRadarMetrics } = require('../services/evaluationCatalog');

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
