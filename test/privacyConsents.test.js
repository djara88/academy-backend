const test = require('node:test');
const assert = require('node:assert/strict');
const { CONSENT_DEFINITIONS, PRIVACY_VERSION, getConsentCatalog } = require('../services/privacyConsents');

test('el aviso operativo es obligatorio y la difusión pública es opcional', () => {
  assert.equal(CONSENT_DEFINITIONS.aviso_privacidad.obligatorio, true);
  assert.equal(CONSENT_DEFINITIONS.imagen_publica.obligatorio, false);
  assert.equal(CONSENT_DEFINITIONS.imagen_interna.obligatorio, false);
  assert.equal(CONSENT_DEFINITIONS.datos_salud.obligatorio, false);
});

test('el consentimiento público no condiciona la matrícula', () => {
  assert.match(CONSENT_DEFINITIONS.imagen_publica.contenido, /no condiciona la matrícula/i);
  assert.match(CONSENT_DEFINITIONS.imagen_publica.contenido, /revocada/i);
});

test('el catálogo expone versión y cuatro decisiones separadas', () => {
  const catalog = getConsentCatalog('Academia Demo');
  assert.equal(catalog.version, PRIVACY_VERSION);
  assert.equal(catalog.items.length, 4);
  assert.deepEqual(new Set(catalog.items.map((item) => item.tipo)), new Set(['aviso_privacidad','datos_salud','imagen_interna','imagen_publica']));
});
