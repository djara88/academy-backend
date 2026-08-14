const test = require('node:test');
const assert = require('node:assert/strict');
const { toProfessorPlayer } = require('../services/professorPlayerView');

test('expone al profesor solo la ficha operativa mínima del jugador', () => {
  const result = toProfessorPlayer({
    id: 'jugador-1',
    nombre: 'Jugador Demo',
    posicion_principal: 'Arquero',
    alerta_medica: 'Usa inhalador',
    contacto_emergencia_telefono: ' +56 9 1111 2222 ',
    nombre_apoderado: 'Dato privado',
    deuda: 45000,
    medicamentos: 'Dato clínico completo',
  });

  assert.deepEqual(result, {
    id: 'jugador-1',
    nombre: 'Jugador Demo',
    posicion_cancha: null,
    posicion_principal: 'Arquero',
    foto_url: null,
    avatar_url: null,
    alerta_medica: 'Usa inhalador',
    telefono_emergencia: '+56 9 1111 2222',
  });
  assert.equal('nombre_apoderado' in result, false);
  assert.equal('deuda' in result, false);
  assert.equal('medicamentos' in result, false);
});

test('admite el teléfono de emergencia heredado y normaliza campos vacíos', () => {
  const result = toProfessorPlayer({
    id: 'jugador-2',
    nombre: 'Jugador Dos',
    alerta_medica: '   ',
    telefono_emergencia: '+56 2 2222 3333',
  });

  assert.equal(result.alerta_medica, null);
  assert.equal(result.telefono_emergencia, '+56 2 2222 3333');
});
