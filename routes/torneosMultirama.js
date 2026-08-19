const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarMensaje } = require('../services/whatsappService');
const { academyMessage, getAcademyName } = require('../services/academyIdentity');
const { resolveCompetitiveProfile } = require('../services/competitiveStatsCatalog');
const { getFormat, publicCompetitionArchitecture } = require('../services/competitionFormatCatalog');
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

const requireOrganizedTournament = (tournament) => {
  if (tournament?.tipo_gestion !== 'organizado') {
    throw Object.assign(new Error('La estructura interna solo se configura cuando la academia organiza la competencia.'), { status: 409, code: 'TOURNAMENT_EXTERNAL_STRUCTURE' });
  }
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

router.get('/formatos', async (req, res) => {
  try {
    const branch = await resolveTournamentBranch(req.user.academia_id, req.query?.rama_id);
    return res.json({ success: true, data: publicCompetitionArchitecture({ discipline: branch.disciplina }) });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar los formatos de competencia.', code: error?.code });
  }
});

router.post('/', async (req, res) => {
  let tournament = null;
  try {
    const academyId = req.user.academia_id;
    const branch = await resolveTournamentBranch(academyId, req.body?.rama_id);
    const name = safeText(req.body?.nombre, 180);
    if (!name) return res.status(400).json({ success: false, error: 'El nombre del torneo es obligatorio.' });

    const managementType = safeText(req.body?.tipo_gestion, 30) === 'organizado' ? 'organizado' : 'externo';
    const architecture = publicCompetitionArchitecture({ discipline: branch.disciplina });
    const defaultFormat = managementType === 'externo'
      ? 'seguimiento'
      : (architecture.formats.find((item) => item.structure)?.code || 'personalizado');
    const formatCode = safeText(req.body?.formato_competencia, 50) || defaultFormat;
    if (!getFormat(formatCode) || !architecture.formats.some((item) => item.code === formatCode)) {
      return res.status(400).json({ success: false, error: 'El formato seleccionado no corresponde al perfil competitivo de esta rama.', code: 'INVALID_COMPETITION_FORMAT' });
    }
    if (managementType === 'externo' && formatCode !== 'seguimiento') {
      return res.status(400).json({ success: false, error: 'Los campeonatos externos se registran en modo seguimiento. Lestra no debe reemplazar la estructura oficial administrada por terceros.', code: 'EXTERNAL_TOURNAMENT_TRACKING_ONLY' });
    }

    const allowsInstallments = req.body?.permite_cuotas === true;
    const { data, error } = await supabase.from('torneos').insert({
      academia_id: academyId,
      sede_id: branch.sede_id,
      rama_id: branch.id,
      nombre: name,
      fecha_inicio: req.body?.fecha_inicio || null,
      fecha_fin: req.body?.fecha_fin || null,
      tipo_gestion: managementType,
      formato_competencia: formatCode,
      organizador: safeText(req.body?.organizador, 180) || null,
      ubicacion: safeText(req.body?.ubicacion, 300) || null,
      reglamento_url: safeText(req.body?.reglamento_url, 1000) || null,
      config_competencia: req.body?.config_competencia && typeof req.body.config_competencia === 'object' && !Array.isArray(req.body.config_competencia)
        ? req.body.config_competencia
        : {},
      estructura_estado: managementType === 'organizado' ? 'borrador' : 'no_aplica',
      costo_inscripcion: Math.max(0, Number(req.body?.costo_inscripcion) || 0),
      permite_cuotas: allowsInstallments,
      max_cuotas: allowsInstallments ? Math.max(2, Math.min(12, Math.round(Number(req.body?.max_cuotas) || 2))) : 1,
      estado: safeText(req.body?.estado, 40) || 'Activo',
    }).select('*,ramas(id,nombre,disciplina),sedes(id,nombre)').single();
    if (error) throw error;
    tournament = data;

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

router.get('/:id/estructura', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const tournament = await getTournament(academyId, req.params.id);
    const architecture = publicCompetitionArchitecture({ discipline: tournament.ramas?.disciplina });
    if (tournament.tipo_gestion !== 'organizado') {
      return res.json({ success: true, data: { torneo: tournament, arquitectura: architecture, divisiones: [], fases: [], competidores: [] } });
    }
    const [{ data: divisions, error: divisionError }, { data: phases, error: phaseError }, { data: competitors, error: competitorError }] = await Promise.all([
      supabase.from('torneo_divisiones').select('*,categorias(id,nombre)').eq('academia_id', academyId).eq('torneo_id', tournament.id).order('orden').order('created_at'),
      supabase.from('torneo_fases').select('*').eq('academia_id', academyId).eq('torneo_id', tournament.id).order('orden').order('created_at'),
      supabase.from('torneo_competidores').select('id,division_id,tipo,origen,nombre,jugador_id,categoria_id,seed,estado,metadata').eq('academia_id', academyId).eq('torneo_id', tournament.id).order('seed', { ascending: true, nullsFirst: false }).order('created_at'),
    ]);
    if (divisionError) throw divisionError;
    if (phaseError) throw phaseError;
    if (competitorError) throw competitorError;
    return res.json({ success: true, data: { torneo: tournament, arquitectura: architecture, divisiones: divisions || [], fases: phases || [], competidores: competitors || [] } });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar la estructura de la competencia.', code: error?.code });
  }
});

router.post('/:id/divisiones', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const tournament = await getTournament(academyId, req.params.id);
    requireOrganizedTournament(tournament);
    const name = safeText(req.body?.nombre, 140);
    if (!name) return res.status(400).json({ success: false, error: 'Ingresa el nombre de la división o modalidad.' });
    let categoryId = safeText(req.body?.categoria_id, 80) || null;
    if (categoryId) {
      const { category } = await getCategoryContext(academyId, categoryId);
      if (String(category.rama_id) !== String(tournament.rama_id)) {
        return res.status(409).json({ success: false, error: 'La categoría seleccionada pertenece a otra rama.', code: 'DIVISION_CATEGORY_BRANCH_MISMATCH' });
      }
      categoryId = category.id;
    }
    const { data: lastRows, error: orderError } = await supabase.from('torneo_divisiones').select('orden').eq('torneo_id', tournament.id).order('orden', { ascending: false }).limit(1);
    if (orderError) throw orderError;
    const order = Math.max(0, Number(lastRows?.[0]?.orden) || 0) + 1;
    const { data, error } = await supabase.from('torneo_divisiones').insert({
      academia_id: academyId,
      torneo_id: tournament.id,
      categoria_id: categoryId,
      nombre: name,
      modalidad: safeText(req.body?.modalidad, 140) || null,
      formato_competencia: safeText(req.body?.formato_competencia, 50) || tournament.formato_competencia,
      orden: order,
      config: req.body?.config && typeof req.body.config === 'object' && !Array.isArray(req.body.config) ? req.body.config : {},
    }).select('*,categorias(id,nombre)').single();
    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible crear la división.', code: error?.code });
  }
});

router.post('/:id/fases', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const tournament = await getTournament(academyId, req.params.id);
    requireOrganizedTournament(tournament);
    const name = safeText(req.body?.nombre, 140);
    const type = safeText(req.body?.tipo, 60);
    if (!name || !type) return res.status(400).json({ success: false, error: 'Ingresa nombre y tipo de fase.' });
    const divisionId = safeText(req.body?.division_id, 80) || null;
    if (divisionId) {
      const { data: division, error: divisionError } = await supabase.from('torneo_divisiones').select('id').eq('id', divisionId).eq('torneo_id', tournament.id).eq('academia_id', academyId).maybeSingle();
      if (divisionError) throw divisionError;
      if (!division) return res.status(404).json({ success: false, error: 'La división no pertenece a este campeonato.' });
    }
    let orderQuery = supabase.from('torneo_fases').select('orden').eq('torneo_id', tournament.id);
    if (divisionId) orderQuery = orderQuery.eq('division_id', divisionId); else orderQuery = orderQuery.is('division_id', null);
    const { data: lastRows, error: orderError } = await orderQuery.order('orden', { ascending: false }).limit(1);
    if (orderError) throw orderError;
    const order = Math.max(0, Number(lastRows?.[0]?.orden) || 0) + 1;
    const { data, error } = await supabase.from('torneo_fases').insert({
      academia_id: academyId,
      torneo_id: tournament.id,
      division_id: divisionId,
      nombre: name,
      tipo: type,
      orden: order,
      estado: 'Borrador',
      config: req.body?.config && typeof req.body.config === 'object' && !Array.isArray(req.body.config) ? req.body.config : {},
    }).select('*').single();
    if (error) throw error;
    await supabase.from('torneos').update({ estructura_estado: 'borrador' }).eq('id', tournament.id).eq('academia_id', academyId);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible crear la fase.', code: error?.code });
  }
});

router.delete('/:id/fases/:faseId', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const tournament = await getTournament(academyId, req.params.id);
    requireOrganizedTournament(tournament);
    const { error } = await supabase.from('torneo_fases').delete().eq('id', req.params.faseId).eq('torneo_id', tournament.id).eq('academia_id', academyId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible eliminar la fase.', code: error?.code });
  }
});

router.delete('/:id/divisiones/:divisionId', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const tournament = await getTournament(academyId, req.params.id);
    requireOrganizedTournament(tournament);
    const { error } = await supabase.from('torneo_divisiones').delete().eq('id', req.params.divisionId).eq('torneo_id', tournament.id).eq('academia_id', academyId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible eliminar la división.', code: error?.code });
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

    const eligibleIds = eligible.map((student) => student.id);
    const { data: existingParticipants, error: existingError } = await supabase
      .from('torneo_participantes')
      .select('id,jugador_id,categoria_id,respuesta_participacion,pago_en_cuotas,numero_cuotas,paso_bot,estado_pago,created_at')
      .eq('torneo_id', tournament.id)
      .in('jugador_id', eligibleIds)
      .order('created_at', { ascending: true });
    if (existingError) throw existingError;

    const existingByPlayer = new Map();
    for (const row of existingParticipants || []) {
      const key = String(row.jugador_id);
      if (!existingByPlayer.has(key)) existingByPlayer.set(key, []);
      existingByPlayer.get(key).push(row);
    }

    const tutorIds = uniqueIds(eligible.map((student) => getStudentTutorId(student)));
    let tutorMap = new Map();
    if (tutorIds.length) {
      const { data: tutors, error } = await supabase.from('tutores')
        .select('id,nombre_completo,telefono').eq('academia_id', academyId).in('id', tutorIds);
      if (error) throw error;
      tutorMap = new Map((tutors || []).map((tutor) => [String(tutor.id), tutor]));
    }

    const notificationMode = new Map();
    const calls = eligible.map((student) => {
      const tutor = tutorMap.get(String(getStudentTutorId(student)));
      const history = existingByPlayer.get(String(student.id)) || [];
      const sameCategory = history.find((row) => String(row.categoria_id || '') === String(category.id));
      const confirmed = history.find((row) => row.respuesta_participacion === 'Si');
      const pending = history.find((row) => ['ESPERANDO_PARTICIPACION', 'ESPERANDO_CUOTAS'].includes(row.paso_bot));
      const rejected = history.find((row) => row.respuesta_participacion === 'No');
      const source = sameCategory || pending || confirmed || rejected || history[0] || null;

      let mode = 'initial';
      let response = 'Pendiente';
      let installments = false;
      let installmentCount = 1;
      let botStep = 'ESPERANDO_PARTICIPACION';
      let paymentStatus = 'Pendiente';

      if (sameCategory) {
        mode = 'same_category';
        response = sameCategory.respuesta_participacion || 'Pendiente';
        installments = Boolean(sameCategory.pago_en_cuotas);
        installmentCount = Math.max(1, Number(sameCategory.numero_cuotas) || 1);
        botStep = sameCategory.paso_bot || 'FINALIZADO';
        paymentStatus = sameCategory.estado_pago || 'Pendiente';
      } else if (confirmed) {
        mode = 'additional_confirmed';
        response = 'Si';
        installments = Boolean(confirmed.pago_en_cuotas);
        installmentCount = Math.max(1, Number(confirmed.numero_cuotas) || 1);
        botStep = 'FINALIZADO';
        paymentStatus = confirmed.estado_pago || 'Pendiente';
      } else if (pending) {
        mode = 'additional_pending';
        response = 'Pendiente';
        installments = Boolean(pending.pago_en_cuotas);
        installmentCount = Math.max(1, Number(pending.numero_cuotas) || 1);
        botStep = 'FINALIZADO';
        paymentStatus = pending.estado_pago || 'Pendiente';
      } else if (rejected) {
        mode = 'reinvite';
      } else if (source) {
        mode = 'additional_pending';
        response = source.respuesta_participacion || 'Pendiente';
        installments = Boolean(source.pago_en_cuotas);
        installmentCount = Math.max(1, Number(source.numero_cuotas) || 1);
        botStep = 'FINALIZADO';
        paymentStatus = source.estado_pago || 'Pendiente';
      }

      notificationMode.set(String(student.id), mode);
      return {
        torneo_id: tournament.id,
        jugador_id: student.id,
        sede_id: tournament.sede_id,
        rama_id: tournament.rama_id,
        categoria_id: category.id,
        inscripcion_id: student.inscripcion?.id || null,
        telefono_apoderado: tutor?.telefono || student.telefono_apoderado || '',
        respuesta_participacion: response,
        pago_en_cuotas: installments,
        numero_cuotas: installmentCount,
        paso_bot: botStep,
        estado_pago: paymentStatus,
      };
    });
    const { error: participantError } = await supabase.from('torneo_participantes')
      .upsert(calls, { onConflict: 'torneo_id,jugador_id,categoria_id' });
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
    let additional = 0;
    let unchanged = 0;
    for (const student of eligible) {
      const mode = notificationMode.get(String(student.id)) || 'initial';
      if (mode === 'same_category') { unchanged += 1; continue; }

      const tutor = tutorMap.get(String(getStudentTutorId(student)));
      const phoneSource = tutor?.telefono || student.telefono_apoderado;
      if (!phoneSource) continue;
      let phone = String(phoneSource).replace(/\D/g, '');
      if (!phone.startsWith('56') && phone.length === 9) phone = `56${phone}`;

      let body = '';
      if (mode === 'additional_confirmed') {
        additional += 1;
        body = `🏷️ *ACTUALIZACIÓN DE CONVOCATORIA*\n\n` +
          `*${student.nombre}* también quedó registrado/a en *${category.nombre}* para *${tournament.nombre}*.\n` +
          `✅ Tu confirmación al torneo sigue vigente.\n` +
          `💰 *Inscripción única:* esta categoría adicional no genera un cobro extra.\n\n` +
          `No necesitas responder a este aviso.`;
      } else if (mode === 'additional_pending') {
        additional += 1;
        body = `🏷️ *ACTUALIZACIÓN DE CONVOCATORIA*\n\n` +
          `*${student.nombre}* también quedó registrado/a en *${category.nombre}* para *${tournament.nombre}*.\n` +
          `💰 *Inscripción única:* esta categoría adicional no genera un cobro extra.\n\n` +
          `ℹ️ No necesitas responder a este aviso. La convocatoria inicial sigue pendiente; responde *1* o *2* al mensaje de confirmación.`;
      } else if (mode === 'reinvite') {
        body = `🔄 *CONVOCATORIA ACTUALIZADA · ${String(profile.label).toUpperCase()}*\n\n` +
          `*${student.nombre}* fue incorporado/a también a *${category.nombre}* en *${tournament.nombre}*.\n` +
          `💰 *Inscripción única:* ${priceText}; no se cobra nuevamente por esta categoría.\n\n` +
          `Como la convocatoria anterior había sido rechazada, necesitamos confirmar nuevamente:\n` +
          `1️⃣ Confirmar participación\n2️⃣ Rechazar invitación`;
      } else {
        body = `🏆 *CONVOCATORIA · ${String(profile.label).toUpperCase()}*\n\n` +
          `*${student.nombre}* ha sido convocado/a a *${tournament.nombre}*.\n` +
          `${profile.icon} *Rama:* ${tournament.ramas?.nombre || profile.label}\n` +
          `🏷️ *Categoría:* ${category.nombre}\n` +
          `💰 *Valor inscripción:* ${priceText}\n` +
          (tournament.permite_cuotas ? `💳 *Pago:* hasta ${tournament.max_cuotas} cuotas.\n` : '') +
          `\nResponde:\n1️⃣ Confirmar participación\n2️⃣ Rechazar invitación`;
      }

      try { await enviarMensaje(academyId, phone, academyMessage(academyName, body)); sent += 1; }
      catch (sendError) { console.error(`No se pudo enviar convocatoria a ${student.nombre}:`, sendError?.message || sendError); }
    }

    return res.json({
      success: true,
      message: `Registro actualizado para ${eligible.length} alumnos; ${sent} mensajes enviados.`,
      convocados: eligible.length,
      enviados: sent,
      categorias_adicionales: additional,
      ya_registrados: unchanged,
      cobro_unico_por_torneo: true,
    });
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
