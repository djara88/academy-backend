const test = require('node:test');
const assert = require('node:assert/strict');
const { fingerprint, windowBucket, resolveIdempotencyKey } = require('../services/idempotency');

test('fingerprint is stable across object key order', () => {
  assert.equal(
    fingerprint({ b: 2, a: 1, nested: { y: 2, x: 1 } }),
    fingerprint({ nested: { x: 1, y: 2 }, a: 1, b: 2 }),
  );
});

test('resolveIdempotencyKey preserves an explicit client key', () => {
  assert.equal(resolveIdempotencyKey({
    providedKey: ' client-key-123 ',
    namespace: 'payment',
    payload: { amount: 1000 },
    now: 1000,
  }), 'client-key-123');
});

test('fallback idempotency key is stable inside the same retry window', () => {
  const options = {
    namespace: 'payment',
    payload: { chargeId: 'charge-1', amount: 1000 },
    windowMs: 300000,
  };
  const first = resolveIdempotencyKey({ ...options, now: 1000000 });
  const second = resolveIdempotencyKey({ ...options, now: 1000500 });
  assert.equal(first, second);
  assert.match(first, /^payment:\d+:[a-f0-9]{64}$/);
});

test('fallback idempotency key expires into a new operation window', () => {
  const options = {
    namespace: 'payment',
    payload: { chargeId: 'charge-1', amount: 1000 },
    windowMs: 300000,
  };
  assert.notEqual(
    resolveIdempotencyKey({ ...options, now: 1000 }),
    resolveIdempotencyKey({ ...options, now: 301000 }),
  );
});

test('windowBucket has deterministic boundaries', () => {
  assert.equal(windowBucket(300000, 299999), 0);
  assert.equal(windowBucket(300000, 300000), 1);
});
