const test = require('node:test');
const assert = require('node:assert/strict');

// El generador PDF es puro. Estas variables ficticias solo permiten cargar el
// cliente Supabase del módulo durante CI; esta prueba nunca realiza consultas.
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key-for-pdf-unit-test';

const { createStudentReportPdf } = require('../services/studentReport');

test('genera un PDF de evolución con contexto de una sola rama', async () => {
  const buffer = await createStudentReportPdf({
    academy: { nombre: 'Academia Demo' },
    player: { nombre: 'Alumno Demo' },
    enrollment: {
      rama_id: 'rama-1',
      rol_especialidad: 'Kumite',
      ramas: { nombre: 'Karate', disciplina: 'Karate' },
      sedes: { nombre: 'Sede Central' },
    },
    categories: [{ id: 'cat-1', nombre: 'Juvenil' }, { id: 'cat-2', nombre: 'Competencia' }],
    discipline: 'Karate',
    evaluationProfile: { label: 'Karate', metrics: ['Técnica', 'Control', 'Velocidad'] },
    currentEvaluation: { metrics: { Técnica: 80, Control: 75, Velocidad: 90 }, comentarios_profesor: 'Buen progreso.' },
    previousEvaluation: { metrics: { Técnica: 70, Control: 70, Velocidad: 82 } },
    attendance: { total: 10, presente: 8, justificado: 1, ausente: 1, porcentaje: 90 },
    competitive: {
      label: 'Karate', activityLabel: 'Participación', participations: 3,
      metrics: [
        { label: 'Victorias', value: 2, decimals: 0, unit: null },
        { label: 'Ippon', value: 1, decimals: 0, unit: null },
      ],
    },
    awards: [{ nombre: 'Espíritu del dojo', fecha: '2026-08-17T12:00:00Z', rama_id: 'rama-1' }],
  }, 'Continuar reforzando la disciplina y la constancia.');

  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 1000);
  assert.equal(buffer.subarray(0, 4).toString('ascii'), '%PDF');
});
