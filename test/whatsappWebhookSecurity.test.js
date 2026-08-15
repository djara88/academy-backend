const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isValidWebhookSecret } = require('../middleware/webhookAuth');

test('valida el secreto del webhook con comparacion segura', () => {
  const secret = 'a'.repeat(48);
  assert.equal(isValidWebhookSecret(secret, secret), true);
  assert.equal(isValidWebhookSecret('b'.repeat(48), secret), false);
  assert.equal(isValidWebhookSecret('', secret), false);
  assert.equal(isValidWebhookSecret(secret, 'corto'), false);
});

test('el webhook exige autenticacion y aislamiento por academia', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '../routes/whatsapp.js'), 'utf8');
  const serviceSource = fs.readFileSync(path.join(__dirname, '../services/whatsappService.js'), 'utf8');

  assert.match(routeSource, /router\.post\('\/webhook\/:academiaId', requireWebhookSecret/);
  assert.match(routeSource, /\.eq\('partidos\.academia_id', academiaId\)/);
  assert.match(routeSource, /\.eq\('torneos\.academia_id', academiaId\)/);
  assert.match(serviceSource, /X-Syncademia-Webhook-Secret/);
  assert.match(serviceSource, /headers: webhookHeaders/);
});
