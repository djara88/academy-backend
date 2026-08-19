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
  const base = supabase.from('deportista_marcas');
  let result = await base.update({ es_pb: false })
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
  if (!recordMetrics.length || !Array.isArray(stats) || !stats.length) return { newPB: [], newSB: [], marks: [] };

  const testName = String(match.prueba_nombre || match.rival || profile.activityLabel || 'Evento').trim();
  const testCode = String(match.prueba_codigo || slugifyEvent(testName));
  const season = String(match.temporada || String(match.fecha || '').slice(0, 4) || new Date().getFullYear());
  const newPB = [];
  const newSB = [];
  const marks = [];

  for (const stat of stats) {
    for (const definition of recordMetrics) {
      const raw = stat.metricas_competitivas?.[definition.code];
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) continue;

      const rule = resolveRecordRule(profile, testName, definition);
      if (!rule) continue;

      const [previousPB, previousSB] = await Promise.all([
        bestMark({
          academyId,
          playerId: stat.jugador_id,
          disciplineCode: profile.code,
          testCode,
          metricCode: definition.code,
          compare: rule.compare,
          excludeMatchId: match.id,
        }),
        bestMark({
          academyId,
          playerId: stat.jugador_id,
          disciplineCode: profile.code,
          testCode,
          metricCode: definition.code,
          compare: rule.compare,
          season,
          excludeMatchId: match.id,
        }),
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
        .upsert(row, { onConflict: 'partido_id,jugador_id,metrica_codigo' })
        .select('*')
        .single();
      if (error) throw error;

      const flags = await recalculateFlags({
        academyId,
        playerId: stat.jugador_id,
        disciplineCode: profile.code,
        testCode,
        metricCode: definition.code,
        compare: rule.compare,
        season,
      });

      const enriched = { ...data, es_pb: flags.pb?.id === data.id, es_sb: flags.sb?.id === data.id };
      marks.push(enriched);
      if (isNewPB) newPB.push(enriched);
      if (isNewSB) newSB.push(enriched);
    }
  }

  return { newPB, newSB, marks };
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