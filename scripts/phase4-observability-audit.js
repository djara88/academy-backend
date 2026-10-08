const fs = require('node:fs');

const server = fs.readFileSync('server.js', 'utf8');
const route = fs.readFileSync('routes/observability.js', 'utf8');

for (const expected of [
  "namespace: 'browser-observability'",
  "app.use('/api/observability', observabilityLimiter, express.json({ limit: '128kb' }), observabilityRoutes)",
  "req.originalUrl?.startsWith('/api/observability/')",
]) {
  if (!server.includes(expected)) throw new Error(`Phase 4 observability audit failed: server missing ${expected}.`);
}

for (const expected of [
  "router.post('/v1/traces'",
  "browser_otel_error",
  "SAFE_ATTRIBUTE_KEYS",
  "REDACTED_EMAIL",
  "REDACTED_JWT",
  "REDACTED_RUT",
  "accepted: records.length",
]) {
  if (!route.includes(expected)) throw new Error(`Phase 4 observability audit failed: route missing ${expected}.`);
}

if (/email|user\.id|access_token|refresh_token/.test(
  Array.from(route.matchAll(/SAFE_ATTRIBUTE_KEYS = new Set\(\[([\s\S]*?)\]\)/g))[0]?.[1] || ''
)) {
  throw new Error('Phase 4 observability audit failed: sensitive identity attributes must not be allowlisted.');
}

console.log('Phase 4 browser observability audit passed.');
