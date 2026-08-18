// routes/partidos.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarMensaje } = require('../services/whatsappService');
const { academyMessage, getAcademyName } = require('../services/academyIdentity');
const {
  COMPETITIVE_STATS_VERSION,
  publicProfile,
  resolveCompetitiveProfile,
  sanitizeCompetitiveMetrics,
  metricsFromRow,
  legacyStatColumns,
  formatCompetitiveMetric,
} = require('../services/competitiveStatsCatalog');

const getPlayerTutorId = (player) => player?.tutor_id || player?.tutor_principal_id || player?.apoderado_id || null;

const normalizeTime = (value) => {
  const time = String(value || '').trim().slice(0, 5);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : null;
};

const subtractMinutes = (time, amount) => {
  const [hours, minutes] = time.split(':').map(Number);
  const total = (hours * 60 + minutes - amount + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

const validateSchedule = (matchTimeValue, callTimeValue) => {
  const matchTime = normalizeTime(matchTimeValue);
  if (!matchTime) throw Object.assign(new Error('Selecciona una hora de encuentro válida.'), { status: 400 });
  const callTime = normalizeTime(callTimeValue) || subtractMinutes(matchTime, 60);
  const [matchHour, matchMinute] = matchTime.split(':').map(Number);
  const [callHour, callMinute] = callTime.split(':').map(Number);
  if (callHour * 60 + callMinute >= matchHour * 60 + matchMinute) {
    throw Object.assign(new Error('La citación debe ser anterior a la hora del encuentro.'), { status: 400 });
  }
  return { matchTime, callTime };
};

const resolveCategoryContext = async (academyId, categoryId) => {
  if (!categoryId) {
    const profile = resolveCompetitiveProfile({ discipline: 'Otro' });
    return { category: null, branch: null, profile };
  }

  const { data: category, error: categoryError } = await supabase
    .from('categorias')
    .select('id,nombre,sede_id,rama_id')
    .eq('id', categoryId)
    .eq('academia_id', academyId)
    .maybeSingle();
  if (categoryError) throw categoryError;
  if (!category) throw Object.assign(new Error('La categoría seleccionada no pertenece a la academia.'), { status: 400 });

  let branch = null;
  if (category.rama_id) {
    const { data, error } = await supabase
      .from('ramas')
      .select('id,nombre,disciplina,sede_id')
      .eq('id', category.rama_id)
      .eq('academia_id', academyId)
      .maybeSingle();
    if (error) throw error;
    branch = data || null;
  }

  const profile = resolveCompetitiveProfile({ discipline: branch?.disciplina || 'Otro' });
  return { category, branch, profile };
};

const getAcademyMatch = async (academyId, matchId) => {
  const { data: match, error } = await supabase
    .from('partidos')
    .select('*, torneos(nombre), categorias(nombre)')
    .eq('id', matchId)
    .eq('academia_id', academyId)
    .maybeSingle();
  if (error) throw error;
  if (!match) throw Object.assign(new Error('No se encontró el encuentro.'), { status: 404 });

  let profile = resolveCompetitiveProfile({ code: match.disciplina_codigo });
  if ((!match.disciplina_codigo || profile.code === 'generico') && match.rama_id) {
    const { data: branch, error: branchError } = await supabase
      .from('ramas')
      .select('disciplina')
      .eq('id', match.rama_id)
      .eq('academia_id', academyId)
      .maybeSingle();
    if (branchError) throw branchError;
    if (branch?.disciplina) profile = resolveCompetitiveProfile({ discipline: branch.disciplina });
  }

  return { match, profile };
};

const decorateMatch = (match) => ({
  ...match,
  sport_profile: publicProfile(resolveCompetitiveProfile({ code: match.disciplina_codigo })),
});

// 1. CREAR ENCUENTRO
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const {
      torneo_id, categoria_id, es_amistoso, rival, fecha, hora, hora_citacion,
      ubicacion, link_maps, color_uniforme, condicion, cobra_arbitraje, monto_arbitraje_jugador,
    } = req.body;

    const { matchTime, callTime } = validateSchedule(hora, hora_citacion);
    const context = await resolveCategoryContext(academia_id, categoria_id || null);
    const { data, error } = await supabase
      .from('partidos')
      .insert([{
        academia_id,
        torneo_id: es_amistoso ? null : (torneo_id || null),
        categoria_id: categoria_id || null,
        sede_id: context.category?.sede_id || context.branch?.sede_id || null,
        rama_id: context.category?.rama_id || context.branch?.id || null,
        disciplina_codigo: context.profile.code,
        es_amistoso: Boolean(es_amistoso),
        rival,
        fecha,
        hora: matchTime,
        hora_citacion: callTime,
        ubicacion: ubicacion || '',
        link_maps: link_maps || '',
        color_uniforme: color_uniforme || 'Titular',
        condicion: condicion || 'Local',
        cobra_arbitraje: Boolean(cobra_arbitraje),
        monto_arbitraje_jugador: cobra_arbitraje ? (Number(monto_arbitraje_jugador) || 0) : 0,
        estado: 'Programado',
      }])
      .select('*, torneos(nombre), categorias(nombre)')
      .single();

    if (error) throw error;

    res.json({ success: true, data: { ...data, sport_profile: publicProfile(context.profile) } });
  } catch (error) {
    console.error('Error al crear encuentro:', error);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// 2. OBTENER ENCUENTROS
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { torneo_id, tipo } = req.query;

    let query = supabase
      .from('partidos')
      .select('*, torneos(nombre), categorias(nombre)')
      .eq('academia_id', academia_id)
      .order('fecha', { ascending: false });

    if (torneo_id) query = query.eq('torneo_id', torneo_id);
    else if (tipo === 'amistosos') query = query.eq('es_amistoso', true);
    else if (tipo === 'torneo') query = query.eq('es_amistoso', false);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, data: (data || []).map(decorateMatch) });
  } catch (error) {
    console.error('Error al obtener encuentros:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. EDITAR ENCUENTRO
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const {
      torneo_id, categoria_id, es_amistoso, rival, fecha, hora, hora_citacion,
      ubicacion, link_maps, color_uniforme, condicion, cobra_arbitraje,
      monto_arbitraje_jugador, estado,
    } = req.body;

    await getAcademyMatch(academia_id, req.params.id);
    const { matchTime, callTime } = validateSchedule(hora, hora_citacion);
    const context = await resolveCategoryContext(academia_id, categoria_id || null);
    const { data, error } = await supabase
      .from('partidos')
      .update({
        torneo_id: es_amistoso ? null : (torneo_id || null),
        categoria_id: categoria_id || null,
        sede_id: context.category?.sede_id || context.branch?.sede_id || null,
        rama_id: context.category?.rama_id || context.branch?.id || null,
        disciplina_codigo: context.profile.code,
        es_amistoso: Boolean(es_amistoso),
        rival,
        fecha,
        hora: matchTime,
        hora_citacion: callTime,
        ubicacion: ubicacion || '',
        link_maps: link_maps || '',
        color_uniforme: color_uniforme || 'Titular',
        condicion: condicion || 'Local',
        cobra_arbitraje: Boolean(cobra_arbitraje),
        monto_arbitraje_jugador: cobra_arbitraje ? (Number(monto_arbitraje_jugador) || 0) : 0,
        ...(estado && { estado }),
      })
      .eq('id', req.params.id)
      .eq('academia_id', academia_id)
      .select('*, torneos(nombre), categorias(nombre)')
      .single();

    if (error) throw error;
    res.json({ success: true, data: { ...data, sport_profile: publicProfile(context.profile) } });
  } catch (error) {
    console.error('Error al editar encuentro:', error);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// 4. ELIMINAR ENCUENTRO
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    await getAcademyMatch(academia_id, req.params.id);
    const { error } = await supabase.from('partidos').delete().eq('id', req.params.id).eq('academia_id', academia_id);
    if (error) throw error;
    res.json({ success: true, message: 'Encuentro eliminado correctamente.' });
  } catch (error) {
    console.error('Error al eliminar encuentro:', error);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// 5. DISPARAR CITACIÓN POR WHATSAPP + COBRO DE ARBITRAJE AUTOMÁTICO
router.post('/:id/citacion', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const academyName = await getAcademyName(academia_id);
    const partido_id = req.params.id;
    const { match: partido, profile } = await getAcademyMatch(academia_id, partido_id);

    if (!partido.categoria_id) throw Object.assign(new Error('Este encuentro no tiene una categoría asignada.'), { status: 400 });

    const { data: rels, error: relError } = await supabase
      .from('jugador_categoria')
      .select('jugador_id')
      .eq('categoria_id', partido.categoria_id);
    if (relError) throw relError;

    const jugadorIds = (rels || []).map((row) => row.jugador_id).filter(Boolean);
    if (jugadorIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No hay deportistas registrados en esta categoría.' });
    }

    const { data: jugadores, error: playerError } = await supabase
      .from('jugadores')
      .select('*')
      .eq('academia_id', academia_id)
      .in('id', jugadorIds);
    if (playerError) throw playerError;

    const tutorIds = (jugadores || []).map((j) => j.tutor_id || j.apoderado_id || j.tutor_principal_id).filter(Boolean);
    const tutoresMap = {};
    if (tutorIds.length > 0) {
      const { data: tutores, error: tutorError } = await supabase.from('tutores').select('*')
        .eq('academia_id', academia_id).in('id', tutorIds);
      if (tutorError) throw tutorError;
      (tutores || []).forEach((t) => { tutoresMap[t.id] = t; });
    }

    const citaciones = (jugadores || []).map((j) => {
      const idTutor = j.tutor_id || j.apoderado_id || j.tutor_principal_id;
      const tutor = tutoresMap[idTutor];
      return {
        partido_id,
        jugador_id: j.id,
        telefono_apoderado: tutor?.telefono || j.telefono || '',
        respuesta: 'Pendiente',
        paso_bot: 'ESPERANDO_CITACION',
      };
    });

    const { error: citationError } = await supabase
      .from('partido_citaciones')
      .upsert(citaciones, { onConflict: 'partido_id, jugador_id', ignoreDuplicates: true });
    if (citationError) throw citationError;

    const valArbitraje = Number(partido.monto_arbitraje_jugador) || 0;
    if (partido.cobra_arbitraje && valArbitraje > 0) {
      const cobrosPartidos = (jugadores || []).map((j) => ({
        academia_id,
        sede_id: partido.sede_id || null,
        rama_id: partido.rama_id || null,
        jugador_id: j.id,
        partido_id,
        concepto: `${profile.activityLabel} · arbitraje/jueces · ${partido.rival}`,
        tipo_concepto: 'Partido',
        monto: valArbitraje,
        monto_pagado: 0,
        estado: 'Pendiente',
        fecha_vencimiento: partido.fecha,
      }));

      try {
        const { error: errCobros } = await supabase
          .from('cobros')
          .upsert(cobrosPartidos, { onConflict: 'academia_id,jugador_id,partido_id', ignoreDuplicates: true });
        if (errCobros) throw errCobros;
        await supabase.from('jugadores').update({ estado_financiero: 'Moroso' })
          .eq('academia_id', academia_id).in('id', jugadorIds);
      } catch (errFin) {
        console.error('Detalle creando cobros de encuentro:', errFin.message);
      }
    }

    const tipoTexto = partido.es_amistoso ? `🤝 *${profile.activityLabel.toUpperCase()} AMISTOSO*` : `🏆 *TORNEO: ${partido.torneos?.nombre || ''}*`;
    const condicionTag = partido.condicion === 'Visita' ? '✈️ *Condición:* Visita' : '🏠 *Condición:* Local';
    const arbitrajeTexto = partido.cobra_arbitraje
      ? `\n⚖️ *Arbitraje / jueces:* $${Number(partido.monto_arbitraje_jugador).toLocaleString('es-CL')} por deportista`
      : '';
    const mapsTexto = partido.link_maps ? `\n📍 *Ubicación:* ${partido.link_maps}` : '';
    const opponentPrefix = profile.usesHeadToHeadScore ? 'vs ' : '';

    for (const j of jugadores || []) {
      const idTutor = j.tutor_id || j.apoderado_id || j.tutor_principal_id;
      const tutor = tutoresMap[idTutor];
      const telefono = tutor?.telefono || j.telefono;
      if (!telefono) continue;

      let numLimpio = telefono.replace(/\D/g, '');
      if (!numLimpio.startsWith('56') && numLimpio.length === 9) numLimpio = `56${numLimpio}`;

      const mensaje = academyMessage(academyName, `📋 *CITACIÓN · ${profile.label.toUpperCase()}*\n\n` +
        `Hola, te escribimos de *${academyName}*.\n` +
        `*${j.nombre}* ha sido citado/a para el próximo encuentro:\n\n` +
        `${tipoTexto}\n` +
        `${profile.icon} *${profile.opponentLabel}:* ${opponentPrefix}${partido.rival}\n` +
        `🏷️ *Categoría:* ${partido.categorias?.nombre || 'General'}\n` +
        `${condicionTag}\n` +
        `📅 *Fecha:* ${partido.fecha}\n` +
        `📣 *Citación:* ${partido.hora_citacion || subtractMinutes(String(partido.hora).slice(0, 5), 60)} hrs\n` +
        `⏰ *Inicio:* ${partido.hora} hrs\n` +
        `🏟️ *Lugar:* ${partido.ubicacion || 'Por confirmar'}` +
        `${mapsTexto}\n` +
        `👕 *Indumentaria:* ${partido.color_uniforme}` +
        `${arbitrajeTexto}\n\n` +
        `Por favor responde a este mensaje:\n` +
        `1️⃣ Para *CONFIRMAR* asistencia.\n` +
        `2️⃣ Si *NO PODRÁ ASISTIR*.`);

      try {
        await enviarMensaje(academia_id, numLimpio, mensaje);
      } catch (err) {
        console.error(`Error enviando citación a ${j.nombre}:`, err.message);
      }
    }

    res.json({ success: true, message: 'Citaciones enviadas con éxito.' });
  } catch (error) {
    console.error('Error al enviar citaciones:', error);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// 6. OBTENER CITACIONES
router.get('/:id/citaciones', authMiddleware, async (req, res) => {
  try {
    await getAcademyMatch(req.user.academia_id, req.params.id);
    const { data, error } = await supabase
      .from('partido_citaciones')
      .select('*, jugadores(nombre, foto_base64)')
      .eq('partido_id', req.params.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// 7. OBTENER ESTADÍSTICAS DEL ENCUENTRO PARA EL FORMULARIO
router.get('/:id/estadisticas', authMiddleware, async (req, res) => {
  try {
    const partido_id = req.params.id;
    const { profile } = await getAcademyMatch(req.user.academia_id, partido_id);

    const { data: citaciones, error: errCit } = await supabase
      .from('partido_citaciones')
      .select('jugador_id, jugadores(id, nombre, foto_base64)')
      .eq('partido_id', partido_id)
      .eq('respuesta', 'Si');
    if (errCit) throw errCit;

    const { data: stats, error: statsError } = await supabase
      .from('partido_estadisticas')
      .select('*')
      .eq('partido_id', partido_id);
    if (statsError) throw statsError;

    const statsMap = {};
    (stats || []).forEach((row) => { statsMap[row.jugador_id] = row; });

    const jugadoresConStats = (citaciones || []).filter((citation) => citation.jugadores).map((citation) => {
      const row = statsMap[citation.jugador_id] || {};
      const competitiveMetrics = metricsFromRow(row, profile);
      return {
        jugador_id: citation.jugadores.id,
        nombre: citation.jugadores.nombre,
        foto_base64: citation.jugadores.foto_base64,
        metricas_competitivas: competitiveMetrics,
        es_mvp: Boolean(row.es_mvp),
        ...legacyStatColumns(profile, competitiveMetrics),
      };
    });

    res.json({ success: true, data: jugadoresConStats, profile: publicProfile(profile) });
  } catch (error) {
    console.error('Error al obtener estadísticas:', error);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// 8. GUARDAR RESULTADO E INFORME
router.post('/:id/guardar-resultado', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const academyName = await getAcademyName(academia_id);
    const partido_id = req.params.id;
    const { match: currentMatch, profile } = await getAcademyMatch(academia_id, partido_id);
    const submittedStats = Array.isArray(req.body?.estadisticas) ? req.body.estadisticas : [];
    const enviarWhatsapp = req.body?.enviarWhatsapp === true;
    const scoreFavor = Number(req.body?.resultado_favor ?? req.body?.goles_favor) || 0;
    const scoreContra = Number(req.body?.resultado_contra ?? req.body?.goles_contra) || 0;

    const { data: partido, error: errP } = await supabase
      .from('partidos')
      .update({
        goles_favor: profile.usesHeadToHeadScore ? scoreFavor : 0,
        goles_contra: profile.usesHeadToHeadScore ? scoreContra : 0,
        disciplina_codigo: profile.code,
        estado: 'Jugado',
      })
      .eq('id', partido_id)
      .eq('academia_id', academia_id)
      .select('*, torneos(nombre), categorias(nombre)')
      .single();
    if (errP) throw errP;

    const submittedIds = [...new Set(submittedStats.map((row) => String(row?.jugador_id || '').trim()).filter(Boolean))];
    let allowedPlayerIds = new Set();
    if (submittedIds.length) {
      const { data: academyPlayers, error: academyPlayersError } = await supabase
        .from('jugadores')
        .select('id')
        .eq('academia_id', academia_id)
        .in('id', submittedIds);
      if (academyPlayersError) throw academyPlayersError;
      allowedPlayerIds = new Set((academyPlayers || []).map((row) => row.id));
    }

    let mvpAssigned = false;
    const normalizedStats = submittedStats.filter((row) => allowedPlayerIds.has(row.jugador_id)).map((row) => {
      const competitiveMetrics = sanitizeCompetitiveMetrics(
        row.metricas_competitivas || row.metricas || row,
        profile,
      );
      const isMvp = Boolean(row.es_mvp) && !mvpAssigned;
      if (isMvp) mvpAssigned = true;
      return {
        partido_id,
        jugador_id: row.jugador_id,
        disciplina_codigo: profile.code,
        metricas_competitivas: competitiveMetrics,
        metricas_version: COMPETITIVE_STATS_VERSION,
        es_mvp: isMvp,
        ...legacyStatColumns(profile, competitiveMetrics),
      };
    });

    if (normalizedStats.length > 0) {
      const { error: errUpsert } = await supabase
        .from('partido_estadisticas')
        .upsert(normalizedStats, { onConflict: 'partido_id, jugador_id' });
      if (errUpsert) throw errUpsert;
    }

    if (enviarWhatsapp && normalizedStats.length > 0) {
      const jugadorIds = normalizedStats.map((row) => row.jugador_id);
      const { data: jugadores, error: playersError } = await supabase
        .from('jugadores')
        .select('id,nombre,tutor_id,tutor_principal_id,apoderado_id,telefono_apoderado')
        .eq('academia_id', academia_id)
        .in('id', jugadorIds);
      if (playersError) throw playersError;

      const tutorIds = (jugadores || []).map((j) => getPlayerTutorId(j)).filter(Boolean);
      let tutores = [];
      if (tutorIds.length) {
        const tutorResult = await supabase
          .from('tutores')
          .select('id,telefono,nombre_completo')
          .eq('academia_id', academia_id)
          .in('id', tutorIds);
        if (tutorResult.error) throw tutorResult.error;
        tutores = tutorResult.data || [];
      }

      const tutorMap = Object.fromEntries(tutores.map((row) => [row.id, row]));
      const jugMap = Object.fromEntries((jugadores || []).map((row) => [row.id, row]));

      let resultadoEmoji = `🏅 ${profile.activityLabel.toUpperCase()} REGISTRADO`;
      let mensajeFormativo = 'Cada competencia es una oportunidad para observar avances, aprender y definir el próximo foco de trabajo.';
      if (profile.usesHeadToHeadScore) {
        if (scoreFavor > scoreContra) {
          resultadoEmoji = '🎉 ¡VICTORIA!';
          mensajeFormativo = 'Cada victoria es fruto del trabajo en equipo, la humildad y la constancia. A seguir entrenando con la misma intensidad.';
        } else if (scoreFavor === scoreContra) {
          resultadoEmoji = '🤝 EMPATE';
          mensajeFormativo = 'Cada encuentro es una oportunidad para crecer juntos. Gran esfuerzo y compromiso del equipo.';
        } else {
          resultadoEmoji = '💪 ¡A SEGUIR MEJORANDO!';
          mensajeFormativo = `En ${academyName}, un resultado no define el proceso: usamos cada competencia para aprender, ajustar y volver más fuertes.`;
        }
      }

      const resultLine = profile.usesHeadToHeadScore
        ? `${profile.icon} *${profile.scoreLabel}:* ${academyName} ${scoreFavor} - ${scoreContra} ${currentMatch.rival}`
        : `${profile.icon} *${profile.opponentLabel}:* ${currentMatch.rival}`;

      for (const stat of normalizedStats) {
        const jug = jugMap[stat.jugador_id];
        if (!jug) continue;
        const tutor = tutorMap[getPlayerTutorId(jug)];
        const sourcePhone = tutor?.telefono || jug.telefono_apoderado || '';
        if (!sourcePhone) continue;

        let numLimpio = String(sourcePhone).replace(/\D/g, '');
        if (!numLimpio.startsWith('56') && numLimpio.length === 9) numLimpio = `56${numLimpio}`;

        const metricsTxt = profile.metrics
          .map((definition) => {
            const value = stat.metricas_competitivas?.[definition.code];
            if (!Number.isFinite(Number(value)) || Number(value) <= 0) return null;
            const formatted = formatCompetitiveMetric(definition, value);
            return formatted ? `• *${formatted}*` : null;
          })
          .filter(Boolean)
          .join('\n');
        const mvpTxt = stat.es_mvp ? '\n🌟 *Deportista destacado/a del encuentro*' : '';
        const individualSummary = metricsTxt || '✔️ Participación registrada con compromiso y entrega.';

        const mensajePersonalizado = academyMessage(academyName, `📊 *REPORTE · ${profile.label.toUpperCase()}*\n\n` +
          `Hola ${tutor.nombre_completo || 'Apoderado/a'},\n` +
          `Compartimos el resumen de *${jug.nombre}* en ${profile.activityLabel.toLowerCase()} de la categoría *${partido.categorias?.nombre || ''}*:\n\n` +
          `${resultLine}\n` +
          `${resultadoEmoji}\n\n` +
          `🏃 *Desempeño individual:*\n${individualSummary}${mvpTxt}\n\n` +
          `🌱 *Reflexión formativa:*\n_${mensajeFormativo}_\n\n` +
          `Gracias por acompañar su desarrollo deportivo. ${profile.icon}`);

        try {
          await enviarMensaje(academia_id, numLimpio, mensajePersonalizado);
        } catch (errWs) {
          console.error(`Error enviando resumen individual a ${numLimpio}:`, errWs.message);
        }
      }
    }

    res.json({
      success: true,
      message: enviarWhatsapp ? 'Resultado guardado e informes enviados.' : 'Resultado guardado correctamente.',
      profile: publicProfile(profile),
    });
  } catch (error) {
    console.error('Error al guardar resultado:', error);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

module.exports = router;
