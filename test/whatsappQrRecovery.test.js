const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bridge = fs.readFileSync(path.join(__dirname, '..', 'routes', 'whatsappBridge.js'), 'utf8');
const service = fs.readFileSync(path.join(__dirname, '..', 'services', 'whatsappService.js'), 'utf8');

const route = bridge.split("router.get('/connection/:academiaId/qr'")[1]
  ?.split("// Crea/reutiliza la instancia")[0];

test('QR de WhatsApp exige autenticar identidad y academia, sin caché', () => {
  assert.ok(route, 'Debe existir la ruta explícita para refrescar el QR');
  assert.match(bridge, /router\.get\('\/connection\/:academiaId\/qr', authMiddleware, requireAcademyAccess/);
  assert.match(route, /Cache-Control', 'no-store, private'/);
  assert.match(route, /instanceNameFor\(req\.params\.academiaId\)/);
});

test('consultar QR no elimina sesiones ni crea instancias y no reconecta si ya está abierta', () => {
  assert.match(route, /\/instance\/connectionState\//);
  assert.match(route, /stateResponse\.status === 404/);
  assert.match(route, /WHATSAPP_INSTANCE_NOT_CREATED/);
  assert.match(route, /extractState\(stateData\) === 'open'/);
  assert.match(route, /\/instance\/connect\//);
  assert.doesNotMatch(route, /\/instance\/(delete|logout|create)\//);
});

test('QR todavía pendiente permanece connecting y no desaparece por estado incompleto', () => {
  assert.match(route, /payload\.qrCode \? 'qr' : 'connecting'/);
  assert.match(route, /return res\.status\(502\)/);
  assert.doesNotMatch(route, /JSON\.stringify\(qrData\)/, 'No se debe registrar ni volcar QR en el log');
});

test('el servicio de conexión rechaza explícitamente errores HTTP de Evolution', () => {
  assert.match(service, /if \(!createResponse\.ok\)/);
  assert.match(service, /if \(!connectResponse\.ok\)/);
  assert.match(service, /Evolution API no pudo crear la instancia/);
  assert.match(service, /Evolution API no pudo iniciar la conexión/);
});
