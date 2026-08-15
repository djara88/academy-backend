const test = require('node:test');
const assert = require('node:assert/strict');
const { generateMatriculaPdf, generatePlayerReportPdf } = require('../services/premiumPdf');

const academia = {
  nombre: 'Academia Demo Elite',
  direccion: 'Complejo Deportivo Central',
  telefono: '+56 9 1234 5678',
  director_email: 'direccion@example.com',
  nombre_director: 'Dirección Deportiva',
  dias_entrenamiento: 'Martes y jueves',
  horarios_entrenamiento: '18:00 - 20:00',
  ubicacion_entrenamiento: 'Cancha Principal',
  terminos_matricula: '1. Respetar el reglamento interno.\n2. Mantener datos de contacto actualizados.',
};

const jugador = {
  nombre: 'Alumno Demostración',
  rut: '12345678-5',
  fecha_nacimiento: '2014-03-12',
  posicion_cancha: 'Mediocampista',
  tipo_alumno: 'Nuevo',
  certificado_medico: 'Entregado',
  monto_matricula: 45000,
  abono_matricula: 25000,
  monto_mensualidad: 35000,
  categorias: [{ id: 'cat-1', nombre: 'Sub 12' }],
  insignias: [{ id: '1', nombre: 'Premio al Compañerismo', fecha: new Date().toISOString() }],
};

const tutor = {
  nombre_completo: 'Apoderado Demostración',
  rut: '11111111-1',
  email: 'apoderado@example.com',
  telefono: '+56 9 8765 4321',
};

const assertPdf = (buffer) => {
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 4).toString('ascii'), '%PDF');
  assert.ok(buffer.length > 4000, `PDF demasiado pequeño: ${buffer.length}`);
};

test('genera matrícula premium como PDF nativo', async () => {
  const buffer = await generateMatriculaPdf({
    academia,
    jugador,
    tutor,
    folio: 'MAT-2026-000001',
    consentimientos: [
      { tipo: 'aviso_privacidad', estado: 'aceptado' },
      { tipo: 'datos_salud', estado: 'rechazado' },
      { tipo: 'imagen_interna', estado: 'aceptado' },
      { tipo: 'imagen_publica', estado: 'rechazado' },
    ],
  });
  assertPdf(buffer);
  assert.ok(buffer.length > 9000);
});

test('genera informe de evolución como PDF nativo', async () => {
  const buffer = await generatePlayerReportPdf({
    academia,
    jugador,
    tutor,
    evaluaciones: [
      { datos_radar: { Velocidad: 74, Remate: 62, Pase: 82, Defensa: 69, Físico: 71, Mental: 85 } },
      { datos_radar: { Velocidad: 68, Remate: 60, Pase: 76, Defensa: 66, Físico: 69, Mental: 80 } },
    ],
    stats: { partidos_jugados: 8, goles: 3, asistencias: 6, mvp: 1, clases_presente: 18, clases_ausente: 2 },
    comentarios: 'Excelente evolución en toma de decisiones, compromiso y juego asociativo.',
  });
  assertPdf(buffer);
  assert.ok(buffer.length > 8000);
});
