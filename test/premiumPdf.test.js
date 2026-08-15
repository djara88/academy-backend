const test = require('node:test');
const assert = require('node:assert/strict');
const { generateMatriculaPdf, generatePlayerReportPdf, selectEnrollmentTerms } = require('../services/premiumPdf');

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

const assertPdf = (buffer, expectedPages) => {
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 4).toString('ascii'), '%PDF');
  assert.ok(buffer.length > 4000, `PDF demasiado pequeño: ${buffer.length}`);
  assert.ok(buffer.length < 900000, `PDF demasiado pesado: ${buffer.length}`);
  const text = buffer.toString('latin1');
  const pageObjects = text.match(/\/Type\s*\/Page\b/g) || [];
  assert.equal(pageObjects.length, expectedPages, `Se esperaban ${expectedPages} páginas y se generaron ${pageObjects.length}`);
};

test('genera matrícula compacta en exactamente dos páginas', async () => {
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
  assertPdf(buffer, 2);
});

test('genera informe de evolución compacto en exactamente dos páginas', async () => {
  const buffer = await generatePlayerReportPdf({
    academia,
    jugador,
    tutor,
    evaluaciones: [
      { created_at: '2026-08-10T10:00:00Z', datos_radar: { Velocidad: 74, Remate: 62, Pase: 82, Defensa: 69, Físico: 71, Mental: 85 } },
      { created_at: '2026-05-10T10:00:00Z', datos_radar: { Velocidad: 68, Remate: 60, Pase: 76, Defensa: 66, Físico: 69, Mental: 80 } },
    ],
    stats: { partidos_jugados: 8, goles: 3, asistencias: 6, mvp: 1, clases_presente: 18, clases_ausente: 2, clases_justificadas: 1 },
    comentarios: 'Excelente evolución en toma de decisiones, compromiso y juego asociativo.',
  });
  assertPdf(buffer, 2);
});

test('rechaza como términos un informe técnico guardado por error', () => {
  const result = selectEnrollmentTerms({
    terminos_matricula: 'ACADEMIA DE FÚTBOL AXF - INFORME TÉCNICO Y EVALUACIÓN FORMATIVA\nALUMNO: Demo\nOBSERVACIONES Y RECOMENDACIONES',
    terminos_condiciones: 'Condiciones válidas para la matrícula y convivencia de la academia.',
  });
  assert.equal(result, 'Condiciones válidas para la matrícula y convivencia de la academia.');
});
