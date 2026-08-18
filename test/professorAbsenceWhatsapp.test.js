const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const professorOps = fs.readFileSync(path.join(__dirname, '..', 'routes', 'professorOps.js'), 'utf8');
const bridge = fs.readFileSync(path.join(__dirname, '..', 'routes', 'whatsappBridge.js'), 'utf8');
const service = fs.readFileSync(path.join(__dirname, '..', 'services', 'absenceFollowupService.js'), 'utf8');

test('profesor dispara seguimiento de ausencia al guardar asistencia', () => {
  assert.match(professorOps, /notifyProfessorAbsences/);
  assert.match(professorOps, /avisos_ausencia/);
});

test('seguimiento evita duplicados por entrenamiento y alumno', () => {
  assert.match(service, /asistencia_seguimientos_whatsapp/);
  assert.match(service, /duplicadas/);
});

test('respuesta WhatsApp del apoderado se captura en Casos', () => {
  assert.match(bridge, /captureAbsenceReply/);
  assert.match(service, /autor_rol: 'apoderado'/);
  assert.match(service, /estado: 'en_revision'/);
});
