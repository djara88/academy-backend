const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('server conserva composición Express completa', () => {
  assert.match(server, /const express = require\('express'\)/);
  assert.match(server, /app\.listen\(/);
});

test('módulos operativos multirrama se montan antes de sus rutas legacy', () => {
  const pairs = [
    ['torneoMultiramaRoutes', 'torneoRoutes'],
    ['partidoMultiramaRoutes', 'partidoRoutes'],
    ['finanzasMultiramaRoutes', 'finanzasRoutes'],
    ['entrenamientosMultiramaRoutes', 'entrenamientosRoutes'],
    ['uniformesMultiramaRoutes', 'uniformesRoutes'],
    ['profesoresMultiramaRoutes', 'profesoresRoutes'],
  ];
  for (const [modern, legacy] of pairs) {
    const modernIndex = server.indexOf(modern);
    const legacyIndex = server.indexOf(legacy);
    assert.ok(modernIndex >= 0, `Falta ${modern}`);
    assert.ok(legacyIndex >= 0, `Falta ${legacy}`);
    assert.ok(server.lastIndexOf(modern) < server.lastIndexOf(legacy), `${modern} debe montarse antes de ${legacy}`);
  }
});

test('onboarding multirrama está montado antes del router de academias', () => {
  assert.ok(server.lastIndexOf('academyOnboardingMultiramaRoutes') < server.lastIndexOf('academiaRoutes'));
});
