const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../middleware/rateLimit');

const call = (middleware, ip = '127.0.0.1', originalUrl = '/api/test') => {
  let nextCalled = false;
  let statusCode = 200;
  let payload = null;
  const headers = {};
  const req = { ip, originalUrl, socket: { remoteAddress: ip } };
  const res = {
    setHeader(name, value) { headers[name] = value; },
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; },
  };
  middleware(req, res, () => { nextCalled = true; });
  return { nextCalled, statusCode, payload, headers };
};

test('rate limiter permite tráfico dentro del umbral y bloquea el exceso', () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 2 });

  assert.equal(call(limiter).nextCalled, true);
  assert.equal(call(limiter).nextCalled, true);
  const blocked = call(limiter);

  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.statusCode, 429);
  assert.match(blocked.payload.error, /Demasiadas solicitudes/);
  assert.ok(Number(blocked.headers['Retry-After']) >= 1);
});

test('rate limiter mantiene contadores separados por IP', () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 1 });

  assert.equal(call(limiter, '10.0.0.1').nextCalled, true);
  assert.equal(call(limiter, '10.0.0.2').nextCalled, true);
  assert.equal(call(limiter, '10.0.0.1').statusCode, 429);
});

test('rate limiter permite excluir endpoints autenticados por otro mecanismo', () => {
  const limiter = createRateLimiter({
    windowMs: 60000,
    max: 1,
    skip: (req) => req.originalUrl.startsWith('/api/whatsapp/webhook/'),
  });

  assert.equal(call(limiter, '10.0.0.3', '/api/whatsapp/webhook/academy').nextCalled, true);
  assert.equal(call(limiter, '10.0.0.3', '/api/whatsapp/webhook/academy').nextCalled, true);
  assert.equal(call(limiter, '10.0.0.3', '/api/normal').nextCalled, true);
  assert.equal(call(limiter, '10.0.0.3', '/api/normal').statusCode, 429);
});
