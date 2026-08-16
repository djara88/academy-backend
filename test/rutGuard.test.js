process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-key';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRut, findRutConflict } = require('../services/rutGuard');

const fakeSupabase = ({ players = [], prematriculas = [] } = {}) => ({
  from(table) {
    const data = table === 'jugadores' ? players : prematriculas;
    return {
      select() {
        return {
          eq() {
            return Promise.resolve({ data, error: null });
          },
        };
      },
    };
  },
});

test('normaliza RUT ignorando puntos, guion y espacios', () => {
  assert.equal(normalizeRut('12.345.678-k'), '12345678K');
  assert.equal(normalizeRut(' 1-9 '), '19');
});

test('detecta alumno ya matriculado con el mismo RUT', async () => {
  const conflict = await findRutConflict({
    supabase: fakeSupabase({ players: [{ id: 'p1', nombre: 'Alumno Uno', rut: '12.345.678-5' }] }),
    academiaId: 'a1',
    rut: '12345678-5',
  });
  assert.equal(conflict.code, 'PLAYER_RUT_EXISTS');
  assert.equal(conflict.nombre, 'Alumno Uno');
});

test('detecta otra prematrícula pendiente y permite excluir la que se edita', async () => {
  const prematriculas = [{ id: 'pm1', estado: 'error', jugador_payload: { nombre: 'Alumno Dos', rut: '9.876.543-2' } }];
  const conflict = await findRutConflict({
    supabase: fakeSupabase({ prematriculas }),
    academiaId: 'a1',
    rut: '9876543-2',
  });
  assert.equal(conflict.code, 'PRE_ENROLLMENT_RUT_EXISTS');

  const excluded = await findRutConflict({
    supabase: fakeSupabase({ prematriculas }),
    academiaId: 'a1',
    rut: '9876543-2',
    excludePrematriculaId: 'pm1',
  });
  assert.equal(excluded, null);
});
