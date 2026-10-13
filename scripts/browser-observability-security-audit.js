const fs = require('node:fs');

const server = fs.readFileSync('server.js', 'utf8');
const route = fs.readFileSync('routes/observability.js', 'utf8');
const test = fs.readFileSync('test/observability.test.js', 'utf8');

for (const expected of [
  "const observabilityRoutes = require('./routes/observability')",
  "namespace: 'browser-observability'",
  "app.use('/api/observability', observabilityLimiter, express.json({ limit: '128kb' }), observabilityRoutes)",
  "skip: (req) => req.originalUrl?.startsWith('/api/whatsapp/webhook/')",
]) {
  if (!server.includes(expected)) {
    throw new Error(`Observability audit failed: server missing ${expected}`);
  }
}

for (const expected of [
  "router.post('/v1/traces'",
  'MAX_SPANS = 20',
  'SAFE_ATTRIBUTE_KEYS',
  'REDACTED_EMAIL',
  'REDACTED_JWT',
  'REDACTED_RUT',
  "type: 'browser_otel_error'",
  "req.is('application/json')",
]) {
  if (!route.includes(expected)) {
    throw new Error(`Observability audit failed: ingest route missing ${expected}`);
  }
}

if (/authorization|cookie|password/i.test([...route.matchAll(/SAFE_ATTRIBUTE_KEYS = new Set\(\[([\s\S]*?)\]\)/g)][0]?.[1] || '')) {
  throw new Error('Observability audit failed: sensitive attribute was added to the allowlist.');
}

for (const expected of [
  'observability redacts secrets and personal identifiers',
  'observability extracts only error spans and allowlisted attributes',
]) {
  if (!test.includes(expected)) throw new Error(`Observability audit failed: missing test ${expected}`);
}

console.log('Backend browser observability security audit passed.');
