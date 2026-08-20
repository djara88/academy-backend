const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector, requireProfessor } = require('../middleware/professorAccess');
const { toProfessorPlayer } = require('../services/professorPlayerView');
const { buildAttendanceAlertRows } = require('../services/attendanceAlerts');
const { getCategoryContext, getStudentsForScope } = require('../services/branchContext');
const { notifyProfessorAbsences, closeCorrectedAbsenceFollowups } = require('../services/absenceFollowupService');
const {
  COMPETITIVE_STATS_VERSION,
  publicProfile,
  resolveCompetitiveProfile,
  sanitizeCompetitiveMetrics,
  metricsFromRow,
  legacyStatColumns,
} = require('../services/competitiveStatsCatalog');

const router = express.Router();
const ATTENDANCE_STATES = new Set(['Presente', 'Ausente', 'Justificado']);
const CASE_TYPES = new Set(['seguimiento', 'conducta', 'salud', 'asistencia', 'familiar', 'operativo', 'feedback', 'otro']);
const CASE_PRIORITIES = new Set(['baja', 'normal', 'alta', 'urgente']);
const CASE_STATES = new Set(['abierto', 'en_revision', 'resuelto']);

const cleanText = (value) => String(value || '').trim();
const cleanLimitedText = (value, maxLength) => cleanText(value).slice(0, maxLength);
const uniqueIds = (values) => [...new Set((Array.isArray(values) ? values : [])
  .filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
  .map((value) => String(value).trim()))];
const todayInChile = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const addDays = (date, days) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const clampScore = (value, fallback = 0) => {
  if (value === undefined || value === null || value === '') return Math.max(0, Number(fallback) || 0);
  const number = Number(value);
  if (!Number.isFinite(number)) return Math.max(0, Number(fallback) || 0);
  return Math.min(9999, Math.max(0, Math.round(number)));
};

const requireAssignedCategory = async (user, categoryId) => {
  const { data, error } = await supabase.from('profesor_categorias')
    .select('id').eq('academia_id', user.academia_id).eq('profesor_id', user.id)
    .eq('categoria_id', categoryId).eq('activo', true).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Esta categoría no está asignada a tu perfil.'), { status: 403 });
  return getCategoryContext(user.academia_id, categoryId);
};

const getCategoryStudents = async (user, categoryId) => {
  const { category } = await requireAssignedCategory(user, categoryId);
  const students = await getStudentsForScope({
    academyId: user.academia_id,
    branchId: category.rama_id,
    categoryId: category.id,
    playerSelect: 'id,nombre,posicion_cancha,posicion_principal,foto_url,avatar_url,alerta_medica,telefono_emergencia,contacto_emergencia_telefono',
  });
  return {
    category,
    students: students.map((student) => ({
      ...toProfessorPlayer(student),
      rol_especialidad: student.inscripcion?.rol_especialidad || null,
      inscripcion_id: student.inscripcion?.id || null,
    })).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
  };
};

const requireAssignedMatch = async (user, matchId) => {
  const { data, error } = await supabase.from('partidos')
    .select('id,academia_id,categoria_id,sede_id,rama_id,rival,fecha,hora,hora_citacion,ubicacion,link_maps,color_uniforme,estado,es_amistoso,condicion,goles_favor,goles_contra,disciplina_codigo,en_vivo,live_etapa,live_started_at,live_finished_at,live_updated_at,live_updated_by,categorias(id,nombre,rama_id),ramas(id,nombre,disciplina),sedes(id,nombre)')
    .eq('id', matchId).eq('academia_id', user.academia_id).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Encuentro no encontrado.'), { status: 404 });
  if (!data.categoria_id || !data.rama_id) throw Object.assign(new Error('El encuentro no está correctamente vinculado a una rama y categoría.'), { status: 409 });
  const { category } = await requireAssignedCategory(user, data.categoria_id);
  if (String(category.rama_id) !== String(data.rama_id)) throw Object.assign(new Error('La categoría del encuentro no coincide con su rama.'), { status: 409 });
  return data;
};

const resolveMatchProfile = (match) => resolveCompetitiveProfile({
  discipline: match.ramas?.disciplina,
  code: match.disciplina_codigo,
});

const logLiveEvent = async ({ user, matchId, action, playerId = null, detail = {} }) => {
  const { error } = await supabase.from('partido_live_eventos').insert({
    academia_id: user.academia_id,
    partido_id: matchId,
    profesor_id: user.id,
    jugador_id: playerId,
    accion: action,
    detalle: detail,
  });
  if (error) console.error('No se pudo registrar evento en vivo:', error.message);
};

const chooseTrainingForAttendance = (rows = []) => {
  const available = rows.filter((row) => row.estado !== 'Cancelado');
  return available.find((row) => row.estado === 'Realizado')
    || available.find((row) => row.estado === 'Programado')
    || available[0]
    || null;
};

const refreshAttendanceAlerts = async ({ academyId, categoryId, playerIds }) => {
  const { data: trainings, error: trainingError } = await supabase.from('entrenamientos')
    .select('id,fecha,created_at').eq('academia_id', academyId).eq('categoria_id', categoryId)
    .eq('estado', 'Realizado').order('fecha', { ascending: false }).order('created_at', { ascending: false }).limit(20);
  if (trainingError) throw trainingError;
  const trainingIds = (trainings || []).map((item) => item.id);
  if (!trainingIds.length || !playerIds.length) return 0;
  const [{ data: attendance, error: attendanceError }, { data: existing, error: existingError }] = await Promise.all([
    supabase.from('asistencias').select('entrenamiento_id,jugador_id,estado').in('entrenamiento_id', trainingIds).in('jugador_id', playerIds),
    supabase.from('alertas_asistencia').select('jugador_id,racha,activa,detectada_at,revisada_at,revisada_por')
      .eq('academia_id', academyId).eq('categoria_id', categoryId).in('jugador_id', playerIds),
  ]);
  if (attendanceError) throw attendanceError;
  if (existingError) throw existingError;
  const calculated = buildAttendanceAlertRows({ academyId, categoryId, playerIds, trainings: trainings || [], attendance: attendance || [], existingAlerts: existing || [] });
  const rows = calculated.map(({ newly_activated: _newlyActivated, ...row }) => row);
  const { error: upsertError } = await supabase.from('alertas_asistencia').upsert(rows, { onConflict: 'academia_id,categoria_id,jugador_id,tipo' });
  if (upsertError) throw upsertError;
  return calculated.filter((row) => row.newly_activated).length;
};

const getAssignedCategoryIds = async (user) => {
  const { data, error } = await supabase.from('profesor_categorias').select('categoria_id')
    .eq('academia_id', user.academia_id).eq('profesor_id', user.id).eq('activo', true);
  if (error) throw error;
  return uniqueIds((data || []).map((item) => item.categoria_id));
};

const decorateCases = async (academyId, cases = []) => {
  if (!cases.length) return [];
  const categoryIds = uniqueIds(cases.map((item) => item.categoria_id));
  const playerIds = uniqueIds(cases.map((item) => item.jugador_id));
  const professorIds = uniqueIds(cases.map((item) => item.profesor_id));
  const caseIds = uniqueIds(cases.map((item) => item.id));
  const [categoryResult, playerResult, professorResult, messageResult] = await Promise.all([
    categoryIds.length ? supabase.from('categorias').select('id,nombre,rama_id,ramas(id,nombre,disciplina)').eq('academia_id', academyId).in('id', categoryIds) : Promise.resolve({ data: [], error: null }),
    playerIds.length ? supabase.from('jugadores').select('id,nombre,foto_url,avatar_url').eq('academia_id', academyId).in('id', playerIds) : Promise.resolve({ data: [], error: null }),
    professorIds.length ? supabase.from('usuarios').select('id,nombre_completo').eq('academia_id', academyId).in('id', professorIds) : Promise.resolve({ data: [], error: null }),
    caseIds.length ? supabase.from('profesor_caso_mensajes').select('caso_id,autor_rol,mensaje,created_at').eq('academia_id', academyId).in('caso_id', caseIds).order('created_at', { ascending: false }) : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of [categoryResult, playerResult, professorResult, messageResult]) if (result.error) throw result.error;
  const categories = new Map((categoryResult.data || []).map((item) => [String(item.id), item]));
  const players = new Map((playerResult.data || []).map((item) => [String(item.id), item]));
  const professors = new Map((professorResult.data || []).map((item) => [String(item.id), item]));
  const messagesByCase = new Map();
  for (const message of messageResult.data || []) {
    const key = String(message.caso_id);
    const current = messagesByCase.get(key) || [];
    current.push(message);
    messagesByCase.set(key, current);
  }
  return cases.map((item) => {
    const messages = messagesByCase.get(String(item.id)) || [];
    return {
      ...item,
      categoria: item.categoria_id ? categories.get(String(item.categoria_id)) || null : null,
      jugador: item.jugador_id ? players.get(String(item.jugador_id)) || null : null,
      profesor: item.profesor_id ? professors.get(String(item.profesor_id)) || null : null,
      mensajes_total: messages.length,
      ultimo_mensaje: messages[0] || null,
    };
  });
};

const getProfessorCase = async (user, caseId) => {
  const { data, error } = await supabase.from('profesor_casos').select('*')
    .eq('id', caseId).eq('academia_id', user.academia_id).eq('profesor_id', user.id).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Caso no encontrado.'), { status: 404 });
  return data;
};

const getDirectorCase = async (user, caseId) => {
  const { data, error } = await supabase.from('profesor_casos').select('*')
    .eq('id', caseId).eq('academia_id', user.academia_id).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Caso no encontrado.'), { status: 404 });
  return data;
};

const getCaseMessages = async (academyId, caseId) => {
  const { data, error } = await supabase.from('profesor_caso_mensajes')
    .select('id,caso_id,autor_id,autor_rol,mensaje,created_at').eq('academia_id', academyId).eq('caso_id', caseId).order('created_at');
  if (error) throw error;
  const authorIds = uniqueIds((data || []).map((item) => item.autor_id));
  let authorMap = new Map();
  if (authorIds.length) {
    const result = await supabase.from('usuarios').select('id,nombre_completo').eq('academia_id', academyId).in('id', authorIds);
    if (result.error) throw result.error;
    authorMap = new Map((result.data || []).map((item) => [String(item.id), item.nombre_completo]));
  }
  return (data || []).map((item) => ({ ...item, autor_nombre: authorMap.get(String(item.autor_id)) || (item.autor_rol === 'director' ? 'Dirección' : item.autor_rol === 'apoderado' ? 'Apoderado/a' : 'Profesor') }));
};

// Agenda enriquecida: mantiene la misma ruta y agrega contexto para acciones rápidas y operación en vivo.
router.get('/me/agenda', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const from = String(req.query?.desde || todayInChile());
    const to = String(req.query?.hasta || addDays(from, 60));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from || to > addDays(from, 120)) {
      return res.status(400).json({ error: 'El rango de agenda es inválido o supera 120 días.' });
    }
    const categoryIds = await getAssignedCategoryIds(req.user);
    if (!categoryIds.length) return res.json({ success: true, data: [], rango: { desde: from, hasta: to } });
    const [{ data: trainings, error: trainingError }, { data: matches, error: matchError }] = await Promise.all([
      supabase.from('entrenamientos')
        .select('id,categoria_id,sede_id,rama_id,fecha,hora,lugar,estado,es_recuperacion,categorias(id,nombre),ramas(id,nombre,disciplina),sedes(id,nombre)')
        .eq('academia_id', req.user.academia_id).in('categoria_id', categoryIds).gte('fecha', from).lte('fecha', to).order('fecha').order('hora'),
      supabase.from('partidos')
        .select('id,categoria_id,sede_id,rama_id,rival,fecha,hora,hora_citacion,ubicacion,link_maps,color_uniforme,estado,es_amistoso,condicion,goles_favor,goles_contra,disciplina_codigo,en_vivo,live_etapa,live_started_at,live_updated_at,categorias(id,nombre),ramas(id,nombre,disciplina),sedes(id,nombre)')
        .eq('academia_id', req.user.academia_id).in('categoria_id', categoryIds).gte('fecha', from).lte('fecha', to).order('fecha').order('hora'),
    ]);
    if (trainingError) throw trainingError;
    if (matchError) throw matchError;
    const trainingIds = (trainings || []).map((item) => item.id);
    const matchIds = (matches || []).map((item) => item.id);
    const [logs, preparations] = await Promise.all([
      trainingIds.length ? supabase.from('entrenamiento_bitacoras').select('entrenamiento_id').eq('academia_id', req.user.academia_id).in('entrenamiento_id', trainingIds) : Promise.resolve({ data: [], error: null }),
      matchIds.length ? supabase.from('partido_preparaciones').select('partido_id,estado').eq('academia_id', req.user.academia_id).in('partido_id', matchIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (logs.error) throw logs.error;
    if (preparations.error) throw preparations.error;
    const logged = new Set((logs.data || []).map((item) => String(item.entrenamiento_id)));
    const prepMap = new Map((preparations.data || []).map((item) => [String(item.partido_id), item.estado]));
    const events = [
      ...(trainings || []).map((item) => ({ ...item, tipo: 'Entrenamiento', bitacora_completa: logged.has(String(item.id)) })),
      ...(matches || []).map((item) => ({
        ...item,
        tipo: 'Partido',
        preparacion_estado: prepMap.get(String(item.id)) || null,
        sport_profile: publicProfile(resolveCompetitiveProfile({ discipline: item.ramas?.disciplina, code: item.disciplina_codigo })),
      })),
    ].sort((a, b) => `${a.fecha} ${a.hora || ''}`.localeCompare(`${b.fecha} ${b.hora || ''}`));
    return res.json({ success: true, data: events, rango: { desde: from, hasta: to }, hoy: todayInChile() });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible cargar la agenda.' });
  }
});

// Asistencia corregida: reutiliza entrenamiento programado del día en vez de crear duplicados.
router.get('/me/categorias/:categoriaId/asistencia', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const date = cleanText(req.query?.fecha) || todayInChile();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Fecha inválida.' });
    const { category, students } = await getCategoryStudents(req.user, req.params.categoriaId);
    const trainingResult = await supabase.from('entrenamientos')
      .select('id,hora,lugar,estado,created_at,sede_id,rama_id')
      .eq('academia_id', req.user.academia_id).eq('categoria_id', category.id).eq('rama_id', category.rama_id)
      .eq('fecha', date).order('created_at', { ascending: false });
    if (trainingResult.error) throw trainingResult.error;
    const training = chooseTrainingForAttendance(trainingResult.data || []);
    let attendance = [];
    if (training) {
      const result = await supabase.from('asistencias').select('jugador_id,estado').eq('entrenamiento_id', training.id);
      if (result.error) throw result.error;
      attendance = result.data || [];
    }
    const byPlayer = new Map(attendance.map((item) => [String(item.jugador_id), item.estado]));
    return res.json({ success: true, data: {
      fecha: date,
      entrenamiento: training,
      categoria: category,
      jugadores: students.map((student) => ({ ...student, estado_asistencia: byPlayer.get(String(student.id)) || null })),
    } });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible cargar la asistencia.' });
  }
});

router.post('/me/categorias/:categoriaId/asistencia', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const date = cleanText(req.body?.fecha);
    const items = Array.isArray(req.body?.asistencias) ? req.body.asistencias : [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !items.length) return res.status(400).json({ error: 'La fecha y la lista de asistencia son obligatorias.' });
    if (items.some((item) => !item.jugador_id || !ATTENDANCE_STATES.has(item.estado))) return res.status(400).json({ error: 'La lista contiene estados de asistencia inválidos.' });
    const { category, students } = await getCategoryStudents(req.user, req.params.categoriaId);
    const allowed = new Set(students.map((student) => String(student.id)));
    if (items.some((item) => !allowed.has(String(item.jugador_id)))) return res.status(403).json({ error: 'La lista contiene un alumno ajeno a la inscripción activa de esta rama/categoría.' });

    const trainingResult = await supabase.from('entrenamientos').select('id,hora,lugar,estado,created_at')
      .eq('academia_id', req.user.academia_id).eq('categoria_id', category.id).eq('rama_id', category.rama_id)
      .eq('fecha', date).order('created_at', { ascending: false });
    if (trainingResult.error) throw trainingResult.error;
    let training = chooseTrainingForAttendance(trainingResult.data || []);
    if (training) {
      if (training.estado !== 'Realizado') {
        const result = await supabase.from('entrenamientos').update({ estado: 'Realizado', registrado_por: req.user.id }).eq('id', training.id).select('id,hora,lugar,estado').single();
        if (result.error) throw result.error;
        training = result.data;
      }
    } else {
      const result = await supabase.from('entrenamientos').insert({
        academia_id: req.user.academia_id,
        categoria_id: category.id,
        sede_id: category.sede_id,
        rama_id: category.rama_id,
        fecha: date,
        hora: new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Santiago' }),
        estado: 'Realizado',
        es_recuperacion: false,
        registrado_por: req.user.id,
      }).select('id,hora,lugar,estado').single();
      if (result.error) throw result.error;
      training = result.data;
    }
    const rows = items.map((item) => ({ entrenamiento_id: training.id, jugador_id: item.jugador_id, estado: item.estado, registrado_por: req.user.id, actualizado_at: new Date().toISOString() }));
    const { error: attendanceError } = await supabase.from('asistencias').upsert(rows, { onConflict: 'entrenamiento_id,jugador_id' });
    if (attendanceError) throw attendanceError;
    let activatedAlerts = 0;
    try {
      activatedAlerts = await refreshAttendanceAlerts({ academyId: req.user.academia_id, categoryId: category.id, playerIds: items.map((item) => String(item.jugador_id)) });
    } catch (alertError) {
      console.error('No se pudieron actualizar las alertas de asistencia:', alertError?.message || alertError);
    }
    let absenceFollowup = { solicitadas: 0, enviadas: 0, omitidas: 0, fallidas: 0, duplicadas: 0, casos_creados: 0 };
    try {
      await closeCorrectedAbsenceFollowups({
        academyId: req.user.academia_id, professorId: req.user.id, trainingId: training.id, attendance: items,
      });
      absenceFollowup = await notifyProfessorAbsences({
        academyId: req.user.academia_id,
        professorId: req.user.id,
        category,
        training: { ...training, fecha: date },
        attendance: items,
      });
    } catch (followupError) {
      console.error('No se pudo completar el seguimiento WhatsApp de inasistencia:', followupError?.message || followupError);
      absenceFollowup.fallidas = items.filter((item) => item.estado === 'Ausente').length;
      absenceFollowup.solicitadas = absenceFollowup.fallidas;
    }
    await supabase.from('usuarios').update({ ultimo_acceso: new Date().toISOString() }).eq('id', req.user.id);
    const whatsappSummary = absenceFollowup.solicitadas > 0
      ? ` WhatsApp: ${absenceFollowup.enviadas} consulta${absenceFollowup.enviadas === 1 ? '' : 's'} enviada${absenceFollowup.enviadas === 1 ? '' : 's'}${absenceFollowup.duplicadas ? `, ${absenceFollowup.duplicadas} ya notificada${absenceFollowup.duplicadas === 1 ? '' : 's'}` : ''}${absenceFollowup.omitidas ? `, ${absenceFollowup.omitidas} sin teléfono` : ''}${absenceFollowup.fallidas ? `, ${absenceFollowup.fallidas} con error` : ''}.`
      : '';
    return res.json({ success: true, message: `Asistencia guardada: ${items.length} alumnos.${whatsappSummary}`, entrenamiento_id: training.id, alertas_generadas: activatedAlerts, avisos_ausencia: absenceFollowup });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible guardar la asistencia.' });
  }
});

// Operación de encuentros en vivo.
router.get('/me/partidos/:partidoId/en-vivo', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const match = await requireAssignedMatch(req.user, req.params.partidoId);
    const profile = resolveMatchProfile(match);
    const { students } = await getCategoryStudents(req.user, match.categoria_id);
    const preparationResult = await supabase.from('partido_preparaciones').select('id,estado')
      .eq('academia_id', req.user.academia_id).eq('partido_id', match.id).maybeSingle();
    if (preparationResult.error) throw preparationResult.error;
    let plan = [];
    if (preparationResult.data) {
      const result = await supabase.from('partido_plan_jugadores').select('jugador_id,rol,posicion,orden')
        .eq('preparacion_id', preparationResult.data.id).order('orden');
      if (result.error) throw result.error;
      plan = result.data || [];
    }
    const playerIds = students.map((student) => student.id);
    const statsResult = playerIds.length ? await supabase.from('partido_estadisticas').select('*').eq('partido_id', match.id).in('jugador_id', playerIds) : { data: [], error: null };
    if (statsResult.error) throw statsResult.error;
    const statsMap = new Map((statsResult.data || []).map((row) => [String(row.jugador_id), row]));
    const planMap = new Map(plan.map((row) => [String(row.jugador_id), row]));
    const roster = students.map((student) => {
      const planned = planMap.get(String(student.id));
      const stat = statsMap.get(String(student.id));
      return {
        id: student.id,
        nombre: student.nombre,
        foto_url: student.foto_url,
        avatar_url: student.avatar_url,
        posicion: planned?.posicion || student.rol_especialidad || student.posicion_principal || student.posicion_cancha || '',
        rol_plan: planned?.rol || null,
        orden_plan: planned?.orden ?? null,
        metricas: stat ? metricsFromRow(stat, profile) : {},
        es_mvp: Boolean(stat?.es_mvp),
      };
    }).sort((a, b) => {
      const aOrder = a.orden_plan ?? 999;
      const bOrder = b.orden_plan ?? 999;
      return aOrder - bOrder || a.nombre.localeCompare(b.nombre, 'es');
    });
    const eventsResult = await supabase.from('partido_live_eventos').select('id,accion,jugador_id,detalle,created_at')
      .eq('academia_id', req.user.academia_id).eq('partido_id', match.id).order('created_at', { ascending: false }).limit(30);
    if (eventsResult.error) throw eventsResult.error;
    return res.json({ success: true, data: {
      partido: match,
      sport_profile: publicProfile(profile),
      jugadores: roster,
      eventos: eventsResult.data || [],
      puede_iniciar: match.fecha === todayInChile() && match.estado !== 'Jugado' && match.estado !== 'Cancelado',
    } });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible cargar el encuentro en vivo.' });
  }
});

router.post('/me/partidos/:partidoId/en-vivo/iniciar', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const match = await requireAssignedMatch(req.user, req.params.partidoId);
    if (match.estado === 'Jugado') return res.status(409).json({ error: 'El encuentro ya está finalizado.' });
    if (match.estado === 'Cancelado') return res.status(409).json({ error: 'El encuentro está cancelado.' });
    if (match.fecha !== todayInChile() && !match.en_vivo) return res.status(409).json({ error: 'El modo en vivo solo puede iniciarse el día del encuentro.' });
    const now = new Date().toISOString();
    const stage = cleanLimitedText(req.body?.etapa, 60) || match.live_etapa || 'En juego';
    const { data, error } = await supabase.from('partidos').update({
      en_vivo: true,
      estado: 'En vivo',
      live_etapa: stage,
      live_started_at: match.live_started_at || now,
      live_updated_at: now,
      live_updated_by: req.user.id,
      live_finished_at: null,
    }).eq('id', match.id).eq('academia_id', req.user.academia_id).select('*').single();
    if (error) throw error;
    await logLiveEvent({ user: req.user, matchId: match.id, action: 'inicio', detail: { etapa: stage, score: [Number(match.goles_favor) || 0, Number(match.goles_contra) || 0] } });
    return res.json({ success: true, message: 'Encuentro iniciado en vivo.', data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible iniciar el encuentro.' });
  }
});

router.patch('/me/partidos/:partidoId/en-vivo', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const match = await requireAssignedMatch(req.user, req.params.partidoId);
    if (!match.en_vivo || match.estado === 'Jugado') return res.status(409).json({ error: 'El encuentro no está activo en modo en vivo.' });
    const profile = resolveMatchProfile(match);
    const stageProvided = req.body?.etapa !== undefined;
    const stage = stageProvided ? cleanLimitedText(req.body.etapa, 60) : match.live_etapa;
    const favor = profile.usesHeadToHeadScore ? clampScore(req.body?.resultado_favor, match.goles_favor) : Number(match.goles_favor) || 0;
    const contra = profile.usesHeadToHeadScore ? clampScore(req.body?.resultado_contra, match.goles_contra) : Number(match.goles_contra) || 0;
    const now = new Date().toISOString();
    const { data, error } = await supabase.from('partidos').update({
      ...(profile.usesHeadToHeadScore ? { goles_favor: favor, goles_contra: contra } : {}),
      ...(stageProvided ? { live_etapa: stage } : {}),
      live_updated_at: now,
      live_updated_by: req.user.id,
    }).eq('id', match.id).eq('academia_id', req.user.academia_id).select('*').single();
    if (error) throw error;
    const scoreChanged = favor !== (Number(match.goles_favor) || 0) || contra !== (Number(match.goles_contra) || 0);
    if (scoreChanged) await logLiveEvent({ user: req.user, matchId: match.id, action: 'marcador', detail: { favor, contra, etiqueta: profile.scoreLabel } });
    if (stageProvided && stage !== match.live_etapa) await logLiveEvent({ user: req.user, matchId: match.id, action: 'etapa', detail: { etapa: stage } });
    return res.json({ success: true, data, sport_profile: publicProfile(profile) });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible actualizar el encuentro en vivo.' });
  }
});

router.put('/me/partidos/:partidoId/en-vivo/estadisticas/:jugadorId', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const match = await requireAssignedMatch(req.user, req.params.partidoId);
    if (!match.en_vivo || match.estado === 'Jugado') return res.status(409).json({ error: 'El encuentro no está activo en modo en vivo.' });
    const profile = resolveMatchProfile(match);
    const { students } = await getCategoryStudents(req.user, match.categoria_id);
    const player = students.find((item) => String(item.id) === String(req.params.jugadorId));
    if (!player) return res.status(403).json({ error: 'El alumno no pertenece a tu categoría asignada.' });
    const existingResult = await supabase.from('partido_estadisticas').select('*').eq('partido_id', match.id).eq('jugador_id', player.id).maybeSingle();
    if (existingResult.error) throw existingResult.error;
    const currentMetrics = existingResult.data ? metricsFromRow(existingResult.data, profile) : {};
    const inputMetrics = req.body?.metricas && typeof req.body.metricas === 'object' ? req.body.metricas : {};
    const metrics = sanitizeCompetitiveMetrics({ ...currentMetrics, ...inputMetrics }, profile);
    const wantsMvp = req.body?.es_mvp === true;
    if (wantsMvp) {
      const { error: clearError } = await supabase.from('partido_estadisticas').update({ es_mvp: false }).eq('partido_id', match.id);
      if (clearError) throw clearError;
    }
    const payload = {
      partido_id: match.id,
      jugador_id: player.id,
      asistio: req.body?.asistio === false ? false : true,
      disciplina_codigo: profile.code,
      metricas_competitivas: metrics,
      metricas_version: COMPETITIVE_STATS_VERSION,
      es_mvp: wantsMvp,
      ...legacyStatColumns(profile, metrics),
    };
    const { data, error } = await supabase.from('partido_estadisticas').upsert(payload, { onConflict: 'partido_id,jugador_id' }).select('*').single();
    if (error) throw error;
    await logLiveEvent({ user: req.user, matchId: match.id, playerId: player.id, action: 'estadistica', detail: { metricas: metrics, es_mvp: wantsMvp } });
    return res.json({ success: true, data: { ...data, metricas: metrics } });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible actualizar las estadísticas.' });
  }
});

router.post('/me/partidos/:partidoId/en-vivo/finalizar', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const match = await requireAssignedMatch(req.user, req.params.partidoId);
    if (!match.en_vivo && match.estado === 'Jugado') return res.status(409).json({ error: 'El encuentro ya está finalizado.' });
    if (!match.en_vivo) return res.status(409).json({ error: 'El encuentro no está activo en modo en vivo.' });
    const profile = resolveMatchProfile(match);
    const now = new Date().toISOString();
    const { data, error } = await supabase.from('partidos').update({
      en_vivo: false,
      estado: 'Jugado',
      live_etapa: cleanLimitedText(req.body?.etapa, 60) || 'Finalizado',
      live_finished_at: now,
      live_updated_at: now,
      live_updated_by: req.user.id,
    }).eq('id', match.id).eq('academia_id', req.user.academia_id).select('*').single();
    if (error) throw error;
    await logLiveEvent({ user: req.user, matchId: match.id, action: 'fin', detail: { favor: Number(data.goles_favor) || 0, contra: Number(data.goles_contra) || 0, etiqueta: profile.scoreLabel } });
    return res.json({ success: true, message: 'Encuentro finalizado. El resultado queda disponible para revisión de dirección.', data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible finalizar el encuentro.' });
  }
});

// Casos y feedback del profesor.
router.get('/me/casos', authMiddleware, requireProfessor, async (req, res) => {
  try {
    let query = supabase.from('profesor_casos').select('*').eq('academia_id', req.user.academia_id).eq('profesor_id', req.user.id).order('updated_at', { ascending: false });
    const state = cleanText(req.query?.estado);
    if (state && CASE_STATES.has(state)) query = query.eq('estado', state);
    const { data, error } = await query.limit(100);
    if (error) throw error;
    return res.json({ success: true, data: await decorateCases(req.user.academia_id, data || []) });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'No fue posible cargar tus casos.' });
  }
});

router.post('/me/casos', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const title = cleanLimitedText(req.body?.titulo, 160);
    const detail = cleanLimitedText(req.body?.detalle, 5000);
    const type = CASE_TYPES.has(cleanText(req.body?.tipo)) ? cleanText(req.body.tipo) : 'seguimiento';
    const priority = CASE_PRIORITIES.has(cleanText(req.body?.prioridad)) ? cleanText(req.body.prioridad) : 'normal';
    if (title.length < 3) return res.status(400).json({ error: 'Escribe un título breve para identificar el caso.' });
    let category = null;
    if (req.body?.categoria_id) {
      const context = await requireAssignedCategory(req.user, req.body.categoria_id);
      category = context.category;
    }
    let playerId = cleanText(req.body?.jugador_id) || null;
    if (playerId) {
      if (!category) return res.status(400).json({ error: 'Para asociar un alumno debes seleccionar una categoría.' });
      const { students } = await getCategoryStudents(req.user, category.id);
      if (!students.some((item) => String(item.id) === playerId)) return res.status(403).json({ error: 'El alumno no pertenece a la categoría seleccionada.' });
    }
    const { data, error } = await supabase.from('profesor_casos').insert({
      academia_id: req.user.academia_id,
      profesor_id: req.user.id,
      creado_por: req.user.id,
      origen: 'profesor',
      categoria_id: category?.id || null,
      rama_id: category?.rama_id || null,
      jugador_id: playerId,
      tipo: type,
      prioridad: priority,
      titulo: title,
      detalle: detail,
      estado: 'abierto',
    }).select('*').single();
    if (error) throw error;
    return res.status(201).json({ success: true, message: 'Caso enviado a dirección.', data: (await decorateCases(req.user.academia_id, [data]))[0] });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible crear el caso.' });
  }
});

router.get('/me/casos/:caseId', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const item = await getProfessorCase(req.user, req.params.caseId);
    const decorated = (await decorateCases(req.user.academia_id, [item]))[0];
    return res.json({ success: true, data: { ...decorated, mensajes: await getCaseMessages(req.user.academia_id, item.id) } });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible cargar el caso.' });
  }
});

router.post('/me/casos/:caseId/mensajes', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const item = await getProfessorCase(req.user, req.params.caseId);
    if (item.estado === 'resuelto') return res.status(409).json({ error: 'El caso está resuelto. Solicita a dirección reabrirlo si es necesario.' });
    const message = cleanLimitedText(req.body?.mensaje, 5000);
    if (!message) return res.status(400).json({ error: 'Escribe un mensaje.' });
    const now = new Date().toISOString();
    const { data, error } = await supabase.from('profesor_caso_mensajes').insert({
      caso_id: item.id, academia_id: req.user.academia_id, autor_id: req.user.id, autor_rol: 'profesor', mensaje: message,
    }).select('*').single();
    if (error) throw error;
    await supabase.from('profesor_casos').update({ updated_at: now }).eq('id', item.id).eq('academia_id', req.user.academia_id);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible enviar el mensaje.' });
  }
});

// Bandeja de dirección: conserva la autoridad sobre profesores y resolución de casos.
router.get('/casos', authMiddleware, requireDirector, async (req, res) => {
  try {
    let query = supabase.from('profesor_casos').select('*').eq('academia_id', req.user.academia_id).order('updated_at', { ascending: false });
    const state = cleanText(req.query?.estado);
    const professorId = cleanText(req.query?.profesor_id);
    if (state && CASE_STATES.has(state)) query = query.eq('estado', state);
    if (professorId) query = query.eq('profesor_id', professorId);
    const { data, error } = await query.limit(200);
    if (error) throw error;
    return res.json({ success: true, data: await decorateCases(req.user.academia_id, data || []) });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'No fue posible cargar los casos del equipo técnico.' });
  }
});

router.post('/casos', authMiddleware, requireDirector, async (req, res) => {
  try {
    const professorId = cleanText(req.body?.profesor_id);
    const title = cleanLimitedText(req.body?.titulo, 160);
    const detail = cleanLimitedText(req.body?.detalle, 5000);
    const type = CASE_TYPES.has(cleanText(req.body?.tipo)) ? cleanText(req.body.tipo) : 'feedback';
    const priority = CASE_PRIORITIES.has(cleanText(req.body?.prioridad)) ? cleanText(req.body.prioridad) : 'normal';
    if (!professorId || title.length < 3) return res.status(400).json({ error: 'Selecciona un profesor y escribe un título.' });
    const professorResult = await supabase.from('usuarios').select('id').eq('id', professorId).eq('academia_id', req.user.academia_id).eq('rol', 'profesor').maybeSingle();
    if (professorResult.error) throw professorResult.error;
    if (!professorResult.data) return res.status(404).json({ error: 'Profesor no encontrado.' });
    let category = null;
    if (req.body?.categoria_id) {
      const assignmentResult = await supabase.from('profesor_categorias').select('categoria_id')
        .eq('academia_id', req.user.academia_id).eq('profesor_id', professorId).eq('categoria_id', req.body.categoria_id).eq('activo', true).maybeSingle();
      if (assignmentResult.error) throw assignmentResult.error;
      if (!assignmentResult.data) return res.status(403).json({ error: 'Esa categoría no está asignada al profesor.' });
      category = (await getCategoryContext(req.user.academia_id, req.body.categoria_id)).category;
    }
    const { data, error } = await supabase.from('profesor_casos').insert({
      academia_id: req.user.academia_id,
      profesor_id: professorId,
      creado_por: req.user.id,
      origen: 'direccion',
      categoria_id: category?.id || null,
      rama_id: category?.rama_id || null,
      jugador_id: null,
      tipo: type,
      prioridad: priority,
      titulo: title,
      detalle: detail,
      estado: 'abierto',
    }).select('*').single();
    if (error) throw error;
    return res.status(201).json({ success: true, data: (await decorateCases(req.user.academia_id, [data]))[0] });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible crear el feedback.' });
  }
});

router.get('/casos/:caseId', authMiddleware, requireDirector, async (req, res) => {
  try {
    const item = await getDirectorCase(req.user, req.params.caseId);
    const decorated = (await decorateCases(req.user.academia_id, [item]))[0];
    return res.json({ success: true, data: { ...decorated, mensajes: await getCaseMessages(req.user.academia_id, item.id) } });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible cargar el caso.' });
  }
});

router.post('/casos/:caseId/mensajes', authMiddleware, requireDirector, async (req, res) => {
  try {
    const item = await getDirectorCase(req.user, req.params.caseId);
    if (item.estado === 'resuelto') return res.status(409).json({ error: 'Reabre el caso antes de continuar la conversación.' });
    const message = cleanLimitedText(req.body?.mensaje, 5000);
    if (!message) return res.status(400).json({ error: 'Escribe un mensaje.' });
    const now = new Date().toISOString();
    const { data, error } = await supabase.from('profesor_caso_mensajes').insert({
      caso_id: item.id, academia_id: req.user.academia_id, autor_id: req.user.id, autor_rol: 'director', mensaje: message,
    }).select('*').single();
    if (error) throw error;
    await supabase.from('profesor_casos').update({ estado: item.estado === 'abierto' ? 'en_revision' : item.estado, updated_at: now }).eq('id', item.id).eq('academia_id', req.user.academia_id);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible responder el caso.' });
  }
});

router.patch('/casos/:caseId', authMiddleware, requireDirector, async (req, res) => {
  try {
    const item = await getDirectorCase(req.user, req.params.caseId);
    const state = CASE_STATES.has(cleanText(req.body?.estado)) ? cleanText(req.body.estado) : item.estado;
    const priority = CASE_PRIORITIES.has(cleanText(req.body?.prioridad)) ? cleanText(req.body.prioridad) : item.prioridad;
    const now = new Date().toISOString();
    const payload = {
      estado: state,
      prioridad: priority,
      updated_at: now,
      resuelto_por: state === 'resuelto' ? req.user.id : null,
      resuelto_at: state === 'resuelto' ? now : null,
    };
    const { data, error } = await supabase.from('profesor_casos').update(payload).eq('id', item.id).eq('academia_id', req.user.academia_id).select('*').single();
    if (error) throw error;
    return res.json({ success: true, data: (await decorateCases(req.user.academia_id, [data]))[0] });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible actualizar el caso.' });
  }
});

module.exports = router;
