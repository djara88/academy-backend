const { getRateLimitStore } = require('../services/redisRateLimitStore');

const defaultKey = (req) => req.user?.id || req.ip || req.socket?.remoteAddress || 'unknown';

const createRateLimiter = ({
  windowMs = 5 * 60 * 1000,
  max = 300,
  namespace = 'default',
  keyGenerator = defaultKey,
  skip = () => false,
  message = 'Demasiadas solicitudes. Intenta nuevamente en unos minutos.',
  failClosed = false,
  store,
} = {}) => {
  const selectedStore = store || getRateLimitStore();

  return async (req, res, next) => {
    if (skip(req)) return next();

    const rawKey = String(keyGenerator(req) || 'unknown');
    const key = `${namespace}:${rawKey}`;

    let bucket;
    try {
      bucket = await selectedStore.consume(key, windowMs);
    } catch (error) {
      console.error(`Rate limiter store unavailable (${namespace}):`, error?.message || error);
      if (failClosed) {
        res.setHeader('Retry-After', '5');
        return res.status(503).json({
          error: 'La protección de esta operación no está disponible temporalmente. Intenta nuevamente.',
          code: 'RATE_LIMIT_STORE_UNAVAILABLE',
          retryAfterSeconds: 5,
        });
      }
      return next();
    }

    const count = Number(bucket.count || 0);
    const resetAt = Number(bucket.resetAt || (Date.now() + windowMs));
    const remaining = Math.max(0, max - count);
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(resetAt / 1000)));

    if (count > max) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: message, retryAfterSeconds });
    }

    return next();
  };
};

module.exports = { createRateLimiter };
