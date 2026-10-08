const express = require('express');

const router = express.Router();

const MAX_SPANS = 20;
const SAFE_ATTRIBUTE_KEYS = new Set([
  'service.name',
  'service.version',
  'deployment.environment',
  'app.route',
  'app.role',
  'app.error.source',
  'exception.type',
  'exception.message',
  'exception.stacktrace',
]);

const redact = (value, max = 4000) => String(value ?? '')
  .slice(0, max)
  .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, '[REDACTED_BEARER]')
  .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
  .replace(/\b\d{1,2}[.]?\d{3}[.]?\d{3}-?[0-9Kk]\b/g, '[REDACTED_RUT]')
  .replace(/([?&](?:token|access_token|refresh_token|code|key|signature)=)[^&#\s]+/gi, '$1[REDACTED]');

const readOtlpValue = (value) => {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.intValue === 'string' || typeof value.intValue === 'number') return String(value.intValue);
  if (typeof value.doubleValue === 'number') return String(value.doubleValue);
  if (typeof value.boolValue === 'boolean') return String(value.boolValue);
  return '';
};

const attributesToObject = (attributes) => {
  const output = {};
  for (const item of Array.isArray(attributes) ? attributes : []) {
    const key = String(item?.key || '');
    if (!SAFE_ATTRIBUTE_KEYS.has(key)) continue;
    output[key] = redact(readOtlpValue(item?.value), key === 'exception.stacktrace' ? 7000 : 1200);
  }
  return output;
};

const extractClientErrorRecords = (payload) => {
  const records = [];
  for (const resourceSpan of Array.isArray(payload?.resourceSpans) ? payload.resourceSpans.slice(0, 4) : []) {
    const resourceAttrs = attributesToObject(resourceSpan?.resource?.attributes);
    for (const scopeSpan of Array.isArray(resourceSpan?.scopeSpans) ? resourceSpan.scopeSpans.slice(0, 4) : []) {
      for (const span of Array.isArray(scopeSpan?.spans) ? scopeSpan.spans : []) {
        if (records.length >= MAX_SPANS) return records;
        const attrs = { ...resourceAttrs, ...attributesToObject(span?.attributes) };
        const events = Array.isArray(span?.events) ? span.events : [];
        const exceptionEvent = events.find((event) => event?.name === 'exception');
        const exceptionAttrs = attributesToObject(exceptionEvent?.attributes);
        const statusCode = Number(span?.status?.code || 0);
        const isError = statusCode === 2 || Boolean(exceptionEvent) || String(span?.name || '').startsWith('client.error');
        if (!isError) continue;

        records.push({
          traceId: /^[a-f0-9]{32}$/i.test(String(span?.traceId || '')) ? String(span.traceId).toLowerCase() : null,
          spanId: /^[a-f0-9]{16}$/i.test(String(span?.spanId || '')) ? String(span.spanId).toLowerCase() : null,
          name: redact(span?.name || 'client.error', 160),
          route: redact(attrs['app.route'] || '', 500),
          role: redact(attrs['app.role'] || 'anonymous', 80),
          source: redact(attrs['app.error.source'] || 'browser', 80),
          service: redact(attrs['service.name'] || 'lestra-deportivo-web', 120),
          version: redact(attrs['service.version'] || '', 120),
          environment: redact(attrs['deployment.environment'] || 'production', 80),
          exceptionType: redact(exceptionAttrs['exception.type'] || attrs['exception.type'] || 'Error', 160),
          message: redact(exceptionAttrs['exception.message'] || attrs['exception.message'] || span?.status?.message || 'Client error', 1600),
          stack: redact(exceptionAttrs['exception.stacktrace'] || attrs['exception.stacktrace'] || '', 7000),
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
  return records;
};

router.post('/v1/traces', (req, res) => {
  try {
    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'Content-Type application/json requerido.' });
    }

    const records = extractClientErrorRecords(req.body);
    for (const record of records) {
      console.error(JSON.stringify({ type: 'browser_otel_error', ...record }));
    }

    return res.status(202).json({ accepted: records.length });
  } catch (error) {
    console.error('Browser OTLP ingest error:', error?.message || error);
    return res.status(400).json({ error: 'Payload de telemetría inválido.' });
  }
});

module.exports = router;
module.exports.extractClientErrorRecords = extractClientErrorRecords;
module.exports.redact = redact;
