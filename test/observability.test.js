const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const observabilityRoutes = require('../routes/observability');
const { extractClientErrorRecords, redact } = observabilityRoutes;

test('observability redacts secrets and personal identifiers', () => {
  const input = 'Bearer abc.def.ghi user@example.com 12.345.678-5 ?token=secret';
  const output = redact(input);
  assert.doesNotMatch(output, /user@example\.com/);
  assert.doesNotMatch(output, /12\.345\.678-5/);
  assert.doesNotMatch(output, /token=secret/);
  assert.match(output, /REDACTED/);
});

test('observability extracts only error spans and allowlisted attributes', () => {
  const payload = {
    resourceSpans: [{
      resource: { attributes: [
        { key: 'service.name', value: { stringValue: 'lestra-deportivo-web' } },
        { key: 'secret.token', value: { stringValue: 'should-not-leak' } },
      ] },
      scopeSpans: [{
        spans: [
          {
            traceId: 'a'.repeat(32),
            spanId: 'b'.repeat(16),
            name: 'client.navigation',
            status: { code: 1 },
          },
          {
            traceId: 'c'.repeat(32),
            spanId: 'd'.repeat(16),
            name: 'client.error.react',
            status: { code: 2, message: 'render failed' },
            attributes: [
              { key: 'app.route', value: { stringValue: '/dashboard?token=secret' } },
              { key: 'app.role', value: { stringValue: 'director' } },
            ],
            events: [{
              name: 'exception',
              attributes: [
                { key: 'exception.type', value: { stringValue: 'TypeError' } },
                { key: 'exception.message', value: { stringValue: 'boom user@example.com' } },
              ],
            }],
          },
        ],
      }],
    }],
  };

  const rows = extractClientErrorRecords(payload);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].traceId, 'c'.repeat(32));
  assert.equal(rows[0].role, 'director');
  assert.equal(rows[0].exceptionType, 'TypeError');
  assert.doesNotMatch(rows[0].message, /user@example\.com/);
  assert.doesNotMatch(JSON.stringify(rows[0]), /should-not-leak/);
});


const withServer = async (callback) => {
  const app = express();
  app.use('/api/observability', express.json({ limit: '128kb' }), observabilityRoutes);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address();
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
};

test('observability route rejects non-JSON telemetry', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/observability/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not-json',
    });
    assert.equal(response.status, 415);
  });
});

test('observability route accepts an OTLP browser error span', async () => {
  await withServer(async (baseUrl) => {
    const previousError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    try {
      const response = await fetch(`${baseUrl}/api/observability/v1/traces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceSpans: [{
            resource: { attributes: [{ key: 'service.name', value: { stringValue: 'lestra-deportivo-web' } }] },
            scopeSpans: [{
              spans: [{
                traceId: 'a'.repeat(32),
                spanId: 'b'.repeat(16),
                name: 'client.error.react',
                status: { code: 2, message: 'render failed' },
                attributes: [
                  { key: 'app.route', value: { stringValue: '/dashboard' } },
                  { key: 'app.role', value: { stringValue: 'director' } },
                ],
                events: [{
                  name: 'exception',
                  attributes: [
                    { key: 'exception.type', value: { stringValue: 'TypeError' } },
                    { key: 'exception.message', value: { stringValue: 'boom' } },
                  ],
                }],
              }],
            }],
          }],
        }),
      });
      assert.equal(response.status, 202);
      const body = await response.json();
      assert.equal(body.accepted, 1);
      assert.ok(logged.some((line) => line.includes('browser_otel_error')));
    } finally {
      console.error = previousError;
    }
  });
});
