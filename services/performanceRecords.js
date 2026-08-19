const supabase = require('../config/supabase');
const { resolveRecordRule, slugifyEvent } = require('./performanceCatalog');

const betterThan = (value, previous, compare) => {
  const current = Number(value);
  const before = Number(previous);
  if (!Number.isFinite(current)) return false;
  if (!Number.isFinite(before)) return true;
  return compare === 'min' ? current < before : current > before;
};

const orderAscending = (compare) => compare === 'min';
const groupKey = ({ playerId, disciplineCode, testCode, metricCode, compare, season }) =>
  [playerId, disciplineCode, testCode, metricCode, compare, season].map((item) => String(item ?? '')).join('::');

const bestMark = async ({ academyId, playerId, disciplineCode, testCode, metricCode, compare, season, excludeMatchId }) => {
  let query = supabase.from('deportista_marcas')
    .select('id,valor,fecha,partido_id,temporada')
    .eq('academia_id', academyId)
    .eq('jugador_id', playerId)
    .eq('disciplina_codigo', disciplineCode)
    .eq('prueba_codigo', testCode)
    .eq('metrica_codigo', metricCode);
  if (season) query = query.eq('temporada', season);
  if (excludeMatchId) query = query.neq('partido_id', excludeMatchId);
  const { data, error } = await query
    .order('valor', { ascending: orderAscending(compare) })
    .order('fecha', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

const recalculateFlags = async ({ academyId, playerId, disciplineCode, testCode, metricCode, compare, season }) => {
  let result = await supabase.from('deportista_marcas').update({ es_pb: false })
    .eq('academia_id', academyId)
    .eq('jugador_id', playerId)
    .eq('disciplina_codigo', disciplineCode)
    .eq('prueba_codigo', testCode)
    .eq('metrica_codigo', metricCode);
  if (result.error) throw result.error;

  result = await supabase.from('deportista_marcas').update({ es_sb: false })
    .eq('academia_id', academyId)
    .eq('jugador_id', playerId)
    .eq('disciplina_codigo', disciplineCode)
    .eq('prueba_codigo', testCode)
    .eq('metrica_codigo', metricCode)
    .eq('temporada', season);
  if (result.error) throw result.error;

  const [pb, sb] = await Promise.all([
    bestMark({ academyId, playerId, disciplineCode, testCode, metricCode, compare }),
    bestMark({ academyId, playerId, disciplineCode, testCode, metricCode, compare, season }),
  ]);

  if (pb?.id) {
    const { error } = await supabase.from('deportista_marcas').update({ es_pb: true }).eq('id', pb.id);
    if (error) throw error;
  }
  if (sb?.id) {
    const { error } = await supabase.from('deportista_marcas').update({ es_sb: true }).eq('id', sb.id);
    if (error) throw error;
  }
  return { pb, sb };
};

const syncPersonalRecords = async ({ academyId, match, profile, stats }) => {
  const recordMetrics = (profile.metrics || []).filter((item) => item.record);
  const testName = String(match.prueba_nombre || match.rival || profile.activityLabel || 'Evento').trim();
  const testCode = String(match.prueba_codigo || slugifyEvent(testName));
  const season = String(match.temporada || String(match.fecha || '').slice(0, 4) || new Date().getFullYear());
  const newPB = [];
  const newSB = [];
  const marks = [];
  const groups = new Map();

  // Al editar un evento, retiramos primero sus marcas anteriores. Así una corrección
  // a "no participó", cero o una prueba distinta nunca deja un PB/SB fantasma.
  const { data: previousRows, error: previousError } = await supabase.from('deportista_marcas')
    .select('jugador_id,disciplina_codigo,prueba_codigo,metrica_codigo,comparacion,temporada')
    .eq('academia_id', academyId)
    .eq('partido_id', match.id);
  if (previousError) throw previousError;

  for (const row of previousRows || []) {
    const config = {
      playerId: row.jugador_id,
      disciplineCode: row.disciplina_codigo,
      testCode: row.prueba_codigo,
      metricCode: row.metrica_codigo,
      compare: row.comparacion,
      season: row.temporada,
    };
    groups.set(groupKey(config), config);
  }

  if ((previousRows || []).length) {
    const { error: deleteError } = await supabase.from('deportista_marcas')
      .delete()
      .eq('academia_id', academyId)
      .eq('partido_id', match.id);
    if (deleteError) throw deleteError;
  }

  if (recordMetrics.length && Array.isArray(stats) && stats.length) {
    for (const stat of stats) {
      for (const definition of recordMetrics) {
        const raw = stat.metricas_competitivas?.[definition.code];
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) continue;

        const rule = resolveRecordRule(profile, testName, definition);
        if (!rule) continue;
        const config = {
          playerId: stat.jugador_id,
          disciplineCode: profile.code,
          testCode,
          metricCode: definition.code,
          compare: rule.compare,
          season,
        };
        groups.set(groupKey(config), config);

        // Como ya retiramos la fila anterior del evento, estos son los verdaderos
        // PB/SB previos contra los cuales debe compararse la nueva corrección.
        const [previousPB, previousSB] = await Promise.all([
          bestMark({ academyId, ...config }),
          bestMark({ academyId, ...config, season }),
        ]);

        const isNewPB = betterThan(value, previousPB?.valor, rule.compare);
        const isNewSB = betterThan(value, previousSB?.valor, rule.compare);
        const row = {
          academia_id: academyId,
          jugador_id: stat.jugador_id,
          rama_id: match.rama_id || null,
          partido_id: match.id,
          disciplina_codigo: profile.code,
          prueba_codigo: testCode,
          prueba_nombre: testName,
          metrica_codigo: definition.code,
          metrica_label: definition.label,
          valor: value,
          unidad: rule.unit || definition.unit || null,
          comparacion: rule.compare,
          temporada: season,
          fecha: match.fecha,
          es_pb: false,
          es_sb: false,
          valor_pb_anterior: previousPB?.valor ?? null,
          valor_sb_anterior: previousSB?.valor ?? null,
          metadata: { source: 'eventos_rendimiento', metric_version: match.metricas_equipo_version || 1 },
          updated_at: new Date().toISOString(),
        };

        const { data, error } = await supabase.from('deportista_marcas')
          .insert(row)
          .select('*')
          .single();
        if (error) throw error;

        marks.push({ ...data, _wasNewPB: isNewPB, _wasNewSB: isNewSB });
      }
    }
  }

  // Recalcular tanto los grupos actuales como aquellos que desaparecieron por una
  // edición. Esto garantiza un único PB y un único SB vigentes por prueba/métrica.
  const flagsByGroup = new Map();
  for (const [key, config] of groups) {
    flagsByGroup.set(key, await recalculateFlags({ academyId, ...config }));
  }

  const enrichedMarks = marks.map((row) => {
    const config = {
      playerId: row.jugador_id,
      disciplineCode: row.disciplina_codigo,
      testCode: row.prueba_codigo,
      metricCode: row.metrica_codigo,
      compare: row.comparacion,
      season: row.temporada,
    };
    const flags = flagsByGroup.get(groupKey(config)) || {};
    const enriched = {
      ...row,
      es_pb: flags.pb?.id === row.id,
      es_sb: flags.sb?.id === row.id,
    };
    delete enriched._wasNewPB;
    delete enriched._wasNewSB;
    return enriched;
  });

  for (let index = 0; index < marks.length; index += 1) {
    const source = marks[index];
    const enriched = enrichedMarks[index];
    if (source._wasNewPB && enriched.es_pb) newPB.push(enriched);
    if (source._wasNewSB && enriched.es_sb) newSB.push(enriched);
  }

  return { newPB, newSB, marks: enrichedMarks };
};

const getCurrentRecordSummary = async ({ academyId, playerIds, disciplineCode, testCode }) => {
  if (!playerIds?.length || !testCode) return {};
  const { data, error } = await supabase.from('deportista_marcas')
    .select('jugador_id,prueba_codigo,prueba_nombre,metrica_codigo,metrica_label,valor,unidad,temporada,fecha,es_pb,es_sb')
    .eq('academia_id', academyId)
    .eq('disciplina_codigo', disciplineCode)
    .eq('prueba_codigo', testCode)
    .in('jugador_id', playerIds)
    .or('es_pb.eq.true,es_sb.eq.true')
    .order('fecha', { ascending: false });
  if (error) throw error;
  const grouped = {};
  for (const row of data || []) {
    const key = String(row.jugador_id);
    if (!grouped[key]) grouped[key] = { pb: [], sb: [] };
    if (row.es_pb) grouped[key].pb.push(row);
    if (row.es_sb) grouped[key].sb.push(row);
  }
  return grouped;
};

module.exports = {
  syncPersonalRecords,
  getCurrentRecordSummary,
};