const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarMensaje } = require('../services/whatsappService');
const { academyMessage, getAcademyName } = require('../services/academyIdentity');
const { resolveCompetitiveProfile } = require('../services/competitiveStatsCatalog');
const {
  getBranch,
  getCategoryContext,
  getTournament,
  getStudentsForScope,
  listAcademyBranches,
  safeText,
  uniqueIds,
} = require('../services/branchContext');

const router = express.Router();
router.use(authMiddleware);

const getStudentTutorId = (student) => student?.tutor_id || student?.tutor_principal_id || student?.apoderado_id || null;

const resolveTournamentBranch = async (academyId, requestedBranchId) => {
  const requested = safeText(requestedBranchId, 80);
  if (requested) return getBranch(academyId, requested);
  const [{ data: academy, error }, branches] = await Promise.all([
    supabase.from('academias').select('rama_principal_id').eq('id', academyId).single(),
    listAcademyBranches(academyId),
  ]);
  if (error) throw error;
  if (academy?.rama_principal_id) {
    const branch = branches.find((item) => String(item.id) === String(academy.rama_principal_id));
    if (branch) return branch;
  }
  if (branches.length === 1) return branches[0];
  throw Object.assign(new Error('Selecciona la rama deportiva del torneo.'), { status: 400, code: 'BRANCH_REQUIRED' });
};

router.get('/', async (req, res) => {
  try {
    const branchId = safeText(req.query?.rama_id, 80);
    let query = supabase.from('torneos')
      .select('*,ramas(id,nombre,disciplina,sede_id),sedes(id,nombre)')
      .eq('academia_id', req.user.academia_id)
      .order('created_at', { ascending: false });
    if (branchId) query = query.eq('rama_id', branchId);
    const [{ data, error }, branches] = await Promise.all([query, listAcademyBranches(req.user.academia_id)]);
    if (error) throw error;
    return res.json({ success: true, data: data || [], ramas: branches });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar los torneos.' });
  }
});

router.post('/', async (req, res) => {
  let tournament = null;
  try {
    const academyId = req.user.academia_id;
    const branch = await resolveTournamentBranch(academyId, req.body?.rama_id);
    const name = safeText(req.body?.nombre, 180);
    if (!name) return res.status(400).json({ success: false, error: 'El nombre del torneo es obligatorio.' });
    const allowsInstallments = req.body?.permite_cuotas === true;
    const { data, error } = await supabase.from('torneos').insert({
      academia_id: academyId,
      sede_id: branch.sede_id,
      rama_id: branch.id,
      nombre: name,
      fecha_inicio: req.body?.fecha_inicio || null,
      fecha_fin: req.body?.fecha_fin || null,
      costo_inscripcion: Math.max(0, Number(req.body?.costo_inscripcion) || 0),
      permite_cuotas: allowsInstallments,
      max_cuotas: allowsInstallments ? Math.max(2, Math.min(12, Math.round(Number(req.body?.max_cuotas) || 2))) : 1,
      estado: safeText(req.body?.estado, 40) || 'Activo',
    }).select('*,ramas(id,nombre,disciplina),sedes(id,nombre)').single();
    if (error) throw error;
    tournament = data;

    const organizationCost = Math.max(0, Number(req.body?.costo_organizacion) || 0);
    if (organizationCost > 0) {
      const { error: expenseError } = await supabase.from('egresos').insert({
        academia_id: academyId,
        sede_id: branch.sede_id,
        rama_id: branch.id,
        torneo_id: data.id,
        concepto: `Inscripción organización · ${name}`,
        categoria_gasto: 'Competencia',
        centro_costo: branch.nombre || branch.disciplina,
        monto: organizationCost,
        fecha_gasto: req.body?.fecha_inicio || new Date().toISOString().slice(0, 10),
      });
      if (expenseError) throw expenseError;
    }
    return res.status(201).json({ success: true, data });
  } catch (error) {
    if (tournament?.id) await supabase.from('torneos').delete().eq('id', tournament.id).eq('academia_id', req.user.academia_id);
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible crear el torneo.', code: error?.code });
  }
});

router.get('/:id/elegibles', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const tournament = await getTournament(academyId, req.params.id);
    if (!tournament.rama_id) return res.status(409).json({ error: 'Este torneo histórico no tiene una rama asociada. Edita o recrea su contexto antes de convocar.', code: 'TOURNAMENT_NOT_SCOPED' });
    const categoryId = safeText(req.query?.categoria_id, 80);
    if (!categoryId) return res.status(400).json({ error: 'Selecciona una categoría del torneo.' });
    const { category } = await getCategoryContext(academyId, categoryId);
    if (String(category.rama_id) !== String(tournament.rama_id)) {
      return res.status(409).json({ error: 'La categoría pertenece a otra rama deportiva.', code: 'CATEGORY_TOURNAMENT_BRANCH_MISMATCH' });
    }
    const students = await getStudentsForScope({
      academyId,
      branchId: tournament.rama_id,
      categoryId: category.id,
      playerSelect: 'id,nombre,foto_base64,foto_url,avatar_url,tutor_id,tutor_principal_id,apoderado_id,telefono_apoderado',
    });
    return res.json({ success: true, data: students, categoria: category, torneo: tournament });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible cargar los alumnos elegibles.', code: error?.code });
  }
});

router.get('/:id/participantes', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const tournament = await getTournament(academyId, req.params.id);
    let query = supabase.from('torneo_participantes')
      .select('*,jugadores(id,nombre,foto_base64,foto_url,avatar_url),categorias(id,nombre),ramas(id,nombre,disciplina),sedes(id,nombre),inscripciones_deportivas(id,rol_especialidad)')
      .eq('torneo_id', tournament.id)
      .order('created_at', { ascending: false });
    const categoryId = safeText(req.query?.categoria_id, 80);
    if (categoryId) query = query.eq('categoria_id', categoryId);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ success: true, data: data || [], torneo: tournament });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar participantes.' });
  }
});

router.post('/:id/convocar', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const academyName = await getAcademyName(academyId);
    const tournament = await getTournament(academyId, req.params.id);
    if (!tournament.rama_id || !tournament.sede_id) {
      return res.status(409).json({ error: 'El torneo debe pertenecer a una rama antes de convocar.', code: 'TOURNAMENT_NOT_SCOPED' });
    }
    const categoryId = safeText(req.body?.categoria_id, 80);
    const { category } = await getCategoryContext(academyId, categoryId);
    if (String(category.rama_id) !== String(tournament.rama_id)) {
      return res.status(409).json({ error: 'La categoría seleccionada no pertenece a la rama del torneo.', code: 'CATEGORY_TOURNAMENT_BRANCH_MISMATCH' });
    }

    const requestedIds = uniqueIds(req.body?.jugadoresIds || req.body?.alumnos_ids);
    const eligible = await getStudentsForScope({
      academyId,
      branchId: tournament.rama_id,
      categoryId: category.id,
      playerIds: requestedIds.length ? requestedIds : undefined,
      playerSelect: 'id,nombre,tutor_id,tutor_principal_id,apoderado_id,telefono_apoderado',
    });
    if (!eligible.length) return res.status(400).json({ error: 'No hay alumnos con inscripción activa en esta rama y categoría.' });
    if (requestedIds.length && eligible.length !== requestedIds.length) {
      return res.status(409).json({ error: 'Uno o más alumnos seleccionados no tienen inscripción activa en la rama/categoría del torneo.', code: 'INVALID_TOURNAMENT_ROSTER' });
    }

    const tutorIds = uniqueIds(eligible.map((student) => getStudentTutorId(student)));
    let tutorMap = new Map();
    if (tutorIds.length) {
      const { data: tutors, error } = await supabase.from('tutores')
        .select('id,nombre_completo,telefono').eq('academia_id', academyId).in('id', tutorIds);
      if (error) throw error;
      tutorMap = new Map((tutors || []).map((tutor) => [String(tutor.id), tutor]));
    }

    const calls = eligible.map((student) => {
      const tutor = tutorMap.get(String(getStudentTutorId(student)));
      return {
        torneo_id: tournament.id,
        jugador_id: student.id,
        sede_id: tournament.sede_id,
        rama_id: tournament.rama_id,
        categoria_id: category.id,
        inscripcion_id: student.inscripcion?.id || null,
        telefono_apoderado: tutor?.telefono || student.telefono_apoderado || '',
        respuesta_participacion: 'Pendiente',
        pago_en_cuotas: false,
        numero_cuotas: 1,
        paso_bot: 'ESPERANDO_PARTICIPACION',
        estado_pago: 'Pendiente',
      };
    });
    const { error: participantError } = await supabase.from('torneo_participantes')
      .upsert(calls, { onConflict: 'torneo_id,jugador_id' });
    if (participantError) throw participantError;

    const price = Math.max(0, Number(tournament.costo_inscripcion) || 0);
    if (price > 0) {
      const charges = eligible.map((student) => ({
        academia_id: academyId,
        jugador_id: student.id,
        inscripcion_id: student.inscripcion?.id || null,
        sede_id: tournament.sede_id,
        rama_id: tournament.rama_id,
        torneo_id: tournament.id,
        concepto: `Inscripción ${tournament.nombre} · ${tournament.ramas?.disciplina || tournament.ramas?.nombre || 'Competencia'}`,
        tipo_concepto: 'Torneo',
        monto: price,
        monto_pagado: 0,
        estado: 'Pendiente',
        fecha_vencimiento: tournament.fecha_inicio || new Date().toISOString().slice(0, 10),
      }));
      const { error: chargeError } = await supabase.from('cobros')
        .upsert(charges, { onConflict: 'academia_id,jugador_id,torneo_id', ignoreDuplicates: true });
      if (chargeError) throw chargeError;
    }

    const profile = resolveCompetitiveProfile({ discipline: tournament.ramas?.disciplina || tournament.ramas?.nombre || 'Otro' });
    const priceText = price > 0 ? `$${price.toLocaleString('es-CL')}` : 'Gratuito';
    let sent = 0;
    for (const student of eligible) {
      const tutor = tutorMap.get(String(getStudentTutorId(student)));
      const phoneSource = tutor?.telefono || student.telefono_apoderado;
      if (!phoneSource) continue;
      let phone = String(phoneSource).replace(/\D/g, '');
      if (!phone.startsWith('56') && phone.length === 9) phone = `56${phone}`;
      const message = academyMessage(academyName,
        `🏆 *CONVOCATORIA · ${String(profile.label).toUpperCase()}*\n\n` +
        `*${student.nombre}* ha sido convocado/a a *${tournament.nombre}*.\n` +
        `${profile.icon} *Rama:* ${tournament.ramas?.nombre || profile.label}\n` +
        `🏷️ *Categoría:* ${category.nombre}\n` +
        `💰 *Valor inscripción:* ${priceText}\n` +
        (tournament.permite_cuotas ? `💳 *Pago:* hasta ${tournament.max_cuotas} cuotas.\n` : '') +
        `\nResponde:\n1️⃣ Confirmar participación\n2️⃣ Rechazar invitación`);
      try { await enviarMensaje(academyId, phone, message); sent += 1; }
      catch (sendError) { console.error(`No se pudo enviar convocatoria a ${student.nombre}:`, sendError?.message || sendError); }
    }

    return res.json({ success: true, message: `Convocatoria registrada para ${eligible.length} alumnos; ${sent} mensajes enviados.`, convocados: eligible.length, enviados: sent });
  } catch (error) {
    console.error('Error convocando torneo multirrama:', error?.message || error);
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible enviar la convocatoria.', code: error?.code });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const data = await getTournament(req.user.academia_id, req.params.id);
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar el torneo.' });
  }
});

module.exports = router;
