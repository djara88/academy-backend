const fs = require('fs');

function replaceOnce(text, search, replacement, label) {
  if (!text.includes(search)) throw new Error(`No se encontró bloque: ${label}`);
  return text.replace(search, replacement);
}

let server = fs.readFileSync('server.js','utf8');
server = replaceOnce(server,
  "const systemMetricsRoutes = require('./routes/systemMetrics');",
  "const systemMetricsRoutes = require('./routes/systemMetrics');\nconst estructuraRoutes = require('./routes/estructura');",
  'require estructura');
server = replaceOnce(server,
  "app.use('/api/privacy-requests', privacyRequestRoutes);\napp.use('/api/chat', chatRoutes);",
  "app.use('/api/privacy-requests', privacyRequestRoutes);\napp.use('/api/estructura', estructuraRoutes);\napp.use('/api/chat', chatRoutes);",
  'mount estructura');
fs.writeFileSync('server.js', server);

let enrollment = fs.readFileSync('services/enrollmentService.js','utf8');
enrollment = replaceOnce(enrollment,
  "const { normalizeRut } = require('./rutGuard');",
  "const { normalizeRut } = require('./rutGuard');\nconst { resolveStructure } = require('./academyStructure');",
  'import resolve');
enrollment = replaceOnce(enrollment,
  "  const emergencia = payload.emergencia || {};\n\n  const { data: academy",
  "  const emergencia = payload.emergencia || {};\n  const structure = await resolveStructure({ academiaId, sedeId: jugador.sede_id || null, ramaId: jugador.rama_id || null });\n\n  const { data: academy",
  'resolve structure');
enrollment = replaceOnce(enrollment,
  "      academia_id: academiaId,\n      tutor_id: tutorId,",
  "      academia_id: academiaId,\n      sede_id: structure.sede_id,\n      rama_id: structure.rama_id,\n      tutor_id: tutorId,",
  'player structure');
enrollment = enrollment.replace("        academia_id: academiaId,\n        datos_radar:", "        academia_id: academiaId,\n        sede_id: structure.sede_id,\n        rama_id: structure.rama_id,\n        datos_radar:");
enrollment = enrollment.replace("        academia_id: academiaId,\n        jugador_id: newPlayer.id,\n        concepto,", "        academia_id: academiaId,\n        sede_id: structure.sede_id,\n        rama_id: structure.rama_id,\n        jugador_id: newPlayer.id,\n        concepto,");
enrollment = enrollment.replaceAll("        academia_id: academiaId,\n        jugador_id: newPlayer.id,\n        prenda_id:", "        academia_id: academiaId,\n        sede_id: structure.sede_id,\n        rama_id: structure.rama_id,\n        jugador_id: newPlayer.id,\n        prenda_id:");
fs.writeFileSync('services/enrollmentService.js', enrollment);

let billing = fs.readFileSync('services/monthlyBilling.js','utf8');
billing = replaceOnce(billing,
  ".select('id,nombre,monto_mensualidad,fecha_matricula,created_at,estado_matricula')",
  ".select('id,nombre,monto_mensualidad,fecha_matricula,created_at,estado_matricula,sede_id,rama_id')",
  'billing select');
billing = replaceOnce(billing,
  "    academia_id: academyId,\n    jugador_id: player.id,",
  "    academia_id: academyId,\n    sede_id: player.sede_id || null,\n    rama_id: player.rama_id || null,\n    jugador_id: player.id,",
  'billing insert');
fs.writeFileSync('services/monthlyBilling.js', billing);

console.log('Multisite backend patch applied');
