const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarMensaje } = require('../services/whatsappService');
const { academyMessage, getAcademyName } = require('../services/academyIdentity');
const { publicProfile, resolveCompetitiveProfile } = require('../services/competitiveStatsCatalog');
const {
  getCategoryContext,
  getTournament,
  getStudentsForScope,
  getActiveEnrollments,
  safeText,
  uniqueIds,
} = require('../services/branchContext');

const router = express.Router();
router.use(authMiddleware);

const getStudentTutorId = (student) => student?.tutor_id || student?.tutor_principal_id || student?.apoderado_id || null;

const normalizeTime = (value) => {
  const time = String(value || '').trim().slice(0, 5);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : null;
};
const subtractMinutes = (time, amount) => {
  const [hours, minutes] = time.split(':').map(Number);
  const total = (hours * 60 + minutes - amount + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
const validateSchedule = (matchValue, callValue) => {
  const matchTime = normalizeTime(matchValue);
  if (!matchTime) throw Object.assign(new Error('Selecciona una hora de encuentro válida.'), { status: 400 });
  const callTime = normalizeTime(callValue) || subtractMinutes(matchTime, 60);
  const [mh, mm] = matchTime.split(':').map(Number);
  const [ch, cm] = callTime.split(':').map(Number);
  if (ch * 60 + cm >= mh * 60 + mm) throw Object.assign(new Error('La citación debe ser anterior a la hora del encuentro.'), { status: 400 });
  return { matchTime, callTime };
};

const loadMatch = async (academyId, id) => {
  const { data, error } = await supabase.from('partidos')
    .select('*,torneos(id,nombre,rama_id,sede_id),categorias(id,nombre,rama_id,sede_id),ramas(id,nombre,disciplina),sedes(id,nombre)')
    .eq('id', id).eq('academia_id', academyId).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Encuentro no encontrado.'), { status: 404 });
  return data;
};

const resolveMatchContext = async (academyId, body) => {
  const categoryId = safeText(body?.categoria_id, 80);
  if (!categoryId) throw Object.assign(new Error('Todo encuentro debe pertenecer a una categoría y rama deportiva.'), { status: 400, code: 'CATEGORY_REQUIRED' });
  const { category, branch } = await getCategoryContext(academyId, categoryId);
  if (!branch) throw Object.assign(new Error('La categoría no tiene una rama deportiva válida.'), { status: 409, code: 'CATEGORY_NOT_SCOPED' });
  let tournament = null;
  if (body?.es_amistoso !== true && body?.torneo_id) {
    tournament = await getTournament(academyId, body.torneo_id);
    if (tournament.rama_id && String(tournament.rama_id) !== String(branch.id)) {
      throw Object.assign(new Error('El torneo y la categoría pertenecen a ramas deportivas distintas.'), { status: 409, code: 'TOURNAMENT_MATCH_BRANCH_MISMATCH' });
    }
  }
  const profile = resolveCompetitiveProfile({ discipline: branch.disciplina });
  return { category, branch, tournament, profile };
};

router.get('/', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const branchId = safeText(req.query?.rama_id, 80);
    const tournamentId = safeText(req.query?.torneo_id, 80);
    const type = safeText(req.query?.tipo, 30);
    let query = supabase.from('partidos')
      .select('*,torneos(id,nombre,rama_id),categorias(id,nombre,rama_id),ramas(id,nombre,disciplina),sedes(id,nombre)')
      .eq('academia_id', academyId)
      .order('fecha', { ascending: false });
    if (branchId) query = query.eq('rama_id', branchId);
    if (tournamentId) query = query.eq('torneo_id', tournamentId);
    else if (type === 'amistosos') query = query.eq('es_amistoso', true);
    else if (type === 'torneo') query = query.eq('es_amistoso', false);
    const { data, error } = await query;
    if (error) throw error;
    const result = (data || []).map((match) => ({
      ...match,
      sport_profile: publicProfile(resolveCompetitiveProfile({ discipline: match.ramas?.disciplina, code: match.disciplina_codigo })),
    }));
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, error: error?.message || 'No fue posible cargar los encuentros.' });
  }
});

router.post('/', async (req, res) => {
  let match = null;
  try {
    const academyId = req.user.academia_id;
    const context = await resolveMatchContext(academyId, req.body);
    const { matchTime, callTime } = validateSchedule(req.body?.hora, req.body?.hora_citacion);
    const { data, error } = await supabase.from('partidos').insert({
      academia_id: academyId,
      torneo_id: req.body?.es_amistoso === true ? null : (req.body?.torneo_id || null),
      categoria_id: context.category.id,
      sede_id: context.category.sede_id,
      rama_id: context.category.rama_id,
      disciplina_codigo: context.profile.code,
      es_amistoso: req.body?.es_amistoso === true,
      rival: safeText(req.body?.rival, 180) || 'Evento / rival por confirmar',
      fecha: req.body?.fecha,
      hora: matchTime,
      hora_citacion: callTime,
      ubicacion: safeText(req.body?.ubicacion, 300),
      link_maps: safeText(req.body?.link_maps, 1000),
      color_uniforme: safeText(req.body?.color_uniforme, 120) || 'Indumentaria principal',
      condicion: safeText(req.body?.condicion, 40) || 'Local',
      cobra_arbitraje: req.body?.cobra_arbitraje === true,
      monto_arbitraje_jugador: req.body?.cobra_arbitraje === true ? Math.max(0, Number(req.body?.monto_arbitraje_jugador) || 0) : 0,
      estado: 'Programado',
    }).select('*,torneos(id,nombre,rama_id),categorias(id,nombre,rama_id),ramas(id,nombre,disciplina),sedes(id,nombre)').single();
    if (error) throw error;
    match = data;

    const expenses = [];
    const refereeCost = Math.max(0, Number(req.body?.costo_arbitraje_total) || 0);
    const venueCost = Math.max(0, Number(req.body?.costo_cancha) || 0);
    if (refereeCost > 0) expenses.push({
      academia_id: academyId, sede_id: context.category.sede_id, rama_id: context.category.rama_id, partido_id: data.id,
      concepto: `Arbitraje / jueces · ${data.rival}`, categoria_gasto: 'Arbitraje', centro_costo: context.branch.nombre,
      monto: refereeCost, fecha_gasto: data.fecha,
    });
    if (venueCost > 0) expenses.push({
      academia_id: academyId, sede_id: context.category.sede_id, rama_id: context.category.rama_id, partido_id: data.id,
      concepto: `Arriendo recinto · ${data.rival}`, categoria_gasto: 'Arriendo Canchas', centro_costo: context.branch.nombre,
      monto: venueCost, fecha_gasto: data.fecha,
    });
    if (expenses.length) {
      const { error: expenseError } = await supabase.from('egresos').insert(expenses);
      if (expenseError) throw expenseError;
    }
    return res.status(201).json({ success: true, data: { ...data, sport_profile: publicProfile(context.profile) } });
  } catch (error) {
    if (match?.id) await supabase.from('partidos').delete().eq('id', match.id).eq('academia_id', req.user.academia_id);
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible crear el encuentro.', code: error?.code });
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const academyId = req.user.academia_id;
    await loadMatch(academyId, req.params.id);
    await resolveMatchContext(academyId, req.body);
    return next();
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message, code: error?.code });
  }
});

router.post('/:id/citacion', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const academyName = await getAcademyName(academyId);
    const match = await loadMatch(academyId, req.params.id);
    if (!match.categoria_id || !match.rama_id) return res.status(409).json({ error: 'El encuentro no está correctamente vinculado a una rama y categoría.' });

    const students = await getStudentsForScope({
      academyId,
      branchId: match.rama_id,
      categoryId: match.categoria_id,
      playerSelect: 'id,nombre,tutor_id,tutor_principal_id,apoderado_id,telefono_apoderado',
    });
    if (!students.length) return res.status(400).json({ error: 'No hay alumnos con inscripción activa en esta categoría.' });
    const tutorIds = uniqueIds(students.map((student) => getStudentTutorId(student)));
    let tutorMap = new Map();
    if (tutorIds.length) {
      const { data: tutors, error } = await supabase.from('tutores').select('id,nombre_completo,telefono')
        .eq('academia_id', academyId).in('id', tutorIds);
      if (error) throw error;
      tutorMap = new Map((tutors || []).map((tutor) => [String(tutor.id), tutor]));
    }

    const citations = students.map((student) => ({
      partido_id: match.id,
      jugador_id: student.id,
      telefono_apoderado: tutorMap.get(String(getStudentTutorId(student)))?.telefono || student.telefono_apoderado || '',
      respuesta: 'Pendiente',
      paso_bot: 'ESPERANDO_CITACION',
    }));
    const { error: citationError } = await supabase.from('partido_citaciones')
      .upsert(citations, { onConflict: 'partido_id,jugador_id' });
    if (citationError) throw citationError;

    const charge = Math.max(0, Number(match.monto_arbitraje_jugador) || 0);
    if (match.cobra_arbitraje && charge > 0) {
      const charges = students.map((student) => ({
        academia_id: academyId,
        jugador_id: student.id,
        inscripcion_id: student.inscripcion?.id || null,
        sede_id: match.sede_id,
        rama_id: match.rama_id,
        partido_id: match.id,
        concepto: `${match.ramas?.disciplina || 'Competencia'} · arbitraje/jueces · ${match.rival}`,
        tipo_concepto: 'Partido',
        monto: charge,
        monto_pagado: 0,
        estado: 'Pendiente',
        fecha_vencimiento: match.fecha,
      }));
      const { error: chargeError } = await supabase.from('cobros')
        .upsert(charges, { onConflict: 'academia_id,jugador_id,partido_id', ignoreDuplicates: true });
      if (chargeError) throw chargeError;
    }

    const profile = resolveCompetitiveProfile({ discipline: match.ramas?.disciplina, code: match.disciplina_codigo });
    const kind = match.es_amistoso ? `🤝 *${profile.activityLabel.toUpperCase()} AMISTOSO*` : `🏆 *${match.torneos?.nombre || 'COMPETENCIA'}*`;
    let sent = 0;
    for (const student of students) {
      const tutor = tutorMap.get(String(getStudentTutorId(student)));
      const source = tutor?.telefono || student.telefono_apoderado;
      if (!source) continue;
      let phone = String(source).replace(/\D/g, '');
      if (!phone.startsWith('56') && phone.length === 9) phone = `56${phone}`;
      const message = academyMessage(academyName,
        `📋 *CITACIÓN · ${profile.label.toUpperCase()}*\n\n` +
        `*${student.nombre}* ha sido citado/a:\n${kind}\n${profile.icon} *${profile.opponentLabel}:* ${match.rival}\n` +
        `🏷️ *Categoría:* ${match.categorias?.nombre || ''}\n📅 *Fecha:* ${match.fecha}\n📣 *Citación:* ${String(match.hora_citacion || '').slice(0,5)} hrs\n` +
        `⏰ *Inicio:* ${String(match.hora || '').slice(0,5)} hrs\n🏟️ *Lugar:* ${match.ubicacion || 'Por confirmar'}\n👕 *Indumentaria:* ${match.color_uniforme || 'Por confirmar'}\n\n` +
        `Responde:\n1️⃣ Confirmar asistencia\n2️⃣ Informar ausencia`);
      try { await enviarMensaje(academyId, phone, message); sent += 1; }
      catch (sendError) { console.error(`No se pudo enviar citación a ${student.nombre}:`, sendError?.message || sendError); }
    }
    return res.json({ success: true, message: `Citación registrada para ${students.length} alumnos; ${sent} mensajes enviados.`, citados: students.length, enviados: sent });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible enviar la citación.' });
  }
});

router.post('/:id/guardar-resultado', async (req, res, next) => {
  try {
    const match = await loadMatch(req.user.academia_id, req.params.id);
    const submittedIds = uniqueIds((Array.isArray(req.body?.estadisticas) ? req.body.estadisticas : []).map((row) => row?.jugador_id));
    if (!submittedIds.length) return next();
    if (!match.rama_id || !match.categoria_id) {
      return res.status(409).json({ error: 'El encuentro debe estar vinculado a una rama y categoría antes de guardar estadísticas.' });
    }
    const enrollments = await getActiveEnrollments({
      academyId: req.user.academia_id,
      branchId: match.rama_id,
      categoryId: match.categoria_id,
      playerIds: submittedIds,
    });
    const allowed = new Set(enrollments.map((row) => String(row.jugador_id)));
    if (submittedIds.some((id) => !allowed.has(String(id)))) {
      return res.status(403).json({ error: 'Las estadísticas contienen un alumno ajeno a la rama/categoría del encuentro.', code: 'INVALID_MATCH_ROSTER' });
    }
    return next();
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible validar el plantel.' });
  }
});

module.exports = router;
