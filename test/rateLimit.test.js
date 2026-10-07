const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../middleware/rateLimit');
const { createMemoryRateLimitStore, createRedisRateLimitStore } = require('../services/redisRateLimitStore');

const call = async (middleware, ip = '127.0.0.1', originalUrl = '/api/test') => {
  let nextCalled = false;
  let statusCode = 200;
  let payload = null;
  const headers = {};
  const req = { ip, originalUrl, path: originalUrl.split('?')[0], socket: { remoteAddress: ip } };
  const res = {
    setHeader(name, value) { headers[name] = value; },
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; },
  };
  await middleware(req, res, () => { nextCalled = true; });
  return { nextCalled, statusCode, payload, headers };
};

test('rate limiter permite tráfico dentro del umbral y bloquea el exceso', async () => {
  const limiter = createRateLimiter({
    namespace: 'test-threshold',
    windowMs: 60000,
    max: 2,
    store: createMemoryRateLimitStore(),
  });

  assert.equal((await call(limiter)).nextCalled, true);
  assert.equal((await call(limiter)).nextCalled, true);
  const blocked = await call(limiter);

  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.statusCode, 429);
  assert.match(blocked.payload.error, /Demasiadas solicitudes/);
  assert.ok(Number(blocked.headers['Retry-After']) >= 1);
});

test('rate limiter mantiene contadores separados por IP', async () => {
  const limiter = createRateLimiter({
    namespace: 'test-ip',
    windowMs: 60000,
    max: 1,
    store: createMemoryRateLimitStore(),
  });

  assert.equal((await call(limiter, '10.0.0.1')).nextCalled, true);
  assert.equal((await call(limiter, '10.0.0.2')).nextCalled, true);
  assert.equal((await call(limiter, '10.0.0.1')).statusCode, 429);
});

test('dos limitadores comparten contador cuando usan el mismo store y namespace', async () => {
  const sharedStore = createMemoryRateLimitStore();
  const firstInstance = createRateLimiter({ namespace: 'shared', windowMs: 60000, max: 1, store: sharedStore });
  const secondInstance = createRateLimiter({ namespace: 'shared', windowMs: 60000, max: 1, store: sharedStore });

  assert.equal((await call(firstInstance, '10.0.0.4')).nextCalled, true);
  const blocked = await call(secondInstance, '10.0.0.4');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.nextCalled, false);
});

test('rate limiter permite excluir endpoints autenticados por otro mecanismo', async () => {
  const limiter = createRateLimiter({
    namespace: 'test-skip',
    windowMs: 60000,
    max: 1,
    store: createMemoryRateLimitStore(),
    skip: (req) => req.originalUrl.startsWith('/api/whatsapp/webhook/'),
  });

  assert.equal((await call(limiter, '10.0.0.3', '/api/whatsapp/webhook/academy')).nextCalled, true);
  assert.equal((await call(limiter, '10.0.0.3', '/api/whatsapp/webhook/academy')).nextCalled, true);
  assert.equal((await call(limiter, '10.0.0.3', '/api/normal')).nextCalled, true);
  assert.equal((await call(limiter, '10.0.0.3', '/api/normal')).statusCode, 429);
});

test('operaciones críticas fallan cerrado si el store distribuido cae', async () => {
  const unavailableStore = {
    async consume() { throw new Error('redis unavailable'); },
  };
  const limiter = createRateLimiter({
    namespace: 'critical',
    windowMs: 60000,
    max: 10,
    store: unavailableStore,
    failClosed: true,
  });

  const result = await call(limiter, '10.0.0.5');
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 503);
  assert.equal(result.payload.code, 'RATE_LIMIT_STORE_UNAVAILABLE');
  assert.equal(result.headers['Retry-After'], '5');
});

test('API general puede fallar abierto si el store distribuido cae', async () => {
  const unavailableStore = {
    async consume() { throw new Error('redis unavailable'); },
  };
  const limiter = createRateLimiter({
    namespace: 'general',
    windowMs: 60000,
    max: 10,
    store: unavailableStore,
    failClosed: false,
  });

  const result = await call(limiter, '10.0.0.6');
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test('Redis store usa EVAL con TTL y no expone la clave cruda', async () => {
  const calls = [];
  const connection = {
    async command(args) {
      calls.push(args);
      return [2, 5000];
    },
    close() {},
  };
  const store = createRedisRateLimitStore({ connection });
  const result = await store.consume('payment:203.0.113.25:user-123', 60000);

  assert.equal(result.count, 2);
  assert.ok(result.resetAt > Date.now());
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'EVAL');
  assert.equal(calls[0][2], '1');
  assert.match(calls[0][3], /^rate-limit:[a-f0-9]{64}$/);
  assert.doesNotMatch(calls[0][3], /203\.0\.113\.25|user-123/);
  assert.equal(calls[0][4], '60000');
});
