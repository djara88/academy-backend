const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { resolvePerformanceProfile, publicPerformanceProfile } = require('../services/performanceCatalog');
const { safeText } = require('../services/branchContext');

const router = express.Router();
router.use(authMiddleware);

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = (value, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round(number(value) * factor) / factor;
};

const aggregateValues = (definition, values) => {
  const clean = values.map(Number).filter(Number.isFinite);
  if (!clean.length) return 0;
  if (definition.aggregate === 'min') return Math.min(...clean);
  if (definition.aggregate === 'max') return Math.max(...clean);
  if (definition.aggregate === 'latest') return clean[0];
  return clean.reduce((sum, value) => sum + value, 0);
};

const buildPlayerLeaderboard = (profile, statsRows, playerMap) => {
  const grouped = new Map();
  for (const row of statsRows) {
    if (row.participo === false) continue;
    const key = String(row.jugador_id || '');
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, { jugador_id: key, participaciones: 0, titularidades: 0, minutos: 0, mvp: 0, values: {} });
    const item = grouped.get(key);
    item.participaciones += 1;
    if (row.titular) item.titularidades += 1;
    item.minutos += number(row.minutos);
    if (row.es_mvp) item.mvp += 1;
    const metrics = row.metricas_competitivas && typeof row.metricas_competitivas === 'object' ? row.metricas_competitivas : {};
    for (const definition of profile.metrics) {
      const value = Number(metrics[definition.code]);
      if (!Number.isFinite(value)) continue;
      if (!item.values[definition.code]) item.values[definition.code] = [];
      item.values[definition.code].push(value);
    }
  }

  return [...grouped.values()].map((item) => ({
    jugador_id: item.jugador_id,
    nombre: playerMap.get(item.jugador_id)?.nombre || 'Deportista',
    participaciones: item.participaciones,
    titularidades: item.titularidades,
    minutos: round(item.minutos, 1),
    mvp: item.mvp,
    metricas: profile.metrics.map((definition) => ({
      code: definition.code,
      label: definition.label,
      unit: definition.unit || null,
      decimals: definition.decimals || 0,
      value: round(aggregateValues(definition, item.values[definition.code] || []), definition.decimals || 0),
    })),
  })).sort((a, b) => (b.mvp - a.mvp) || (b.participaciones - a.participaciones) || (b.minutos - a.minutos));
};

const buildTeamSummary = (profile, matches) => profile.teamMetrics.map((definition) => {
  const values = matches.map((match) => Number(match.metricas_equipo?.[definition.code])).filter(Number.isFinite);
  const value = values.length ? values.reduce((sum, current) => sum + current, 0) / values.length : 0;
  return {
    code: definition.code,
    label: definition.label,
    unit: definition.unit || null,
    decimals: definition.decimals || 0,
    value: round(value, definition.decimals || 0),
    samples: values.length,
  };
});

router.get('/analitica', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const branchId = safeText(req.query?.rama_id, 80);
    const categoryId = safeText(req.query?.categoria_id, 80);
    const season = safeText(req.query?.temporada, 40);

    let matchQuery = supabase.from('partidos')
      .select('id,torneo_id,categoria_id,rama_id,disciplina_codigo,rival,fecha,estado,goles_favor,goles_contra,temporada,prueba_codigo,prueba_nombre,metricas_equipo,metricas_equipo_version,ramas(id,nombre,disciplina),categorias(id,nombre),torneos(id,nombre)')
      .eq('academia_id', academyId)
      .eq('estado', 'Jugado')
      .order('fecha', { ascending: false })
      .limit(500);
    if (branchId) matchQuery = matchQuery.eq('rama_id', branchId);
    if (categoryId) matchQuery = matchQuery.eq('categoria_id', categoryId);
    if (season) matchQuery = matchQuery.eq('temporada', season);

    const { data: matches, error: matchError } = await matchQuery;
    if (matchError) throw matchError;
    const eventRows = matches || [];
    const matchIds = eventRows.map((row) => row.id);

    let statsRows = [];
    if (matchIds.length) {
      const { data, error } = await supabase.from('partido_estadisticas')
        .select('partido_id,jugador_id,disciplina_codigo,metricas_competitivas,participo,titular,minutos,rol,es_mvp')
        .in('partido_id', matchIds);
      if (error) throw error;
      statsRows = data || [];
    }

    const playerIds = [...new Set(statsRows.map((row) => row.jugador_id).filter(Boolean))];
    let players = [];
    if (playerIds.length) {
      const { data, error } = await supabase.from('jugadores').select('id,nombre').eq('academia_id', academyId).in('id', playerIds);
      if (error) throw error;
      players = data || [];
    }
    const playerMap = new Map(players.map((row) => [String(row.id), row]));

    let marksQuery = supabase.from('deportista_marcas')
      .select('jugador_id,rama_id,partido_id,disciplina_codigo,prueba_codigo,prueba_nombre,metrica_codigo,metrica_label,valor,unidad,comparacion,temporada,fecha,es_pb,es_sb,valor_pb_anterior,valor_sb_anterior')
      .eq('academia_id', academyId)
      .order('fecha', { ascending: false })
      .limit(500);
    if (branchId) marksQuery = marksQuery.eq('rama_id', branchId);
    if (season) marksQuery = marksQuery.eq('temporada', season);
    const { data: marks, error: marksError } = await marksQuery;
    if (marksError) throw marksError;

    const byDiscipline = new Map();
    for (const match of eventRows) {
      const profile = resolvePerformanceProfile({ discipline: match.ramas?.disciplina, code: match.disciplina_codigo });
      const code = profile.code;
      if (!byDiscipline.has(code)) byDiscipline.set(code, { profile, matches: [], matchIds: new Set() });
      const bucket = byDiscipline.get(code);
      bucket.matches.push(match);
      bucket.matchIds.add(String(match.id));
    }

    const disciplines = [...byDiscipline.values()].map(({ profile, matches: disciplineMatches, matchIds: ids }) => {
      const disciplineStats = statsRows.filter((row) => ids.has(String(row.partido_id)) && row.participo !== false);
      const athleteIds = new Set(disciplineStats.map((row) => String(row.jugador_id)).filter(Boolean));
      const h2h = profile.usesHeadToHeadScore;
      let wins = 0; let draws = 0; let losses = 0; let scoreFor = 0; let scoreAgainst = 0;
      if (h2h) {
        for (const match of disciplineMatches) {
          const favor = number(match.goles_favor); const against = number(match.goles_contra);
          scoreFor += favor; scoreAgainst += against;
          if (favor > against) wins += 1; else if (favor === against) draws += 1; else losses += 1;
        }
      }
      return {
        profile: publicPerformanceProfile(profile),
        resumen: {
          eventos: disciplineMatches.length,
          deportistas: athleteIds.size,
          participaciones: disciplineStats.length,
          minutos: round(disciplineStats.reduce((sum, row) => sum + number(row.minutos), 0), 1),
          destacados: disciplineStats.filter((row) => row.es_mvp).length,
          victorias: wins,
          empates: draws,
          derrotas: losses,
          a_favor: scoreFor,
          en_contra: scoreAgainst,
        },
        metricas_equipo: buildTeamSummary(profile, disciplineMatches),
        deportistas_ranking: buildPlayerLeaderboard(profile, disciplineStats, playerMap).slice(0, 20),
        tendencia: disciplineMatches.slice().reverse().map((match) => ({
          id: match.id,
          fecha: match.fecha,
          evento: match.prueba_nombre || match.rival,
          competencia: match.torneos?.nombre || null,
          categoria: match.categorias?.nombre || null,
          resultado_favor: h2h ? number(match.goles_favor) : null,
          resultado_contra: h2h ? number(match.goles_contra) : null,
          metricas_equipo: match.metricas_equipo || {},
        })),
      };
    }).sort((a, b) => b.resumen.eventos - a.resumen.eventos);

    const activePB = (marks || []).filter((row) => row.es_pb);
    const activeSB = (marks || []).filter((row) => row.es_sb);
    const recentImprovements = (marks || []).filter((row) => {
      const previous = Number(row.valor_pb_anterior);
      if (!Number.isFinite(previous)) return true;
      const current = Number(row.valor);
      return row.comparacion === 'min' ? current < previous : current > previous;
    }).slice(0, 30).map((row) => ({ ...row, jugador_nombre: playerMap.get(String(row.jugador_id))?.nombre || 'Deportista' }));

    const totalStats = statsRows.filter((row) => row.participo !== false);
    const response = {
      filters: { rama_id: branchId || null, categoria_id: categoryId || null, temporada: season || null },
      resumen: {
        eventos: eventRows.length,
        disciplinas: disciplines.length,
        deportistas: new Set(totalStats.map((row) => String(row.jugador_id)).filter(Boolean)).size,
        participaciones: totalStats.length,
        minutos: round(totalStats.reduce((sum, row) => sum + number(row.minutos), 0), 1),
        destacados: totalStats.filter((row) => row.es_mvp).length,
        pb_vigentes: activePB.length,
        sb_vigentes: activeSB.length,
      },
      disciplinas: disciplines,
      marcas: {
        personal_bests: activePB.map((row) => ({ ...row, jugador_nombre: playerMap.get(String(row.jugador_id))?.nombre || 'Deportista' })),
        season_bests: activeSB.map((row) => ({ ...row, jugador_nombre: playerMap.get(String(row.jugador_id))?.nombre || 'Deportista' })),
        mejoras_recientes: recentImprovements,
      },
      truncated: eventRows.length >= 500 || (marks || []).length >= 500,
    };

    return res.json({ success: true, data: response });
  } catch (error) {
    console.error('Error cargando analítica avanzada:', error?.message || error);
    return res.status(500).json({ success: false, error: 'No fue posible cargar la analítica avanzada.' });
  }
});

module.exports = router;