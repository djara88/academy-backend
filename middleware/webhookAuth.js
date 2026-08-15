const crypto = require('crypto');

const WEBHOOK_HEADER = 'x-syncademia-webhook-secret';

const safeEqual = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const isValidWebhookSecret = (provided, expected = process.env.WHATSAPP_WEBHOOK_SECRET) => {
  if (!expected || expected.length < 32) return false;
  return safeEqual(provided, expected);
};

const requireWebhookSecret = (req, res, next) => {
  const expected = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!expected || expected.length < 32) {
    console.error('WHATSAPP_WEBHOOK_SECRET no esta configurado o es demasiado corto.');
    return res.status(503).json({ error: 'Webhook temporalmente no disponible' });
  }

  const provided = req.get(WEBHOOK_HEADER);
  if (!isValidWebhookSecret(provided, expected)) {
    console.warn('Webhook de WhatsApp rechazado por autenticacion invalida.');
    return res.status(401).json({ error: 'Webhook no autorizado' });
  }

  return next();
};

module.exports = {
  WEBHOOK_HEADER,
  isValidWebhookSecret,
  requireWebhookSecret,
};
