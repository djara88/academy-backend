const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getRecognitionCatalog,
  sanitizeCustomRecognitions,
  findRecognition,
} = require('../services/recognitionCatalog');

test('artes marciales recibe reconocimientos formativos y competitivos propios', () => {
  const catalog = getRecognitionCatalog({ discipline: 'Karate', allowCustom: false });
  assert.equal(catalog.customization.allowed, false);
  assert.ok(catalog.standard.some((item) => item.code === 'marcial_espiritu' && item.kind === 'formacion'));
  assert.ok(catalog.standard.some((item) => item.code === 'marcial_combate' && item.kind === 'competencia'));
  assert.ok(catalog.standard.some((item) => item.code === 'formacion_companerismo'));
});

test('cada disciplina conserva catálogo específico además de la base formativa', () => {
  const football = getRecognitionCatalog({ discipline: 'Fútbol' });
  const swimming = getRecognitionCatalog({ discipline: 'Natación' });
  assert.ok(football.standard.some((item) => item.code === 'futbol_goleador'));
  assert.ok(swimming.standard.some((item) => item.code === 'natacion_pb'));
  assert.equal(football.standard.some((item) => item.code === 'natacion_pb'), false);
});

test('los reconocimientos personalizados se limpian, deduplican y limitan', () => {
  const input = Array.from({ length: 25 }, (_, index) => ({
    name: index === 1 ? ' Premio 0 ' : `Premio ${index}`,
    emoji: '🏆',
    kind: index % 2 ? 'competencia' : 'formacion',
  }));
  const cleaned = sanitizeCustomRecognitions({ items: input });
  assert.equal(cleaned.length, 20);
  assert.equal(cleaned.filter((item) => item.name === 'Premio 0').length, 1);
  assert.ok(cleaned.every((item) => item.code.startsWith('custom_')));
});

test('un reconocimiento personalizado solo se resuelve cuando el plan lo permite', () => {
  const customConfig = { items: [{ code: 'espiritu_dojo', name: 'Espíritu del dojo', emoji: '🥋', kind: 'formacion' }] };
  assert.equal(findRecognition({ discipline: 'Karate', code: 'custom_espiritu_dojo', customConfig, allowCustom: false }), null);
  const found = findRecognition({ discipline: 'Karate', code: 'custom_espiritu_dojo', customConfig, allowCustom: true });
  assert.equal(found?.name, 'Espíritu del dojo');
  assert.equal(found?.source, 'academy');
});
