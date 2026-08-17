const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const notifierRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'alumnosRecognitionNotifications.js'), 'utf8');
const notifierService = fs.readFileSync(path.join(__dirname, '..', 'services', 'recognitionWhatsapp.js'), 'utf8');

test('notificador de reconocimientos se monta antes de la ficha multirrama', () => {
  const notifierIndex = server.indexOf("app.use('/api/alumnos', alumnosRecognitionNotificationsRoutes)");
  const alumnosIndex = server.indexOf("app.use('/api/alumnos', alumnosRoutes)");
  assert.ok(notifierIndex >= 0);
  assert.ok(alumnosIndex >= 0);
  assert.ok(notifierIndex < alumnosIndex);
});

test('solo intenta WhatsApp después de un reconocimiento exitoso', () => {
  assert.match(notifierRoute, /res\.statusCode < 200 \|\| res\.statusCode >= 300/);
  assert.match(notifierRoute, /notifyRecognitionWhatsapp/);
  assert.match(notifierRoute, /return next\(\)/);
});

test('mensaje nuevo conserva identidad de academia y contexto de disciplina', () => {
  assert.match(notifierService, /academyMessage/);
  assert.match(notifierService, /Disciplina:/);
  assert.match(notifierService, /awardName/);
  assert.match(notifierService, /enviarMensaje\(academyId, phone, message\)/);
});
