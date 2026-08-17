const express = require('express');
const { randomUUID } = require('crypto');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { loadAcademyEntitlements } = require('../middleware/planAccess');
const { FEATURES } = require('../services/planCatalog');
const {
  resolveEvaluationProfile,
  sanitizeRadarMetrics,
} = require('../services/evaluationCatalog');
const {
  resolveCompetitiveProfile,
  aggregateCompetitiveStats,
} = require('../services/competitiveStatsCatalog');
const {
  getRecognitionCatalog,
  findRecognition,
  sanitizeCustomRecognitions,
} = require('../services/recognitionCatalog');

const router = express.Router();
router.use(authMiddleware, requireDirector, loadAcademyEntitlements);

const safeText = (value, max = 180) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const evaluationCustomizationAllowed = (req) => req.entitlements.features.includes(FEATURES.CUSTOM_EVALUATION_CRITERIA);
const recognitionCustomizationAllowed = (req) => req.entitlements.features.includes(FEATURES.CUSTOM_RECOGNITIONS);

const publicEnrollment = (row) => ({
  id: row.id,
  sede_id: row.sede_id,
  rama_id: row.rama_id,
  categoria_id: row.categoria_id,
  estado: row.estado,
  fecha_inicio: row.fecha_inicio,
  fecha_fin: row.fecha_fin,
  es_principal: row.es_principal,
  monto_matricula: Number(row.monto_matricula || 0),
  monto_mensualidad: Number(row.monto_mensualidad || 0),
  rol_especialidad: row.rol_especialidad || null,
  sede: row.sedes || null,
  rama: row.ramas || null,
  categoria: row.categorias || null,
});

const loadPlayer = async (academyId, playerId) => {
  const { data, error } = await supabase.from('jugadores')
    .select('*')
    .eq('id', playerId)
    .eq('academia_id', academyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Alumno no encontrado.'), { statusCode: 404 });
  return data;
};

const loadEnrollments = async (academyId, playerId) => {
  const { data, error } = await supabase.from('inscripciones_deportivas')
    .select('id,jugador_id,sede_id,rama_id,categoria_id,estado,fecha_inicio,fecha_fin,monto_matricula,monto_mensualidad,es_principal,rol_especialidad,created_at,sedes(id,nombre),ramas(id,nombre,disciplina,config_evaluacion,config_reconocimientos),categorias(id,nombre)')
    .eq('academia_id', academyId)
    .eq('jugador_id', playerId)
    .order('es_principal', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

const selectEnrollment = (enrollments, requestedBranchId) => {
  if (requestedBranchId) {
    const exact = enrollments.find((row) => String(row.rama_id) === String(requestedBranchId));
    if (!exact) throw Object.assign(new Error('El alumno no tiene una inscripción en la rama seleccionada.'), { statusCode: 404 });
    return exact;
  }
  return enrollments.find((row) => row.estado === 'Activa' && row.es_principal)
    || enrollments.find((row) => row.estado === 'Activa')
    || enrollments[0]
    || null;
};

const effectiveRole = (player, enrollment) => safeText(
  enrollment?.rol_especialidad || (enrollment?.es_principal ? player?.posicion_cancha : '') || '',
  120,
);

const buildEvaluationProfile = (req, player, enrollment) => {
  const branch = enrollment?.ramas || {};
  const allowCustom = evaluationCustomizationAllowed(req);
  const customConfig = allowCustom ? (branch.config_evaluacion || {}) : {};
  return resolveEvaluationProfile({
    discipline: branch.disciplina || 'Otro',
    role: effectiveRole(player, enrollment),
    customConfig,
    scopeId: enrollment?.rama_id,
  });
};

const loadBranchEvaluations = async (academyId, playerId, branchId) => {
  const { data, error } = await supabase.from('evaluaciones')
    .select('id,jugador_id,sede_id,rama_id,datos_radar,comentarios_profesor,fecha_evaluacion,created_at,disciplina_codigo,perfil_evaluacion,metricas_version')
    .eq('academia_id', academyId)
    .eq('jugador_id', playerId)
    .eq('rama_id', branchId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data || [];
};

const compatibleEvaluation = (row, profile) => {
  const sanitized = sanitizeRadarMetrics(row?.datos_radar || {}, profile.metrics);
  const hasEveryMetric = Object.keys(sanitized).length === profile.metrics.length;
  if (!hasEveryMetric) return null;
  if (!row?.perfil_evaluacion) return sanitized;
  if (row.perfil_evaluacion !== profile.profileCode) return null;
  if (Number(row.metricas_version || 1) !== Number(profile.metricVersion)) return null;
  return sanitized;
};

const loadCategoryAverage = async (academyId, enrollment, profile) => {
  if (!enrollment?.categoria_id || !enrollment?.rama_id) return { metrics: {}, sample_size: 0 };
  const { data: peers, error: peersError } = await supabase.from('inscripciones_deportivas')
    .select('jugador_id')
    .eq('academia_id', academyId)
    .eq('rama_id', enrollment.rama_id)
    .eq('categoria_id', enrollment.categoria_id)
    .eq('estado', 'Activa');
  if (peersError) throw peersError;
  const playerIds = [...new Set((peers || []).map((row) => row.jugador_id).filter(Boolean))];
  if (!playerIds.length) return { metrics: {}, sample_size: 0 };

  const { data: evaluations, error } = await supabase.from('evaluaciones')
    .select('jugador_id,datos_radar,perfil_evaluacion,metricas_version,created_at')
    .eq('academia_id', academyId)
    .eq('rama_id', enrollment.rama_id)
    .in('jugador_id', playerIds)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const latestByPlayer = new Map();
  for (const row of evaluations || []) {
    if (latestByPlayer.has(row.jugador_id)) continue;
    const metrics = compatibleEvaluation(row, profile);
    if (metrics) latestByPlayer.set(row.jugador_id, metrics);
  }

  const totals = Object.fromEntries(profile.metrics.map((metric) => [metric, 0]));
  const counts = Object.fromEntries(profile.metrics.map((metric) => [metric, 0]));
  for (const metrics of latestByPlayer.values()) {
    for (const metric of profile.metrics) {
      const value = Number(metrics[metric]);
      if (!Number.isFinite(value)) continue;
      totals[metric] += value;
      counts[metric] += 1;
    }
  }
  const average = {};
  for (const metric of profile.metrics) if (counts[metric]) average[metric] = Math.round(totals[metric] / counts[metric]);
  return { metrics: average, sample_size: latestByPlayer.size };
};

const loadCompetitiveStats = async (academyId, playerId, enrollment) => {
  const discipline = enrollment?.ramas?.disciplina || 'Otro';
  const profile = resolveCompetitiveProfile({ discipline });
  if (!enrollment?.rama_id) return aggregateCompetitiveStats(profile, []);

  const { data: matches, error: matchError } = await supabase.from('partidos')
    .select('id')
    .eq('academia_id', academyId)
    .eq('rama_id', enrollment.rama_id);
  if (matchError) throw matchError;
  const matchIds = (matches || []).map((row) => row.id);
  if (!matchIds.length) return aggregateCompetitiveStats(profile, []);

  const { data: rows, error } = await supabase.from('partido_estadisticas')
    .select('partido_id,disciplina_codigo,metricas_competitivas,metricas_version,goles,asistencias,tarjetas_amarillas,tarjetas_rojas,es_mvp,created_at')
    .eq('jugador_id', playerId)
    .in('partido_id', matchIds)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return aggregateCompetitiveStats(profile, rows || []);
};

const loadAttendance = async (academyId, playerId, branchId) => {
  if (!branchId) return { total: 0, presente: 0, ausente: 0, justificado: 0, porcentaje: null };
  const { data: trainings, error: trainingError } = await supabase.from('entrenamientos')
    .select('id')
    .eq('academia_id', academyId)
    .eq('rama_id', branchId);
  if (trainingError) throw trainingError;
  const trainingIds = (trainings || []).map((row) => row.id);
  if (!trainingIds.length) return { total: 0, presente: 0, ausente: 0, justificado: 0, porcentaje: null };

  const { data: rows, error } = await supabase.from('asistencias')
    .select('estado')
    .eq('jugador_id', playerId)
    .in('entrenamiento_id', trainingIds);
  if (error) throw error;
  const summary = { total: 0, presente: 0, ausente: 0, justificado: 0, porcentaje: null };
  for (const row of rows || []) {
    const status = safeText(row.estado, 40).toLowerCase();
    summary.total += 1;
    if (status === 'presente') summary.presente += 1;
    else if (status === 'ausente') summary.ausente += 1;
    else if (status === 'justificado') summary.justificado += 1;
  }
  const considered = summary.presente + summary.ausente + summary.justificado;
  summary.porcentaje = considered ? Math.round(((summary.presente + summary.justificado) / considered) * 100) : null;
  return summary;
};

const normalizeAwards = (input) => (Array.isArray(input) ? input : []).map((item, index) => {
  if (typeof item === 'string') {
    return {
      id: `legacy-${index}`,
      nombre: item,
      fecha: null,
      emoji: '🏅',
      ambito: 'historico',
      origen: 'legacy',
      rama_id: null,
    };
  }
  return item && typeof item === 'object' ? item : null;
}).filter(Boolean);

router.get('/', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const [{ data: players, error: playerError }, { data: enrollments, error: enrollmentError }] = await Promise.all([
      supabase.from('jugadores')
        .select('id,nombre,rut,rut_pasaporte,numero_documento,fecha_nacimiento,foto_base64,foto_url,avatar_url,estado_financiero,alerta_medica,telefono_emergencia,posicion_cancha,insignias')
        .eq('academia_id', academyId)
        .order('nombre'),
      supabase.from('inscripciones_deportivas')
        .select('id,jugador_id,sede_id,rama_id,categoria_id,estado,fecha_inicio,fecha_fin,monto_matricula,monto_mensualidad,es_principal,rol_especialidad,sedes(id,nombre),ramas(id,nombre,disciplina),categorias(id,nombre)')
        .eq('academia_id', academyId)
        .order('created_at', { ascending: true }),
    ]);
    if (playerError) throw playerError;
    if (enrollmentError) throw enrollmentError;

    const byPlayer = new Map();
    for (const row of enrollments || []) {
      const key = String(row.jugador_id);
      const list = byPlayer.get(key) || [];
      list.push(publicEnrollment(row));
      byPlayer.set(key, list);
    }
    return res.json({
      success: true,
      data: (players || []).map((player) => ({
        ...player,
        documento: player.rut || player.rut_pasaporte || player.numero_documento || null,
        inscripciones: byPlayer.get(String(player.id)) || [],
        reconocimientos_total: normalizeAwards(player.insignias).length,
      })),
    });
  } catch (error) {
    console.error('Error cargando alumnos:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible cargar los alumnos.' });
  }
});

router.get('/:id/perfil', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const player = await loadPlayer(academyId, req.params.id);
    const enrollments = await loadEnrollments(academyId, player.id);
    const enrollment = selectEnrollment(enrollments, safeText(req.query.rama_id, 80));
    const awards = normalizeAwards(player.insignias);

    if (!enrollment) {
      return res.json({
        success: true,
        data: {
          alumno: player,
          inscripciones: [],
          inscripcion: null,
          perfil_evaluacion: null,
          evaluaciones: [],
          promedio_categoria: { metrics: {}, sample_size: 0 },
          estadisticas_competitivas: null,
          asistencia: { total: 0, presente: 0, ausente: 0, justificado: 0, porcentaje: null },
          reconocimientos: { catalogo: { standard: [], custom: [], all: [], customization: { allowed: false, active: false } }, otorgados: [], historicos_globales: awards },
          plan: req.entitlements.plan,
        },
      });
    }

    const profile = buildEvaluationProfile(req, player, enrollment);
    const [evaluations, categoryAverage, competitiveStats, attendance] = await Promise.all([
      loadBranchEvaluations(academyId, player.id, enrollment.rama_id),
      loadCategoryAverage(academyId, enrollment, profile),
      loadCompetitiveStats(academyId, player.id, enrollment),
      loadAttendance(academyId, player.id, enrollment.rama_id),
    ]);
    const branchAwards = awards.filter((award) => String(award.rama_id || '') === String(enrollment.rama_id));
    const legacyAwards = awards.filter((award) => !award.rama_id);
    const recognitionCatalog = getRecognitionCatalog({
      discipline: enrollment.ramas?.disciplina || 'Otro',
      customConfig: enrollment.ramas?.config_reconocimientos || {},
      allowCustom: recognitionCustomizationAllowed(req),
    });

    return res.json({
      success: true,
      data: {
        alumno: player,
        inscripciones: enrollments.map(publicEnrollment),
        inscripcion: publicEnrollment(enrollment),
        perfil_evaluacion: {
          ...profile,
          customization: {
            allowed: evaluationCustomizationAllowed(req),
            active: evaluationCustomizationAllowed(req) && Boolean(profile.custom),
            version: profile.custom ? profile.metricVersion : null,
          },
        },
        evaluaciones: evaluations,
        promedio_categoria: categoryAverage,
        estadisticas_competitivas: competitiveStats,
        asistencia: attendance,
        reconocimientos: {
          catalogo: recognitionCatalog,
          otorgados: branchAwards,
          historicos_globales: legacyAwards,
        },
        plan: req.entitlements.plan,
      },
    });
  } catch (error) {
    console.error('Error cargando ficha multirrama:', error?.message || error);
    return res.status(error?.statusCode || 500).json({ error: error?.statusCode ? error.message : 'No fue posible cargar la ficha del alumno.' });
  }
});

router.patch('/:id/ramas/:ramaId', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    await loadPlayer(academyId, req.params.id);
    const role = safeText(req.body?.rol_especialidad, 120) || null;
    const { data, error } = await supabase.from('inscripciones_deportivas')
      .update({ rol_especialidad: role, updated_at: new Date().toISOString() })
      .eq('academia_id', academyId)
      .eq('jugador_id', req.params.id)
      .eq('rama_id', req.params.ramaId)
      .select('id,jugador_id,rama_id,rol_especialidad')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Inscripción del alumno no encontrada.' });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error actualizando especialidad:', error?.message || error);
    return res.status(error?.statusCode || 500).json({ error: error?.statusCode ? error.message : 'No fue posible actualizar el rol o especialidad.' });
  }
});

router.post('/:id/evaluaciones', async (req, res) => {
  try {
    if (!req.entitlements.features.includes(FEATURES.EVALUATIONS)) {
      return res.status(403).json({ error: 'Las evaluaciones no están habilitadas para esta academia.', code: 'FEATURE_NOT_INCLUDED' });
    }
    const academyId = req.user.academia_id;
    const player = await loadPlayer(academyId, req.params.id);
    const enrollments = await loadEnrollments(academyId, player.id);
    const enrollment = selectEnrollment(enrollments, safeText(req.body?.rama_id, 80));
    if (!enrollment || enrollment.estado !== 'Activa') return res.status(409).json({ error: 'La evaluación requiere una inscripción activa en la rama.' });
    const profile = buildEvaluationProfile(req, player, enrollment);
    const metrics = sanitizeRadarMetrics(req.body?.datos_radar || {}, profile.metrics);
    if (Object.keys(metrics).length !== profile.metrics.length) {
      return res.status(400).json({ error: `Completa los ${profile.metrics.length} criterios del radar para esta disciplina.`, code: 'INVALID_EVALUATION_METRICS' });
    }

    const { data, error } = await supabase.from('evaluaciones').insert({
      academia_id: academyId,
      jugador_id: player.id,
      sede_id: enrollment.sede_id,
      rama_id: enrollment.rama_id,
      datos_radar: metrics,
      comentarios_profesor: safeText(req.body?.comentarios_profesor, 3000) || null,
      disciplina_codigo: profile.code,
      perfil_evaluacion: profile.profileCode,
      metricas_version: profile.metricVersion,
      fecha_evaluacion: new Date().toISOString(),
    }).select('*').single();
    if (error) throw error;
    return res.status(201).json({ success: true, data, profile });
  } catch (error) {
    console.error('Error guardando evaluación de alumno:', error?.message || error);
    return res.status(error?.statusCode || 500).json({ error: error?.statusCode ? error.message : 'No fue posible guardar la evaluación.' });
  }
});

router.post('/:id/reconocimientos', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const player = await loadPlayer(academyId, req.params.id);
    const enrollments = await loadEnrollments(academyId, player.id);
    const enrollment = selectEnrollment(enrollments, safeText(req.body?.rama_id, 80));
    if (!enrollment) return res.status(409).json({ error: 'Selecciona una rama para otorgar el reconocimiento.' });
    const allowCustom = recognitionCustomizationAllowed(req);
    const recognition = findRecognition({
      discipline: enrollment.ramas?.disciplina || 'Otro',
      code: safeText(req.body?.recognition_code, 80),
      customConfig: enrollment.ramas?.config_reconocimientos || {},
      allowCustom,
    });
    if (!recognition) return res.status(400).json({ error: 'El reconocimiento seleccionado no está disponible para esta rama.' });

    const awards = normalizeAwards(player.insignias);
    const award = {
      id: randomUUID(),
      codigo: recognition.code,
      nombre: recognition.name,
      emoji: recognition.emoji,
      ambito: recognition.kind,
      descripcion: recognition.description || null,
      origen: recognition.source,
      rama_id: enrollment.rama_id,
      sede_id: enrollment.sede_id,
      disciplina_codigo: resolveCompetitiveProfile({ discipline: enrollment.ramas?.disciplina || 'Otro' }).code,
      fecha: new Date().toISOString(),
      otorgado_por: req.user.id,
    };
    const next = [award, ...awards];
    const { error } = await supabase.from('jugadores')
      .update({ insignias: next })
      .eq('id', player.id)
      .eq('academia_id', academyId);
    if (error) throw error;
    return res.status(201).json({ success: true, data: award });
  } catch (error) {
    console.error('Error otorgando reconocimiento:', error?.message || error);
    return res.status(error?.statusCode || 500).json({ error: error?.statusCode ? error.message : 'No fue posible otorgar el reconocimiento.' });
  }
});

router.delete('/:id/reconocimientos/:awardId', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const player = await loadPlayer(academyId, req.params.id);
    const awards = normalizeAwards(player.insignias);
    const before = awards.length;
    const next = awards.filter((award) => String(award.id) !== String(req.params.awardId));
    if (next.length === before) return res.status(404).json({ error: 'Reconocimiento no encontrado.' });
    const { error } = await supabase.from('jugadores')
      .update({ insignias: next })
      .eq('id', player.id)
      .eq('academia_id', academyId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando reconocimiento:', error?.message || error);
    return res.status(error?.statusCode || 500).json({ error: error?.statusCode ? error.message : 'No fue posible eliminar el reconocimiento.' });
  }
});

router.put('/ramas/:ramaId/reconocimientos-config', async (req, res) => {
  try {
    if (!recognitionCustomizationAllowed(req)) {
      return res.status(403).json({
        error: `Los reconocimientos personalizados están disponibles desde Competencia. Tu plan actual es ${req.entitlements.plan.name}.`,
        code: 'CUSTOM_RECOGNITIONS_NOT_INCLUDED',
        feature: FEATURES.CUSTOM_RECOGNITIONS,
      });
    }
    const items = sanitizeCustomRecognitions({ items: req.body?.items });
    const { data: branch, error: branchError } = await supabase.from('ramas')
      .select('id,nombre,disciplina,config_reconocimientos')
      .eq('id', req.params.ramaId)
      .eq('academia_id', req.user.academia_id)
      .maybeSingle();
    if (branchError) throw branchError;
    if (!branch) return res.status(404).json({ error: 'Rama no encontrada.' });

    const config = { items, updated_at: new Date().toISOString(), updated_by: req.user.id };
    const { data, error } = await supabase.from('ramas')
      .update({ config_reconocimientos: config, updated_at: new Date().toISOString() })
      .eq('id', branch.id)
      .eq('academia_id', req.user.academia_id)
      .select('id,nombre,disciplina,config_reconocimientos')
      .single();
    if (error) throw error;
    return res.json({
      success: true,
      data: {
        branch: data,
        catalog: getRecognitionCatalog({ discipline: data.disciplina, customConfig: data.config_reconocimientos, allowCustom: true }),
      },
    });
  } catch (error) {
    console.error('Error guardando reconocimientos personalizados:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible guardar los reconocimientos personalizados.' });
  }
});

router.delete('/ramas/:ramaId/reconocimientos-config', async (req, res) => {
  try {
    if (!recognitionCustomizationAllowed(req)) {
      return res.status(403).json({ error: 'Los reconocimientos personalizados están disponibles desde Competencia.', code: 'CUSTOM_RECOGNITIONS_NOT_INCLUDED' });
    }
    const { data, error } = await supabase.from('ramas')
      .update({ config_reconocimientos: {}, updated_at: new Date().toISOString() })
      .eq('id', req.params.ramaId)
      .eq('academia_id', req.user.academia_id)
      .select('id,nombre,disciplina,config_reconocimientos')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Rama no encontrada.' });
    return res.json({
      success: true,
      data: {
        branch: data,
        catalog: getRecognitionCatalog({ discipline: data.disciplina, customConfig: {}, allowCustom: true }),
      },
    });
  } catch (error) {
    console.error('Error restaurando reconocimientos:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible restaurar los reconocimientos estándar.' });
  }
});

module.exports = router;
