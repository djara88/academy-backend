const fs = require('node:fs');

const limiter = fs.readFileSync('middleware/rateLimit.js', 'utf8');
const store = fs.readFileSync('services/redisRateLimitStore.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');

if (/new\s+Map\s*\(/.test(limiter)) {
  throw new Error('Rate-limit audit failed: production middleware must not keep counters in a process-local Map.');
}
for (const expected of [
  'RATE_LIMIT_REDIS_URL',
  'RATE_LIMIT_REDIS_REQUIRED',
  "'EVAL'",
  'PEXPIRE',
  "createHash('sha256')",
]) {
  if (!store.includes(expected)) throw new Error(`Rate-limit audit failed: Redis store missing ${expected}.`);
}

for (const expected of [
  "namespace: 'registration'",
  "namespace: 'payment'",
  "namespace: 'webhook'",
  "namespace: 'collection'",
  "app.use('/api/whatsapp/webhook', webhookLimiter)",
  "app.use('/api/whatsapp-bridge/webhook', webhookLimiter)",
  "app.use('/api/mercadopago/webhook', webhookLimiter)",
  "app.use('/api/mercadopago/platform-subscription', paymentLimiter)",
  'warmRateLimitStore()',
]) {
  if (!server.includes(expected)) throw new Error(`Rate-limit audit failed: server missing ${expected}.`);
}

const criticalBlocks = ['sensitiveLimiter', 'paymentLimiter', 'webhookLimiter', 'registrationLimiter', 'collectionLimiter'];
for (const name of criticalBlocks) {
  const match = server.match(new RegExp(`const ${name} = createRateLimiter\\(\\{([\\s\\S]*?)\\n\\}\\);`));
  if (!match || !match[1].includes('failClosed: true')) {
    throw new Error(`Rate-limit audit failed: ${name} must fail closed.`);
  }
}

if (/redis(?:s)?:\/\/[^\s"'@]+:[^\s"'@]+@/.test(store) || /red-db34un7lk1mc739etju0/.test(store)) {
  throw new Error('Rate-limit audit failed: Redis endpoint or credentials must not be hardcoded in source.');
}

console.log('Distributed rate-limit security audit passed.');
