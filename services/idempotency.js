const crypto = require('crypto');

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value ?? null;
};

const fingerprint = (value) => crypto
  .createHash('sha256')
  .update(JSON.stringify(stableValue(value)))
  .digest('hex');

const windowBucket = (windowMs = 5 * 60 * 1000, now = Date.now()) => Math.floor(Number(now) / Math.max(1000, Number(windowMs) || 1));

const resolveIdempotencyKey = ({
  providedKey,
  namespace,
  payload,
  windowMs = 5 * 60 * 1000,
  now = Date.now(),
} = {}) => {
  const explicit = String(providedKey || '').trim().slice(0, 160);
  if (explicit) return explicit;
  const scope = String(namespace || 'operation').trim().slice(0, 80) || 'operation';
  return `${scope}:${windowBucket(windowMs, now)}:${fingerprint(payload)}`.slice(0, 160);
};

module.exports = { fingerprint, windowBucket, resolveIdempotencyKey };
