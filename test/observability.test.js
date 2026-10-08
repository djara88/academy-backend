const test = require('node:test');
const assert = require('node:assert/strict');
const { extractClientErrorRecords, redact } = require('../routes/observability');

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
