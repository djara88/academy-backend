import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSnapshot, parseState, stateVector, detectTransitions, formatStateMarker } from './monitor.mjs';

const healthySnapshot = {
  observedAt: '2026-08-21T16:00:00.000Z',
  backend: { ok: true, status: 200, durationMs: 100 },
  frontend: { ok: true, status: 200, durationMs: 50 },
  deportivo: { ok: true, status: 200, durationMs: 60 },
  ci: {
    backend: { available: true, state: 'ok', conclusion: 'success' },
    frontend: { available: false, state: 'unknown', conclusion: null },
  },
};

test('snapshot sano queda HEALTHY aunque CI cruzado no esté disponible', () => {
  const result = assessSnapshot(healthySnapshot);
  assert.equal(result.overall, 'healthy');
  assert.match(result.findings[0].message, /No se detectaron fallos/);
});

test('backend caído eleva estado a CRITICAL', () => {
  const result = assessSnapshot({
    ...healthySnapshot,
    backend: { ok: false, status: 503, durationMs: 300 },
  });
  assert.equal(result.overall, 'critical');
  assert.ok(result.findings.some((item) => item.severity === 'critical'));
});

test('deportivo caído es WARNING si frontend principal y backend siguen sanos', () => {
  const result = assessSnapshot({
    ...healthySnapshot,
    deportivo: { ok: false, status: 503, durationMs: 300 },
  });
  assert.equal(result.overall, 'warning');
});

test('CI fallido es WARNING, no CRITICAL', () => {
  const result = assessSnapshot({
    ...healthySnapshot,
    ci: {
      ...healthySnapshot.ci,
      backend: { available: true, state: 'failed', conclusion: 'failure' },
    },
  });
  assert.equal(result.overall, 'warning');
});

test('estado oculto se serializa y recupera sin pérdida', () => {
  const assessment = assessSnapshot(healthySnapshot);
  const state = stateVector(healthySnapshot, assessment);
  const marker = formatStateMarker(state);
  assert.deepEqual(parseState(`texto\n${marker}`), state);
});

test('primera ejecución registra baseline', () => {
  const assessment = assessSnapshot(healthySnapshot);
  const state = stateVector(healthySnapshot, assessment);
  const transitions = detectTransitions({ version: 1, status: 'initializing' }, state);
  assert.deepEqual(transitions, [{ key: 'baseline', from: 'initializing', to: 'healthy' }]);
});

test('cambio de backend y estado global genera transiciones', () => {
  const previous = {
    version: 1,
    overall: 'healthy',
    backend: 'ok',
    frontend: 'ok',
    deportivo: 'ok',
    backendCi: 'ok',
    frontendCi: 'unknown',
  };
  const current = { ...previous, overall: 'critical', backend: 'failed' };
  const transitions = detectTransitions(previous, current);
  assert.ok(transitions.some((item) => item.key === 'overall' && item.to === 'critical'));
  assert.ok(transitions.some((item) => item.key === 'backend' && item.to === 'failed'));
});
