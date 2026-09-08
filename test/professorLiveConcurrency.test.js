const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'professorLiveConcurrency.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('API V2 de partido en vivo exige versión antes de mutar', () => {
  assert.match(route, /expected_live_updated_at/);
  assert.match(route, /LIVE_VERSION_REQUIRED/);
  assert.match(route, /res\.status\(428\)/);
});

test('marcador y etapa usan compare-and-swap sobre live_updated_at', () => {
  const patchBlock = route.split("router.patch('/me/partidos/:partidoId/en-vivo-v2'")[1]?.split("router.post('/me/partidos/:partidoId/en-vivo-v2/finalizar'")[0] || '';
  assert.ok(patchBlock.length > 500);
  assert.match(patchBlock, /String\(match\.live_updated_at \|\| ''\) !== expectedVersion/);
  assert.match(patchBlock, /\.eq\('live_updated_at', expectedVersion\)/);
  assert.match(patchBlock, /LIVE_STATE_CONFLICT/);
});

test('finalización también compara versión y es idempotente', () => {
  const finishBlock = route.split("router.post('/me/partidos/:partidoId/en-vivo-v2/finalizar'")[1] || '';
  assert.ok(finishBlock.length > 500);
  assert.match(finishBlock, /\.eq\('live_updated_at', expectedVersion\)\.eq\('en_vivo', true\)/);
  assert.match(finishBlock, /idempotent: true/);
  assert.match(finishBlock, /estado === 'Jugado'/);
});

test('inicio concurrente no puede activar dos veces el mismo partido', () => {
  const startBlock = route.split("router.post('/me/partidos/:partidoId/en-vivo-v2/iniciar'")[1]?.split("router.patch('/me/partidos/:partidoId/en-vivo-v2'")[0] || '';
  assert.ok(startBlock.length > 500);
  assert.match(startBlock, /\.eq\('en_vivo', false\)/);
  assert.match(startBlock, /idempotent: true/);
});

test('conflictos devuelven la versión actual para resincronizar sin sobrescribir', () => {
  assert.match(route, /code: 'LIVE_STATE_CONFLICT'/);
  assert.match(route, /data: await readCurrentMatch\(user\.academia_id, matchId\)/);
});

test('router concurrente está montado antes del router operativo histórico', () => {
  const concurrentIndex = server.indexOf("app.use('/api/profesores', professorLiveConcurrencyRoutes)");
  const legacyIndex = server.indexOf("app.use('/api/profesores', professorOpsRoutes)");
  assert.ok(concurrentIndex >= 0, 'Falta montar professorLiveConcurrencyRoutes');
  assert.ok(legacyIndex >= 0, 'Falta montar professorOpsRoutes');
  assert.ok(concurrentIndex < legacyIndex, 'El router V2 debe montarse antes del router histórico');
});
