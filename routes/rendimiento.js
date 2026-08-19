const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarMensaje } = require('../services/whatsappService');
const { academyMessage, getAcademyName } = require('../services/academyIdentity');
const { getStudentsForScope, safeText } = require('../services/branchContext');
const {
  PERFORMANCE_VERSION,
  resolvePerformanceProfile,
  publicPerformanceProfile,
  sanitizeMetricMap,
  slugifyEvent,
  formatMetric,
} = require('../services/performanceCatalog');
const { syncPersonalRecords, getCurrentRecordSummary } = require('../services/performanceRecords');

const router = express.Router();
router.use(authMiddleware);

const MATCH_SELECT = '*,torneos(id,nombre),categorias(id,nombre,rama_id,sede_id),ramas(id,nombre,disciplina),sedes(id,nombre)';
const FIELD_EVENT_PATTERN = /(salto|lanzamiento|peso|disco|jabalina|martillo|altura|longitud|garrocha|triple)/i;

const formatElapsedTimeForFamily = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  const totalMs = Math.max(0, Math.round(number * 1000));
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  const parts = [];
  if (minutes > 0) parts.push(`${minutes} min`);
  parts.push(`${seconds} seg`);
  if (millis > 0) parts.push(`${String(millis).padStart(3, '0')} ms`);
  return parts.join(' ');
};

const isTimedMetricForFamily = (profile, definition, testName) => {
  if (definition?.unit === 's') return true;
  if (profile?.code === 'atletismo' && definition?.code === 'marca') {
    return !FIELD_EVENT_PATTERN.test(String(testName || ''));
  }
  return false;
};

const formatMetricForFamily = (profile, definition, value, testName) => {
  if (isTimedMetricForFamily(profile, definition, testName)) {
    const time = formatElapsedTimeForFamily(value);
    return time ? `Tiempo oficial: ${time}` : null;
  }
  return formatMetric(definition, value);
};

const formatRecordForFamily = (record) => {
  if (!record) return '';
  if (record.unidad === 's') return formatElapsedTimeForFamily(record.valor) || '';
  const value = Number(record.valor);
  const text = Number.isFinite(value)
    ? value.toLocaleString('es-CL', { maximumFractionDigits: 3 })
    : String(record.valor ?? '');
  return `${text}${record.unidad ? ` ${record.unidad}` : ''}`.trim();
};

const loadMatch = async (academyId, matchId) => {
  const { data, error } = await supabase.from('partidos')
    .select(MATCH_SELECT)
    .eq('id', matchId)
    .eq('academia_id', academyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Evento no encontrado.'), { status: 404 });
  return data;
};

const profileForMatch = (match) => resolvePerformanceProfile({
  discipline: match.ramas?.disciplina,
  code: match.disciplina_codigo,
});

const profileForBranch = async (academyId, branchId) => {
  const { data, error } = await supabase.from('ramas')
    .select('id,nombre,disciplina,sede_id')
    .eq('id', branchId)
    .eq('academia_id', academyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Rama deportiva no encontrada.'), { status: 404 });
  return { branch: data, profile: resolvePerformanceProfile({ discipline: data.disciplina }) };
};

const legacyColumns = (profile, metrics) => {
  if (!['futbol', 'futsal'].includes(profile.code)) {
    return { goles: 0, asistencias: 0, tarjetas_amarillas: 0, tarjetas_rojas: 0 };
  }
  return {
    goles: Number(metrics.goles) || 0,
    asistencias: Number(metrics.asistencias) || 0,
    tarjetas_amarillas: Number(metrics.tarjetas_amarillas) || 0,
    tarjetas_rojas: Number(metrics.tarjetas_rojas) || 0,
  };
};

const loadRoster = async (academyId, match) => {
  const { data: citations, error } = await supabase.from('partido_citaciones')
    .select('jugador_id,respuesta,jugadores(id,nombre,foto_base64)')
    .eq('partido_id', match.id)
    .eq('respuesta', 'Si');
  if (error) throw error;
  const confirmed = (citations || []).filter((item) => item.jugadores).map((item) => item.jugadores);
  if (confirmed.length) return { players: confirmed, source: 'citaciones' };

  if (!match.rama_id || !match.categoria_id) return { players: [], source: 'sin_contexto' };
  const students = await getStudentsForScope({
    academyId,
    branchId: match.rama_id,
    categoryId: match.categoria_id,
    playerSelect: 'id,nombre,foto_base64',
  });
  return { players: students, source: 'categoria' };
};

const assertStatsRoster = async (academyId, match, submittedStats) => {
  const requestedIds = [...new Set((submittedStats || [])
    .map((row) => safeText(row?.jugador_id, 80))
    .filter(Boolean))];
  if (!requestedIds.length) return;
  const roster = await loadRoster(academyId, match);
  const allowed = new Set((roster.players || []).map((player) => String(player.id)));
  const invalid = requestedIds.filter((id) => !allowed.has(String(id)));
  if (invalid.length) {
    throw Object.assign(new Error('Las estadísticas contienen uno o más deportistas fuera del plantel válido de este evento.'), {
      status: 403,
      code: 'INVALID_EVENT_ROSTER',
    });
  }
};

router.get('/perfil', async (req, res) => {
  try {
    const branchId = safeText(req.query?.rama_id, 80);
    if (!branchId) return res.status(400).json({ success: false, error: 'Selecciona una rama deportiva.' });
    const { branch, profile } = await profileForBranch(req.user.academia_id, branchId);
    return res.json({ success: true, data: { ...publicPerformanceProfile(profile), branch } });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar el perfil de rendimiento.' });
  }
});

router.get('/:id/estadisticas', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const match = await loadMatch(academyId, req.params.id);
    const profile = profileForMatch(match);
    const roster = await loadRoster(academyId, match);
    const playerIds = roster.players.map((player) => player.id);

    let stats = [];
    if (playerIds.length) {
      const result = await supabase.from('partido_estadisticas')
        .select('*')
        .eq('partido_id', match.id)
        .in('jugador_id', playerIds);
      if (result.error) throw result.error;
      stats = result.data || [];
    }
    const statsMap = new Map(stats.map((row) => [String(row.jugador_id), row]));
    const testCode = String(match.prueba_codigo || slugifyEvent(match.prueba_nombre || match.rival));
    const records = await getCurrentRecordSummary({
      academyId,
      playerIds,
      disciplineCode: profile.code,
      testCode,
    });

    const players = roster.players.map((player) => {
      const row = statsMap.get(String(player.id)) || {};
      return {
        jugador_id: player.id,
        nombre: player.nombre,
        foto_base64: player.foto_base64 || null,
        metricas_competitivas: sanitizeMetricMap(row.metricas_competitivas || {}, profile.metrics),
        participo: row.participo !== false,
        titular: Boolean(row.titular),
        minutos: Number(row.minutos) || 0,
        rol: row.rol || '',
        observaciones: row.observaciones || '',
        es_mvp: Boolean(row.es_mvp),
        records: records[String(player.id)] || { pb: [], sb: [] },
      };
    });

    return res.json({
      success: true,
      data: players,
      profile: publicPerformanceProfile(profile),
      team_metrics: sanitizeMetricMap(match.metricas_equipo || {}, profile.teamMetrics),
      context: {
        roster_source: roster.source,
        temporada: match.temporada || String(match.fecha || '').slice(0, 4),
        prueba_codigo: testCode,
        prueba_nombre: match.prueba_nombre || match.rival,
      },
    });
  } catch (error) {
    console.error('Error cargando rendimiento del evento:', error?.message || error);
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar el rendimiento.' });
  }
});

router.post('/:id/guardar-resultado', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const match = await loadMatch(academyId, req.params.id);
    const profile = profileForMatch(match);
    const submittedStats = Array.isArray(req.body?.estadisticas) ? req.body.estadisticas : [];
    await assertStatsRoster(academyId, match, submittedStats);

    const teamMetrics = sanitizeMetricMap(req.body?.metricas_equipo || {}, profile.teamMetrics);
    const scoreFavor = Math.max(0, Number(req.body?.resultado_favor ?? req.body?.goles_favor) || 0);
    const scoreContra = Math.max(0, Number(req.body?.resultado_contra ?? req.body?.goles_contra) || 0);
    const season = safeText(req.body?.temporada, 40) || match.temporada || String(match.fecha || '').slice(0, 4) || String(new Date().getFullYear());
    const testName = safeText(req.body?.prueba_nombre, 180) || match.prueba_nombre || match.rival || profile.activityLabel;
    const testCode = safeText(req.body?.prueba_codigo, 120) || match.prueba_codigo || slugifyEvent(testName);

    const { data: updatedMatch, error: matchError } = await supabase.from('partidos')
      .update({
        goles_favor: profile.usesHeadToHeadScore ? scoreFavor : 0,
        goles_contra: profile.usesHeadToHeadScore ? scoreContra : 0,
        disciplina_codigo: profile.code,
        metricas_equipo: teamMetrics,
        metricas_equipo_version: PERFORMANCE_VERSION,
        temporada: season,
        prueba_codigo: profile.metrics.some((item) => item.record) ? testCode : null,
        prueba_nombre: profile.metrics.some((item) => item.record) ? testName : null,
        estado: 'Jugado',
      })
      .eq('id', match.id)
      .eq('academia_id', academyId)
      .select(MATCH_SELECT)
      .single();
    if (matchError) throw matchError;

    let mvpAssigned = false;
    const normalizedStats = submittedStats.map((row) => {
      const playerId = safeText(row?.jugador_id, 80);
      if (!playerId) return null;
      const metrics = sanitizeMetricMap(row.metricas_competitivas || row.metricas || {}, profile.metrics);
      const participated = row.participo !== false;
      const isMvp = participated && Boolean(row.es_mvp) && !mvpAssigned;
      if (isMvp) mvpAssigned = true;
      return {
        partido_id: match.id,
        jugador_id: playerId,
        disciplina_codigo: profile.code,
        metricas_competitivas: metrics,
        metricas_version: PERFORMANCE_VERSION,
        participo: participated,
        titular: participated && Boolean(row.titular),
        minutos: participated ? Math.max(0, Math.min(10000, Number(row.minutos) || 0)) : 0,
        rol: participated ? (safeText(row.rol, 100) || null) : null,
        observaciones: safeText(row.observaciones, 1500) || null,
        es_mvp: isMvp,
        ...legacyColumns(profile, metrics),
      };
    }).filter(Boolean);

    if (normalizedStats.length) {
      const { error } = await supabase.from('partido_estadisticas')
        .upsert(normalizedStats, { onConflict: 'partido_id,jugador_id' });
      if (error) throw error;
    }

    const recordResult = await syncPersonalRecords({
      academyId,
      match: updatedMatch,
      profile,
      stats: normalizedStats.filter((row) => row.participo),
    });

    if (req.body?.enviarWhatsapp === true && normalizedStats.length) {
      const academyName = await getAcademyName(academyId);
      const playerIds = normalizedStats.map((row) => row.jugador_id);
      const { data: players, error: playerError } = await supabase.from('jugadores')
        .select('id,nombre,tutor_id,tutor_principal_id,apoderado_id,telefono_apoderado')
        .eq('academia_id', academyId)
        .in('id', playerIds);
      if (playerError) throw playerError;
      const tutorIds = [...new Set((players || []).map((player) => player.tutor_id || player.tutor_principal_id || player.apoderado_id).filter(Boolean))];
      let tutors = [];
      if (tutorIds.length) {
        const result = await supabase.from('tutores').select('id,nombre_completo,telefono').eq('academia_id', academyId).in('id', tutorIds);
        if (result.error) throw result.error;
        tutors = result.data || [];
      }
      const tutorMap = new Map(tutors.map((row) => [String(row.id), row]));
      const playerMap = new Map((players || []).map((row) => [String(row.id), row]));
      const pbByPlayer = new Map();
      const sbByPlayer = new Map();
      for (const row of recordResult.newPB) pbByPlayer.set(String(row.jugador_id), row);
      for (const row of recordResult.newSB) if (!pbByPlayer.has(String(row.jugador_id))) sbByPlayer.set(String(row.jugador_id), row);

      for (const stat of normalizedStats) {
        const player = playerMap.get(String(stat.jugador_id));
        if (!player) continue;
        const tutorId = player.tutor_id || player.tutor_principal_id || player.apoderado_id;
        const tutor = tutorMap.get(String(tutorId));
        const source = tutor?.telefono || player.telefono_apoderado;
        if (!source) continue;
        let phone = String(source).replace(/\D/g, '');
        if (!phone.startsWith('56') && phone.length === 9) phone = `56${phone}`;

        const metricsText = profile.metrics.map((definition) => {
          const value = stat.metricas_competitivas?.[definition.code];
          if (!Number.isFinite(Number(value)) || Number(value) <= 0) return null;
          const line = formatMetricForFamily(profile, definition, value, testName);
          return line ? `• ${line}` : null;
        }).filter(Boolean).slice(0, 12).join('\n');
        const participation = stat.participo
          ? `Participación: ${stat.titular ? 'titular' : 'participó'}${stat.minutos > 0 ? ` · ${stat.minutos} min` : ''}${stat.rol ? ` · ${stat.rol}` : ''}`
          : 'Participación: no participó';
        const pb = pbByPlayer.get(String(stat.jugador_id));
        const sb = sbByPlayer.get(String(stat.jugador_id));
        const recordText = pb
          ? `\n🏆 *Nueva marca personal:* ${formatRecordForFamily(pb)}`
          : sb ? `\n📈 *Mejor marca de la temporada:* ${formatRecordForFamily(sb)}` : '';
        const resultLine = profile.usesHeadToHeadScore
          ? `${profile.scoreLabel}: ${academyName} ${scoreFavor} - ${scoreContra} ${match.rival}`
          : `${profile.activityLabel}: ${testName}`;

        const message = academyMessage(academyName,
          `📊 *EVENTOS Y RENDIMIENTO · ${profile.label.toUpperCase()}*\n\n` +
          `Resumen de *${player.nombre}*\n${resultLine}\n${participation}\n\n` +
          `${metricsText || 'Participación registrada.'}${stat.es_mvp ? '\n🌟 Deportista destacado/a' : ''}${recordText}\n\n` +
          `Estos datos forman parte de su historial deportivo en Lestra.`);
        try { await enviarMensaje(academyId, phone, message); }
        catch (sendError) { console.error(`No se pudo enviar rendimiento a ${player.nombre}:`, sendError?.message || sendError); }
      }
    }

    return res.json({
      success: true,
      message: 'Resultado y rendimiento guardados correctamente.',
      profile: publicPerformanceProfile(profile),
      records: {
        nuevas_pb: recordResult.newPB,
        nuevas_sb: recordResult.newSB,
        pb_count: recordResult.newPB.length,
        sb_count: recordResult.newSB.length,
      },
    });
  } catch (error) {
    console.error('Error guardando Eventos y Rendimiento:', error?.message || error);
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible guardar el rendimiento.', code: error?.code });
  }
});

router.get('/jugador/:jugadorId/resumen', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const playerId = safeText(req.params.jugadorId, 80);
    const { data: player, error: playerError } = await supabase.from('jugadores')
      .select('id,nombre')
      .eq('id', playerId)
      .eq('academia_id', academyId)
      .maybeSingle();
    if (playerError) throw playerError;
    if (!player) return res.status(404).json({ success: false, error: 'Deportista no encontrado.' });

    let marksQuery = supabase.from('deportista_marcas')
      .select('disciplina_codigo,prueba_codigo,prueba_nombre,metrica_codigo,metrica_label,valor,unidad,comparacion,temporada,fecha,es_pb,es_sb')
      .eq('academia_id', academyId)
      .eq('jugador_id', playerId)
      .order('fecha', { ascending: false });
    const branchId = safeText(req.query?.rama_id, 80);
    if (branchId) marksQuery = marksQuery.eq('rama_id', branchId);
    const { data: marks, error: marksError } = await marksQuery;
    if (marksError) throw marksError;

    return res.json({
      success: true,
      data: {
        player,
        personal_bests: (marks || []).filter((row) => row.es_pb),
        season_bests: (marks || []).filter((row) => row.es_sb),
        history: marks || [],
      },
    });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar el historial de rendimiento.' });
  }
});

module.exports = router;