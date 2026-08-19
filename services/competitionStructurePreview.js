const bySeed = (a, b) => {
  const seedA = Number.isFinite(Number(a?.seed)) ? Number(a.seed) : Number.MAX_SAFE_INTEGER;
  const seedB = Number.isFinite(Number(b?.seed)) ? Number(b.seed) : Number.MAX_SAFE_INTEGER;
  if (seedA !== seedB) return seedA - seedB;
  return String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es');
};

const competitorView = (row) => ({
  id: row.id,
  nombre: row.nombre,
  tipo: row.tipo,
  origen: row.origen,
  seed: row.seed ?? null,
});

const roundRobin = (rows = []) => {
  const competitors = [...rows].sort(bySeed).map(competitorView);
  if (competitors.length < 2) return [];
  const list = [...competitors];
  if (list.length % 2 === 1) list.push(null);
  const fixed = list[0];
  let rotating = list.slice(1);
  const rounds = [];
  for (let round = 0; round < list.length - 1; round += 1) {
    const current = [fixed, ...rotating];
    const matches = [];
    for (let index = 0; index < current.length / 2; index += 1) {
      const a = current[index];
      const b = current[current.length - 1 - index];
      if (!a || !b) continue;
      const flip = (round + index) % 2 === 1;
      matches.push({
        slot: index + 1,
        a: flip ? b : a,
        b: flip ? a : b,
      });
    }
    rounds.push({ round: round + 1, label: `Fecha ${round + 1}`, matches });
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, -1)];
  }
  return rounds;
};

const bracketSeedOrder = (size) => {
  if (size <= 2) return [1, 2];
  let order = [1, 2];
  while (order.length < size) {
    const sum = order.length * 2 + 1;
    order = order.flatMap((seed) => [seed, sum - seed]);
  }
  return order;
};

const nextPowerOfTwo = (value) => {
  let result = 1;
  while (result < Math.max(2, value)) result *= 2;
  return result;
};

const eliminationBracket = (rows = []) => {
  const competitors = [...rows].sort(bySeed).map(competitorView);
  if (!competitors.length) return { size: 0, matches: [] };
  const size = nextPowerOfTwo(competitors.length);
  const seedOrder = bracketSeedOrder(size);
  const bySeedPosition = new Map();
  competitors.forEach((competitor, index) => bySeedPosition.set(index + 1, competitor));
  const slots = seedOrder.map((seed) => bySeedPosition.get(seed) || null);
  const matches = [];
  for (let index = 0; index < slots.length; index += 2) {
    const a = slots[index];
    const b = slots[index + 1];
    matches.push({
      slot: index / 2 + 1,
      a,
      b,
      bye: Boolean(a) !== Boolean(b),
      empty: !a && !b,
    });
  }
  return { size, matches };
};

const grouped = (rows = [], groupSize = 4) => {
  const competitors = [...rows].sort(bySeed).map(competitorView);
  if (!competitors.length) return [];
  const safeSize = Math.max(2, Math.min(12, Math.round(Number(groupSize) || 4)));
  const groupCount = Math.max(1, Math.ceil(competitors.length / safeSize));
  const groups = Array.from({ length: groupCount }, (_, index) => ({
    code: String.fromCharCode(65 + index),
    label: `Grupo ${String.fromCharCode(65 + index)}`,
    competitors: [],
  }));
  competitors.forEach((competitor, index) => {
    const cycle = Math.floor(index / groupCount);
    const position = index % groupCount;
    const target = cycle % 2 === 0 ? position : groupCount - 1 - position;
    groups[target].competitors.push(competitor);
  });
  return groups.map((group) => ({ ...group, rounds: roundRobin(group.competitors) }));
};

const phaseView = (phase) => ({
  id: phase.id,
  nombre: phase.nombre,
  tipo: phase.tipo,
  orden: phase.orden,
});

const generateCompetitionPreview = ({ tournament, division, phases = [], competitors = [] }) => {
  const format = division?.formato_competencia || tournament?.formato_competencia || 'personalizado';
  const active = competitors.filter((item) => item.estado !== 'Inactivo').sort(bySeed);
  const config = { ...(tournament?.config_competencia || {}), ...(division?.config || {}) };
  const base = {
    format,
    competitorCount: active.length,
    competitors: active.map(competitorView),
    phases: [...phases].sort((a, b) => Number(a.orden || 0) - Number(b.orden || 0)).map(phaseView),
    persistsMatches: false,
  };

  if (format === 'liga') {
    return { ...base, mode: 'round_robin', rounds: roundRobin(active), note: 'Vista previa únicamente. Publicar el fixture será una acción separada.' };
  }

  if (format === 'eliminacion_directa') {
    return { ...base, mode: 'bracket', bracket: eliminationBracket(active), note: 'Los BYE se resolverán al publicar; ningún encuentro fue creado.' };
  }

  if (format === 'grupos_eliminacion') {
    const groups = grouped(active, config.group_size || 4);
    return {
      ...base,
      mode: 'groups_then_bracket',
      groups,
      qualification: { advancePerGroup: Math.max(1, Math.min(4, Number(config.advance_per_group) || 2)) },
      note: 'La llave de eliminación se completa después de conocer los clasificados de cada grupo.',
    };
  }

  if (format === 'pools') {
    return { ...base, mode: 'pools', groups: grouped(active, config.pool_size || config.group_size || 4), note: 'Los rankings de cada pool se calcularán desde los resultados publicados.' };
  }

  if (format === 'repechaje') {
    return {
      ...base,
      mode: 'bracket_with_repechage',
      bracket: eliminationBracket(active),
      secondaryStage: 'El repechaje se construye a partir de los resultados de la llave principal.',
      note: 'La vista previa muestra la llave principal; el repechaje depende de quién pierda contra los finalistas/semifinalistas según la regla configurada.',
    };
  }

  if (format === 'doble_eliminacion') {
    return {
      ...base,
      mode: 'double_elimination_outline',
      bracket: eliminationBracket(active),
      secondaryStage: 'Llave de perdedores derivada de los resultados.',
      note: 'Se muestra la siembra inicial. La llave de perdedores se encadena al publicar resultados, no en esta previsualización.',
    };
  }

  if (format === 'pruebas_ranking' || format === 'rondas_clasificacion') {
    return {
      ...base,
      mode: 'ranking_or_rounds',
      entries: active.map(competitorView),
      note: 'Cada deportista se registrará en las pruebas/rondas configuradas; la clasificación se calculará por marca, tiempo, puntaje o posición según la disciplina.',
    };
  }

  return {
    ...base,
    mode: 'manual',
    note: 'La estructura personalizada se construye con las fases definidas por Dirección. La vista previa no genera cruces automáticos.',
  };
};

module.exports = {
  generateCompetitionPreview,
  roundRobin,
  eliminationBracket,
  grouped,
};
