const defaultKey = (req) => req.user?.id || req.ip || req.socket?.remoteAddress || 'unknown';

const createRateLimiter = ({
  windowMs = 5 * 60 * 1000,
  max = 300,
  keyGenerator = defaultKey,
  message = 'Demasiadas solicitudes. Intenta nuevamente en unos minutos.',
} = {}) => {
  const buckets = new Map();
  let requestCount = 0;

  return (req, res, next) => {
    const now = Date.now();
    requestCount += 1;

    // Limpieza oportunista para mantener memoria acotada sin timers permanentes.
    if (requestCount % 250 === 0) {
      for (const [key, bucket] of buckets.entries()) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    }

    const key = String(keyGenerator(req) || 'unknown');
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: message, retryAfterSeconds });
    }

    return next();
  };
};

module.exports = { createRateLimiter };
