const test = require('node:test');
const assert = require('node:assert/strict');
const { generatePlayerReportV2 } = require('../services/playerReportV2');
const { resolveEvaluationProfile } = require('../services/evaluationCatalog');

const countPages = (buffer) => (buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;

test('genera informe de tenis en dos páginas sin depender de estadísticas de fútbol', async () => {
  const sportProfile = resolveEvaluationProfile({ discipline: 'Tenis' });
  const buffer = await generatePlayerReportV2({
    academia: { nombre: 'Academia Multideporte' },
    jugador: {
      nombre: 'Deportista Demo',
      fecha_nacimiento: '2012-05-10',
      posicion_cancha: 'Competitivo',
      tipo_alumno: 'Nuevo',
      categorias: [{ nombre: 'Sub 14' }],
    },
    evaluaciones: [
      {
        created_at: '2026-08-15T12:00:00Z',
        datos_radar: { Saque: 80, Derecha: 76, 'Revés': 71, Volea: 67, Movilidad: 84, 'Toma de decisiones': 79 },
      },
      {
        created_at: '2026-07-15T12:00:00Z',
        datos_radar: { Saque: 72, Derecha: 71, 'Revés': 68, Volea: 63, Movilidad: 78, 'Toma de decisiones': 74 },
      },
    ],
    stats: { partidos_jugados: 5, clases_presente: 12, clases_ausente: 1, clases_justificadas: 1 },
    comentarios: 'Buen progreso técnico y mejor lectura de puntos.',
    sportProfile,
  });

  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 4).toString('ascii'), '%PDF');
  assert.equal(countPages(buffer), 2);
  assert.ok(buffer.length > 4000);
});
