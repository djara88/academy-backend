const test = require('node:test');
const assert = require('node:assert/strict');
const { getSubscriptionState } = require('../services/subscriptionAccess');

test('mantiene activa una prueba antes de su vencimiento', () => {
  const now = new Date('2026-08-14T12:00:00Z');
  const state = getSubscriptionState({ estado: 'Activa', subscription_status: 'trialing', trial_ends_at: '2026-08-20T12:00:00Z' }, now);
  assert.equal(state.blocked, false);
  assert.equal(state.trial, true);
  assert.equal(state.remainingDays, 6);
  assert.equal(state.urgency, 'medium');
});

test('bloquea una prueba vencida sin borrar datos', () => {
  const now = new Date('2026-08-22T12:00:00Z');
  const state = getSubscriptionState({ estado: 'Activa', subscription_status: 'trialing', trial_ends_at: '2026-08-21T12:00:00Z' }, now);
  assert.equal(state.blocked, true);
  assert.equal(state.status, 'suspended');
  assert.equal(state.reason, 'Prueba gratuita vencida');
});
