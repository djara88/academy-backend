const { resolveDisciplineCode } = require('./evaluationCatalog');

const COMPETITIVE_STATS_VERSION = 1;

const TEAM_EVENT_CODES = new Set(['futbol', 'futsal', 'basquetbol', 'voleibol', 'hockey', 'rugby']);
const RACKET_EVENT_CODES = new Set(['tenis', 'padel']);
const EQUIPMENT_META = Object.freeze({
  tenis: { label: 'Indumentaria / equipamiento', placeholder: 'Ej: camiseta oficial, raqueta y accesorios' },
  padel: { label: 'Indumentaria / equipamiento', placeholder: 'Ej: camiseta oficial, pala y accesorios' },
  natacion: { label: 'Implementación / indumentaria', placeholder: 'Ej: traje de baño, gorro y lentes' },
  atletismo: { label: 'Indumentaria / implementos', placeholder: 'Ej: uniforme oficial, clavos o implemento de prueba' },
  gimnasia: { label: 'Indumentaria / implementos', placeholder: 'Ej: malla oficial o implementos requeridos' },
  karate: { label: 'Indumentaria / protección', placeholder: 'Ej: karategi blanco, cinturón y protecciones' },
  artes_marciales: { label: 'Indumentaria / protección', placeholder: 'Ej: uniforme, guantes, casco o protector' },
});

const eventUiForProfile = (profile) => {
  const code = profile?.code || 'generico';
  if (TEAM_EVENT_CODES.has(code)) {
    return { conditionMode: 'required', equipmentMode: 'uniform', equipmentLabel: 'Indumentaria', equipmentPlaceholder: null };
  }
  const meta = EQUIPMENT_META[code] || { label: 'Indumentaria / equipamiento', placeholder: 'Ej: equipamiento o implementación requerida' };
  return {
    conditionMode: RACKET_EVENT_CODES.has(code) ? 'optional' : 'hidden',
    equipmentMode: 'freeform',
    equipmentLabel: meta.label,
    equipmentPlaceholder: meta.placeholder,
  };
};

const metric = (code, label, options = {}) => Object.freeze({
  code,
  label,
  aggregate: options.aggregate || 'sum',
  unit: options.unit || null,
  decimals: Number.isInteger(options.decimals) ? options.decimals : 0,
  legacyField: options.legacyField || null,
});

const PROFILES = Object.freeze({
  futbol: {
    code: 'futbol', label: 'Fútbol', icon: '⚽', activityLabel: 'Partido', opponentLabel: 'Rival', scoreLabel: 'Goles', usesHeadToHeadScore: true,
    metrics: [
      metric('goles', 'Goles', { legacyField: 'goles' }),
      metric('asistencias', 'Asistencias', { legacyField: 'asistencias' }),
      metric('tarjetas_amarillas', 'Amarillas', { legacyField: 'tarjetas_amarillas' }),
      metric('tarjetas_rojas', 'Rojas', { legacyField: 'tarjetas_rojas' }),
    ],
  },
  futsal: {
    code: 'futsal', label: 'Futsal', icon: '⚽', activityLabel: 'Partido', opponentLabel: 'Rival', scoreLabel: 'Goles', usesHeadToHeadScore: true,
    metrics: [
      metric('goles', 'Goles', { legacyField: 'goles' }),
      metric('asistencias', 'Asistencias', { legacyField: 'asistencias' }),
      metric('tarjetas_amarillas', 'Amarillas', { legacyField: 'tarjetas_amarillas' }),
      metric('tarjetas_rojas', 'Rojas', { legacyField: 'tarjetas_rojas' }),
    ],
  },
  basquetbol: {
    code: 'basquetbol', label: 'Básquetbol', icon: '🏀', activityLabel: 'Partido', opponentLabel: 'Rival', scoreLabel: 'Puntos', usesHeadToHeadScore: true,
    metrics: [
      metric('puntos', 'Puntos'), metric('rebotes', 'Rebotes'), metric('asistencias', 'Asistencias'),
      metric('robos', 'Robos'), metric('tapones', 'Tapones'), metric('triples', 'Triples'),
    ],
  },
  voleibol: {
    code: 'voleibol', label: 'Vóleibol', icon: '🏐', activityLabel: 'Partido', opponentLabel: 'Rival', scoreLabel: 'Sets', usesHeadToHeadScore: true,
    metrics: [
      metric('puntos', 'Puntos'), metric('aces', 'Aces'), metric('bloqueos', 'Bloqueos'),
      metric('ataques_positivos', 'Ataques +'), metric('recepciones_positivas', 'Recepciones +'), metric('sets_jugados', 'Sets jugados'),
    ],
  },
  tenis: {
    code: 'tenis', label: 'Tenis', icon: '🎾', activityLabel: 'Duelo', opponentLabel: 'Rival', scoreLabel: 'Sets', usesHeadToHeadScore: true,
    metrics: [
      metric('sets_ganados', 'Sets ganados'), metric('games_ganados', 'Games ganados'), metric('aces', 'Aces'),
      metric('dobles_faltas', 'Dobles faltas'), metric('quiebres', 'Quiebres'), metric('tie_breaks_ganados', 'Tie-breaks'),
    ],
  },
  padel: {
    code: 'padel', label: 'Pádel', icon: '🎾', activityLabel: 'Duelo', opponentLabel: 'Rival / pareja', scoreLabel: 'Sets', usesHeadToHeadScore: true,
    metrics: [
      metric('sets_ganados', 'Sets ganados'), metric('games_ganados', 'Games ganados'), metric('aces', 'Aces'),
      metric('quiebres', 'Quiebres'), metric('winners', 'Winners'), metric('errores_no_forzados', 'Errores no forzados'),
    ],
  },
  hockey: {
    code: 'hockey', label: 'Hockey', icon: '🏑', activityLabel: 'Partido', opponentLabel: 'Rival', scoreLabel: 'Goles', usesHeadToHeadScore: true,
    metrics: [
      metric('goles', 'Goles'), metric('asistencias', 'Asistencias'), metric('recuperaciones', 'Recuperaciones'),
      metric('intercepciones', 'Intercepciones'), metric('atajadas', 'Atajadas'), metric('tarjetas', 'Tarjetas'),
    ],
  },
  rugby: {
    code: 'rugby', label: 'Rugby', icon: '🏉', activityLabel: 'Partido', opponentLabel: 'Rival', scoreLabel: 'Puntos', usesHeadToHeadScore: true,
    metrics: [
      metric('tries', 'Tries'), metric('conversiones', 'Conversiones'), metric('tackles', 'Tackles'),
      metric('metros', 'Metros'), metric('recuperaciones', 'Recuperaciones'), metric('tarjetas', 'Tarjetas'),
    ],
  },
  natacion: {
    code: 'natacion', label: 'Natación', icon: '🏊', activityLabel: 'Prueba', opponentLabel: 'Prueba / serie', scoreLabel: 'Puntos', usesHeadToHeadScore: false,
    metrics: [
      metric('pruebas', 'Pruebas'), metric('podios', 'Podios'), metric('mejores_marcas', 'Mejores marcas'),
      metric('tiempo_segundos', 'Mejor tiempo', { aggregate: 'min', unit: 's', decimals: 2 }), metric('puntos', 'Puntos', { decimals: 2 }),
    ],
  },
  atletismo: {
    code: 'atletismo', label: 'Atletismo', icon: '🏃', activityLabel: 'Prueba', opponentLabel: 'Prueba / carrera', scoreLabel: 'Puntos', usesHeadToHeadScore: false,
    metrics: [
      metric('pruebas', 'Pruebas'), metric('podios', 'Podios'), metric('pb', 'PB'), metric('sb', 'SB'),
      metric('marca', 'Última marca', { aggregate: 'latest', decimals: 2 }), metric('puntos', 'Puntos', { decimals: 2 }),
    ],
  },
  gimnasia: {
    code: 'gimnasia', label: 'Gimnasia', icon: '🤸', activityLabel: 'Presentación', opponentLabel: 'Aparato / presentación', scoreLabel: 'Puntaje', usesHeadToHeadScore: false,
    metrics: [
      metric('aparatos', 'Aparatos'), metric('podios', 'Podios'), metric('medallas', 'Medallas'),
      metric('puntaje', 'Mejor puntaje', { aggregate: 'max', decimals: 3 }), metric('penalizaciones', 'Penalizaciones', { decimals: 3 }),
    ],
  },
  karate: {
    code: 'karate', label: 'Karate', icon: '🥋', activityLabel: 'Duelo / presentación', opponentLabel: 'Rival / modalidad', scoreLabel: 'Puntos', usesHeadToHeadScore: false,
    metrics: [
      metric('combates', 'Combates'), metric('victorias', 'Victorias'), metric('puntos', 'Puntos'),
      metric('ippon', 'Ippon'), metric('waza_ari', 'Waza-ari'), metric('medallas', 'Medallas'),
      metric('puntaje_kata', 'Mejor puntaje Kata', { aggregate: 'max', decimals: 2 }),
    ],
  },
  artes_marciales: {
    code: 'artes_marciales', label: 'Artes marciales', icon: '🥋', activityLabel: 'Duelo / prueba', opponentLabel: 'Rival / modalidad', scoreLabel: 'Puntos', usesHeadToHeadScore: false,
    metrics: [
      metric('combates', 'Combates'), metric('victorias', 'Victorias'), metric('puntos', 'Puntos'),
      metric('ippon', 'Ippon'), metric('knockdowns', 'Knockdowns'), metric('medallas', 'Medallas'),
    ],
  },
  generico: {
    code: 'generico', label: 'Deporte', icon: '🏅', activityLabel: 'Evento', opponentLabel: 'Rival / evento', scoreLabel: 'Puntos', usesHeadToHeadScore: true,
    metrics: [
      metric('participaciones', 'Participaciones'), metric('victorias', 'Victorias'), metric('podios', 'Podios'), metric('puntos', 'Puntos', { decimals: 2 }),
    ],
  },
});

const publicProfile = (profile) => ({
  code: profile.code,
  label: profile.label,
  icon: profile.icon,
  activityLabel: profile.activityLabel,
  opponentLabel: profile.opponentLabel,
  scoreLabel: profile.scoreLabel,
  usesHeadToHeadScore: profile.usesHeadToHeadScore,
  eventUi: eventUiForProfile(profile),
  metricVersion: COMPETITIVE_STATS_VERSION,
  metrics: profile.metrics.map(({ legacyField, ...definition }) => definition),
});

const resolveCompetitiveProfile = ({ discipline, code } = {}) => {
  const resolvedCode = code && PROFILES[code] ? code : resolveDisciplineCode(discipline);
  return PROFILES[resolvedCode] || PROFILES.generico;
};

const sanitizeCompetitiveMetrics = (input, profileOrOptions = {}) => {
  const profile = profileOrOptions?.metrics ? profileOrOptions : resolveCompetitiveProfile(profileOrOptions);
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const output = {};
  for (const definition of profile.metrics) {
    const raw = source[definition.code];
    if (raw === '' || raw === null || raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) continue;
    const factor = 10 ** definition.decimals;
    output[definition.code] = Math.round(Math.min(value, 1_000_000_000) * factor) / factor;
  }
  return output;
};

const metricsFromRow = (row = {}, profileOrOptions = {}) => {
  const profile = profileOrOptions?.metrics ? profileOrOptions : resolveCompetitiveProfile(profileOrOptions);
  const merged = { ...(row.metricas_competitivas || {}) };
  for (const definition of profile.metrics) {
    if (merged[definition.code] === undefined && definition.legacyField && row[definition.legacyField] !== undefined) {
      merged[definition.code] = row[definition.legacyField];
    }
  }
  return sanitizeCompetitiveMetrics(merged, profile);
};

const compatibleRows = (rows = [], profile) => (Array.isArray(rows) ? rows : []).filter((row) => {
  const rowCode = String(row?.disciplina_codigo || '').trim();
  if (rowCode) return rowCode === profile.code;
  return ['futbol', 'futsal'].includes(profile.code);
});

const aggregateCompetitiveStats = (profileOrOptions = {}, rows = []) => {
  const profile = profileOrOptions?.metrics ? profileOrOptions : resolveCompetitiveProfile(profileOrOptions);
  const relevant = compatibleRows(rows, profile);
  const metricValues = Object.fromEntries(profile.metrics.map((definition) => [definition.code, []]));

  for (const row of relevant) {
    const values = metricsFromRow(row, profile);
    for (const definition of profile.metrics) {
      const value = Number(values[definition.code]);
      if (Number.isFinite(value)) metricValues[definition.code].push(value);
    }
  }

  const metrics = profile.metrics.map((definition) => {
    const values = metricValues[definition.code];
    let value = 0;
    if (values.length) {
      if (definition.aggregate === 'min') value = Math.min(...values);
      else if (definition.aggregate === 'max') value = Math.max(...values);
      else if (definition.aggregate === 'latest') value = values[0];
      else value = values.reduce((sum, current) => sum + current, 0);
    }
    const factor = 10 ** definition.decimals;
    return {
      code: definition.code,
      label: definition.label,
      value: Math.round(value * factor) / factor,
      unit: definition.unit,
      decimals: definition.decimals,
    };
  });

  return {
    ...publicProfile(profile),
    participations: relevant.length,
    mvp: relevant.filter((row) => row?.es_mvp === true).length,
    metrics,
  };
};

const legacyStatColumns = (profile, metrics = {}) => {
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

const formatCompetitiveMetric = (definition, value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const formatted = number.toLocaleString('es-CL', {
    minimumFractionDigits: definition.decimals,
    maximumFractionDigits: definition.decimals,
  });
  return `${definition.label}: ${formatted}${definition.unit ? ` ${definition.unit}` : ''}`;
};

module.exports = {
  COMPETITIVE_STATS_VERSION,
  PROFILES,
  publicProfile,
  resolveCompetitiveProfile,
  sanitizeCompetitiveMetrics,
  metricsFromRow,
  aggregateCompetitiveStats,
  legacyStatColumns,
  formatCompetitiveMetric,
};