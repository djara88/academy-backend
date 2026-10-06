const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireTenantContext } = require('../middleware/tenantContext');
const { requireDirector, requireProfessor } = require('../middleware/professorAccess');
const { requireFeature } = require('../middleware/planAccess');
const { FEATURES } = require('../services/planCatalog');
const { getProfessorLimit } = require('../services/planLimits');
const { toProfessorPlayer } = require('../services/professorPlayerView');
const { buildAttendanceAlertRows } = require('../services/attendanceAlerts');
const { getCategoryContext, getStudentsForScope } = require('../services/branchContext');

const router = express.Router();
const ATTENDANCE_STATES = new Set(['Presente', 'Ausente', 'Justificado']);

const uniqueIds = (values) => [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
const cleanText = (value) => String(value || '').trim();
const cleanLimitedText = (value, maxLength) => cleanText(value).slice(0, maxLength);
const todayInChile = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const addDays = (date, days) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const usage = async (academyId) => {
  const [{ data: academy, error: academyError }, { count, error: countError }] = await Promise.all([
    supabase.from('academias').select('id,nombre,plan,max_profesores').eq('id', academyId).single(),
    supabase.from('usuarios').select('id', { count: 'exact', head: true }).eq('academia_id', academyId).eq('rol', 'profesor').eq('activo', true),
  ]);
  if (academyError) throw academyError;
  if (countError) throw countError;
  const max = getProfessorLimit(academy);
  return { academy, used: count || 0, max, remaining: Math.max(max - (count || 0), 0) };
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
    .select('id,academia_id,categoria_id,sede_id,rama_id,rival,fecha,hora,hora_citacion,ubicacion,link_maps,color_uniforme,estado,es_amistoso,condicion,categorias(id,nombre,rama_id),ramas(id,nombre,disciplina),sedes(id,nombre)')
    .eq('id', matchId).eq('academia_id', user.academia_id).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Encuentro no encontrado.'), { status: 404 });
  if (!data.categoria_id || !data.rama_id) throw Object.assign(new Error('El encuentro no está correctamente vinculado a una rama y categoría.'), { status: 409 });
  const { category } = await requireAssignedCategory(user, data.categoria_id);
  if (String(category.rama_id) !== String(data.rama_id)) throw Object.assign(new Error('La categoría del encuentro no coincide con su rama.'), { status: 409 });
  return data;
};

const refreshAttendanceAlerts = async ({ academyId, categoryId, playerIds }) => {
  const { data: trainings, error: trainingError } = await supabase.from('entrenamientos')
    .select('id,fecha,created_at').eq('academia_id', academyId).eq('categoria_id', categoryId)
    .eq('estado', 'Realizado').order('fecha', { ascending: false }).order('created_at', { ascending: false }).limit(20);
  if (trainingError) throw trainingError;
  const trainingIds = (trainings || []).map((item) => item.id);
  if (!trainingIds.length || !playerIds.length) return 0;
  const [{ data: attendance, error: attendanceError }, { data: existing, error: existingError }] = await Promise.all([
    supabase.from('asistencias').select('entrenamiento_id,jugador_id,estado').eq('academia_id', academyId).in('entrenamiento_id', trainingIds).in('jugador_id', playerIds),
    supabase.from('alertas_asistencia').select('jugador_id,racha,activa,detectada_at,revisada_at,revisada_por')
      .eq('academia_id', academyId).eq('categoria_id', categoryId).in('jugador_id', playerIds),
  ]);
  if (attendanceError) throw attendanceError;
  if (existingError) throw existingError;
  const calculated = buildAttendanceAlertRows({
    academyId, categoryId, playerIds, trainings: trainings || [], attendance: attendance || [], existingAlerts: existing || [],
  });
  const rows = calculated.map(({ newly_activated: _newlyActivated, ...row }) => row);
  const { error: upsertError } = await supabase.from('alertas_asistencia')
    .upsert(rows, { onConflict: 'academia_id,categoria_id,jugador_id,tipo' });
  if (upsertError) throw upsertError;
  return calculated.filter((row) => row.newly_activated).length;
};

router.get('/', authMiddleware, requireDirector, requireTenantContext, async (req, res) => {
  try {
    const academyId = req.tenant.academyId;
    const currentUsage = await usage(academyId);
    const [{ data: professors, error: professorError }, { data: categories, error: categoryError }, { data: assignments, error: assignmentError }] = await Promise.all([
      supabase.from('usuarios').select('id,nombre_completo,email,telefono,activo,ultimo_acceso,created_at')
        .eq('academia_id', academyId).eq('rol', 'profesor').order('created_at'),
      supabase.from('categorias')
        .select('id,nombre,descripcion,sede_id,rama_id,ramas(id,nombre,disciplina),sedes(id,nombre)')
        .eq('academia_id', academyId).order('rama_id').order('nombre'),
      supabase.from('profesor_categorias').select('id,profesor_id,categoria_id,activo')
        .eq('academia_id', academyId).eq('activo', true),
    ]);
    if (professorError) throw professorError;
    if (categoryError) throw categoryError;
    if (assignmentError) throw assignmentError;
    const categoryMap = new Map((categories || []).map((category) => [String(category.id), category]));
    const data = (professors || []).map((professor) => ({
      ...professor,
      categorias: (assignments || []).filter((item) => String(item.profesor_id) === String(professor.id))
        .map((item) => categoryMap.get(String(item.categoria_id))).filter(Boolean),
    }));
    return res.json({ success: true, data, categorias: categories || [], cupos: { used: currentUsage.used, max: currentUsage.max, remaining: currentUsage.remaining }, plan: currentUsage.academy.plan });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'No fue posible cargar profesores.' });
  }
});

router.get('/me', authMiddleware, requireProfessor, requireTenantContext, async (req, res) => {
  try {
    const [{ data: academy, error: academyError }, { data: assignments, error: assignmentError }] = await Promise.all([
      supabase.from('academias').select('id,nombre,logo,logo_url,rama_principal_id').eq('id', req.tenant.academyId).single(),
      supabase.from('profesor_categorias')
        .select('categoria_id,categorias(id,nombre,descripcion,sede_id,rama_id,ramas(id,nombre,disciplina),sedes(id,nombre))')
        .eq('academia_id', req.tenant.academyId).eq('profesor_id', req.user.id).eq('activo', true),
    ]);
    if (academyError) throw academyError;
    if (assignmentError) throw assignmentError;
    return res.json({ success: true, data: {
      profesor: { id: req.user.id, nombre: req.user.nombre_completo },
      academia: academy,
      categorias: (assignments || []).map((item) => item.categorias).filter(Boolean),
    } });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'No fue posible cargar el portal del profesor.' });
  }
});

router.get('/me/agenda', authMiddleware, requireProfessor, requireTenantContext, async (req, res) => {
  try {
    const from = String(req.query?.desde || todayInChile());
    const to = String(req.query?.hasta || addDays(from, 60));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from || to > addDays(from, 120)) {
      return res.status(400).json({ error: 'El rango de agenda es inválido o supera 120 días.' });
    }
    const { data: assignments, error: assignmentError } = await supabase.from('profesor_categorias').select('categoria_id')
      .eq('academia_id', req.tenant.academyId).eq('profesor_id', req.user.id).eq('activo', true);
    if (assignmentError) throw assignmentError;
    const categoryIds = uniqueIds((assignments || []).map((item) => item.categoria_id));
    if (!categoryIds.length) return res.json({ success: true, data: [] });
    const [{ data: trainings, error: trainingError }, { data: matches, error: matchError }] = await Promise.all([
      supabase.from('entrenamientos')
        .select('id,categoria_id,sede_id,rama_id,fecha,hora,lugar,estado,es_recuperacion,categorias(id,nombre),ramas(id,nombre,disciplina),sedes(id,nombre)')
        .eq('academia_id', req.tenant.academyId).in('categoria_id', categoryIds).gte('fecha', from).lte('fecha', to).order('fecha').order('hora'),
      supabase.from('partidos')
        .select('id,categoria_id,sede_id,rama_id,rival,fecha,hora,hora_citacion,ubicacion,link_maps,color_uniforme,estado,es_amistoso,condicion,categorias(id,nombre),ramas(id,nombre,disciplina),sedes(id,nombre)')
        .eq('academia_id', req.tenant.academyId).in('categoria_id', categoryIds).gte('fecha', from).lte('fecha', to).order('fecha').order('hora'),
    ]);
    if (trainingError) throw trainingError;
    if (matchError) throw matchError;
    const trainingIds = (trainings || []).map((item) => item.id);
    const matchIds = (matches || []).map((item) => item.id);
    const [logs, preparations] = await Promise.all([
      trainingIds.length ? supabase.from('entrenamiento_bitacoras').select('entrenamiento_id').eq('academia_id', req.tenant.academyId).in('entrenamiento_id', trainingIds) : Promise.resolve({ data: [], error: null }),
      matchIds.length ? supabase.from('partido_preparaciones').select('partido_id,estado').eq('academia_id', req.tenant.academyId).in('partido_id', matchIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (logs.error) throw logs.error;
    if (preparations.error) throw preparations.error;
    const logged = new Set((logs.data || []).map((item) => String(item.entrenamiento_id)));
    const prepMap = new Map((preparations.data || []).map((item) => [String(item.partido_id), item.estado]));
    const events = [
      ...(trainings || []).map((item) => ({ ...item, tipo: 'Entrenamiento', bitacora_completa: logged.has(String(item.id)) })),
      ...(matches || []).map((item) => ({ ...item, tipo: 'Partido', preparacion_estado: prepMap.get(String(item.id)) || null })),
    ].sort((a,b) => `${a.fecha} ${a.hora || ''}`.localeCompare(`${b.fecha} ${b.hora || ''}`));
    return res.json({ success: true, data: events, rango: { desde: from, hasta: to } });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'No fue posible cargar la agenda.' });
  }
});

router.get('/me/categorias/:categoriaId/asistencia', authMiddleware, requireProfessor, requireTenantContext, async (req, res) => {
  try {
    const date = cleanText(req.query?.fecha) || todayInChile();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Fecha inválida.' });
    const { category, students } = await getCategoryStudents(req.user, req.params.categoriaId);
    const { data: training, error: trainingError } = await supabase.from('entrenamientos')
      .select('id,hora,lugar,created_at,sede_id,rama_id')
      .eq('academia_id', req.tenant.academyId).eq('categoria_id', category.id).eq('rama_id', category.rama_id)
      .eq('fecha', date).eq('estado', 'Realizado').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (trainingError) throw trainingError;
    let attendance = [];
    if (training) {
      const result = await supabase.from('asistencias').select('jugador_id,estado').eq('academia_id', req.tenant.academyId).eq('entrenamiento_id', training.id);
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

router.post('/me/categorias/:categoriaId/asistencia', authMiddleware, requireProfessor, requireTenantContext, async (req, res) => {
  try {
    const date = cleanText(req.body?.fecha);
    const items = Array.isArray(req.body?.asistencias) ? req.body.asistencias : [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !items.length) return res.status(400).json({ error: 'La fecha y la lista de asistencia son obligatorias.' });
    if (items.some((item) => !item.jugador_id || !ATTENDANCE_STATES.has(item.estado))) return res.status(400).json({ error: 'La lista contiene estados de asistencia inválidos.' });
    const { category, students } = await getCategoryStudents(req.user, req.params.categoriaId);
    const allowed = new Set(students.map((student) => String(student.id)));
    if (items.some((item) => !allowed.has(String(item.jugador_id)))) return res.status(403).json({ error: 'La lista contiene un alumno ajeno a la inscripción activa de esta rama/categoría.' });

    let { data: training, error: trainingError } = await supabase.from('entrenamientos').select('id')
      .eq('academia_id', req.tenant.academyId).eq('categoria_id', category.id).eq('rama_id', category.rama_id)
      .eq('fecha', date).eq('estado', 'Realizado').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (trainingError) throw trainingError;
    if (!training) {
      const result = await supabase.from('entrenamientos').insert({
        academia_id: req.tenant.academyId,
        categoria_id: category.id,
        sede_id: category.sede_id,
        rama_id: category.rama_id,
        fecha: date,
        hora: new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Santiago' }),
        estado: 'Realizado',
        es_recuperacion: false,
        registrado_por: req.user.id,
      }).select('id').single();
      if (result.error) throw result.error;
      training = result.data;
    }
    const rows = items.map((item) => ({ academia_id: req.tenant.academyId, entrenamiento_id: training.id, jugador_id: item.jugador_id, estado: item.estado, registrado_por: req.user.id, actualizado_at: new Date().toISOString() }));
    const { error: attendanceError } = await supabase.from('asistencias').upsert(rows, { onConflict: 'entrenamiento_id,jugador_id' });
    if (attendanceError) throw attendanceError;
    let activatedAlerts = 0;
    try {
      activatedAlerts = await refreshAttendanceAlerts({ academyId: req.tenant.academyId, categoryId: category.id, playerIds: items.map((item) => String(item.jugador_id)) });
    } catch (alertError) {
      console.error('No se pudieron actualizar las alertas de asistencia:', alertError?.message || alertError);
    }
    await supabase.from('usuarios').update({ ultimo_acceso: new Date().toISOString() }).eq('id', req.user.id).eq('academia_id', req.tenant.academyId);
    return res.json({ success: true, message: `Asistencia guardada: ${items.length} alumnos.`, entrenamiento_id: training.id, alertas_generadas: activatedAlerts });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible guardar la asistencia.' });
  }
});

router.get('/me/partidos/:partidoId/preparacion', authMiddleware, requireProfessor, requireTenantContext, ...requireFeature(FEATURES.MATCH_PREPARATION), async (req, res) => {
  try {
    const match = await requireAssignedMatch(req.user, req.params.partidoId);
    const { students } = await getCategoryStudents(req.user, match.categoria_id);
    const { data: preparation, error: preparationError } = await supabase.from('partido_preparaciones')
      .select('id,sistema_juego,objetivo,indicaciones,estado,updated_at')
      .eq('academia_id', req.tenant.academyId).eq('partido_id', match.id).maybeSingle();
    if (preparationError) throw preparationError;
    let plan = [];
    if (preparation) {
      const result = await supabase.from('partido_plan_jugadores')
        .select('jugador_id,rol,posicion,orden').eq('preparacion_id', preparation.id).order('orden');
      if (result.error) throw result.error;
      plan = result.data || [];
    }
    const planByPlayer = new Map(plan.map((item) => [String(item.jugador_id), item]));
    const roster = students.map((student) => {
      const planned = planByPlayer.get(String(student.id));
      return {
        id: student.id,
        nombre: student.nombre,
        posicion_principal: student.posicion_principal,
        posicion_cancha: student.posicion_cancha,
        rol_especialidad: student.rol_especialidad,
        foto_url: student.foto_url,
        avatar_url: student.avatar_url,
        rol_plan: planned?.rol || null,
        posicion_plan: planned?.posicion || '',
        orden_plan: planned?.orden ?? null,
      };
    });
    return res.json({ success: true, data: { partido: match, preparacion: preparation || null, jugadores: roster } });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible cargar la preparación.' });
  }
});

router.put('/me/partidos/:partidoId/preparacion', authMiddleware, requireProfessor, requireTenantContext, ...requireFeature(FEATURES.MATCH_PREPARATION), async (req, res) => {
  try {
    const match = await requireAssignedMatch(req.user, req.params.partidoId);
    if (match.fecha < todayInChile() || match.estado === 'Jugado') return res.status(409).json({ error: 'Solo puedes preparar encuentros próximos que aún no se han realizado.' });
    const plannedPlayers = Array.isArray(req.body?.jugadores) ? req.body.jugadores : [];
    if (plannedPlayers.length > 40) return res.status(400).json({ error: 'La planificación no puede superar 40 alumnos.' });
    const ids = plannedPlayers.map((item) => String(item.jugador_id || '')).filter(Boolean);
    if (ids.length !== uniqueIds(ids).length) return res.status(400).json({ error: 'Hay alumnos repetidos en la planificación.' });
    if (plannedPlayers.some((item) => !item.jugador_id || !new Set(['Titular', 'Suplente']).has(item.rol))) return res.status(400).json({ error: 'Cada alumno debe quedar como Titular o Suplente.' });
    const { students } = await getCategoryStudents(req.user, match.categoria_id);
    const allowed = new Set(students.map((student) => String(student.id)));
    if (ids.some((id) => !allowed.has(id))) return res.status(403).json({ error: 'La planificación contiene un alumno ajeno a la rama/categoría del encuentro.' });
    const status = cleanText(req.body?.estado) || 'Borrador';
    if (!new Set(['Borrador', 'Lista']).has(status)) return res.status(400).json({ error: 'Estado de preparación inválido.' });
    if (status === 'Lista' && !plannedPlayers.some((item) => item.rol === 'Titular')) return res.status(400).json({ error: 'Para marcar la preparación como lista debes definir al menos un titular.' });
    const sanitizedPlayers = plannedPlayers.map((item, index) => ({
      jugador_id: String(item.jugador_id), rol: item.rol, posicion: cleanLimitedText(item.posicion, 60),
      orden: Math.min(Math.max(Number.isInteger(item.orden) ? item.orden : index, 0), 99),
    }));
    const { data, error } = await supabase.rpc('save_partido_preparacion', {
      p_academia_id: req.tenant.academyId,
      p_partido_id: match.id,
      p_categoria_id: match.categoria_id,
      p_profesor_id: req.user.id,
      p_sistema_juego: cleanLimitedText(req.body?.sistema_juego, 80),
      p_objetivo: cleanLimitedText(req.body?.objetivo, 700),
      p_indicaciones: cleanLimitedText(req.body?.indicaciones, 2500),
      p_estado: status,
      p_jugadores: sanitizedPlayers,
    });
    if (error) throw error;
    return res.json({ success: true, message: status === 'Lista' ? 'Preparación lista para el encuentro.' : 'Borrador guardado.', preparacion_id: data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible guardar la preparación.' });
  }
});

module.exports = router;
