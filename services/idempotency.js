const crypto = require('crypto');

const normalizeIdempotencyKey = (value, { required = false } = {}) => {
  const raw = String(value ?? '').trim();
  if (!raw) {
    if (required) {
      const error = new Error('Falta Idempotency-Key para esta operación.');
      error.status = 400;
      error.code = 'IDEMPOTENCY_KEY_REQUIRED';
      throw error;
    }
    return null;
  }
  if (raw.length < 8 || raw.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(raw)) {
    const error = new Error('Idempotency-Key no es válido.');
    error.status = 400;
    error.code = 'IDEMPOTENCY_KEY_INVALID';
    throw error;
  }
  return raw;
};

const requestIdempotencyKey = (req, options) => normalizeIdempotencyKey(
  req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || req.body?.idempotency_key,
  options,
);

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
};

const idempotencyFingerprint = (value) => crypto
  .createHash('sha256')
  .update(JSON.stringify(stableValue(value)))
  .digest('hex');

module.exports = {
  normalizeIdempotencyKey,
  requestIdempotencyKey,
  idempotencyFingerprint,
};
