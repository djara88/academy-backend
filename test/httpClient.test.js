const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithTimeout } = require('../services/httpClient');

test('fetchWithTimeout propaga respuestas exitosas', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => ({ ok: true, signal: options.signal });

  try {
    const response = await fetchWithTimeout('https://example.test', {}, 50);
    assert.equal(response.ok, true);
    assert.ok(response.signal);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchWithTimeout aborta servicios externos lentos', async () => {
  const originalFetch = global.fetch;
  global.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  try {
    await assert.rejects(
      () => fetchWithTimeout('https://example.test', {}, 10),
      (error) => error.code === 'EXTERNAL_TIMEOUT'
    );
  } finally {
    global.fetch = originalFetch;
  }
});
