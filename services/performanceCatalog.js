const { resolveCompetitiveProfile, publicProfile } = require('./competitiveStatsCatalog');

const PERFORMANCE_VERSION = 1;

const metric = (code, label, options = {}) => Object.freeze({
  code,
  label,
  tier: options.tier || 'basic',
  aggregate: options.aggregate || 'sum',
  unit: options.unit || null,
  decimals: Number.isInteger(options.decimals) ? options.decimals : 0,
  maxValue: Number.isFinite(options.maxValue) ? options.maxValue : null,
  record: options.record || null,
});

const teamMetric = (code, label, options = {}) => metric(code, label, options);

const INDIVIDUAL = Object.freeze({
  futbol: [
    metric('goles', 'Goles'), metric('asistencias', 'Asistencias'), metric('tiros_arco', 'Tiros al arco'),
    metric('recuperaciones', 'Recuperaciones'), metric('tarjetas_amarillas', 'Amarillas'), metric('tarjetas_rojas', 'Rojas'),
    metric('tiros', 'Tiros', { tier: 'advanced' }), metric('pases_intentados', 'Pases intentados', { tier: 'advanced' }),
    metric('pases_correctos', 'Pases correctos', { tier: 'advanced' }), metric('duelos_ganados', 'Duelos ganados', { tier: 'advanced' }),
    metric('perdidas', 'Pérdidas', { tier: 'advanced' }), metric('faltas', 'Faltas', { tier: 'advanced' }),
    metric('atajadas', 'Atajadas', { tier: 'advanced' }), metric('goles_recibidos', 'Goles recibidos', { tier: 'advanced' }),
  ],
  futsal: [
    metric('goles', 'Goles'), metric('asistencias', 'Asistencias'), metric('tiros_arco', 'Tiros al arco'),
    metric('recuperaciones', 'Recuperaciones'), metric('tarjetas_amarillas', 'Amarillas'), metric('tarjetas_rojas', 'Rojas'),
    metric('tiros', 'Tiros', { tier: 'advanced' }), metric('pases_correctos', 'Pases correctos', { tier: 'advanced' }),
    metric('duelos_ganados', 'Duelos ganados', { tier: 'advanced' }), metric('perdidas', 'Pérdidas', { tier: 'advanced' }),
    metric('atajadas', 'Atajadas', { tier: 'advanced' }), metric('goles_recibidos', 'Goles recibidos', { tier: 'advanced' }),
  ],
  basquetbol: [
    metric('puntos', 'Puntos'), metric('rebotes', 'Rebotes'), metric('asistencias', 'Asistencias'), metric('robos', 'Robos'),
    metric('tapones', 'Tapones'), metric('triples', 'Triples'), metric('rebotes_ofensivos', 'Rebotes ofensivos', { tier: 'advanced' }),
    metric('rebotes_defensivos', 'Rebotes defensivos', { tier: 'advanced' }), metric('tiros_2_anotados', 'Dobles anotados', { tier: 'advanced' }),
    metric('tiros_2_intentados', 'Dobles intentados', { tier: 'advanced' }), metric('triples_intentados', 'Triples intentados', { tier: 'advanced' }),
    metric('libres_anotados', 'Libres anotados', { tier: 'advanced' }), metric('libres_intentados', 'Libres intentados', { tier: 'advanced' }),
    metric('perdidas', 'Pérdidas', { tier: 'advanced' }), metric('faltas', 'Faltas', { tier: 'advanced' }),
  ],
  voleibol: [
    metric('puntos', 'Puntos'), metric('aces', 'Aces'), metric('bloqueos', 'Bloqueos'), metric('ataques_positivos', 'Ataques +'),
    metric('recepciones_positivas', 'Recepciones +'), metric('sets_jugados', 'Sets jugados'),
    metric('saques', 'Saques', { tier: 'advanced' }), metric('errores_saque', 'Errores de saque', { tier: 'advanced' }),
    metric('ataques', 'Ataques', { tier: 'advanced' }), metric('recepciones', 'Recepciones', { tier: 'advanced' }),
    metric('errores', 'Errores', { tier: 'advanced' }),
  ],
  tenis: [
    metric('sets_ganados', 'Sets ganados'), metric('games_ganados', 'Games ganados'), metric('aces', 'Aces'),
    metric('dobles_faltas', 'Dobles faltas'), metric('quiebres', 'Quiebres'), metric('tie_breaks_ganados', 'Tie-breaks'),
    metric('winners', 'Winners', { tier: 'advanced' }), metric('errores_no_forzados', 'Errores no forzados', { tier: 'advanced' }),
    metric('primeros_servicios', 'Primeros servicios', { tier: 'advanced' }), metric('primeros_servicios_dentro', '1° servicios dentro', { tier: 'advanced' }),
    metric('break_points', 'Break points', { tier: 'advanced' }), metric('break_points_salvados', 'Break points salvados', { tier: 'advanced' }),
  ],
  padel: [
    metric('sets_ganados', 'Sets ganados'), metric('games_ganados', 'Games ganados'), metric('aces', 'Aces'),
    metric('quiebres', 'Quiebres'), metric('winners', 'Winners'), metric('errores_no_forzados', 'Errores no forzados'),
    metric('smashes', 'Smashes', { tier: 'advanced' }), metric('bandejas', 'Bandejas', { tier: 'advanced' }),
    metric('viboras', 'Víboras', { tier: 'advanced' }), metric('break_points', 'Break points', { tier: 'advanced' }),
  ],
  hockey: [
    metric('goles', 'Goles'), metric('asistencias', 'Asistencias'), metric('recuperaciones', 'Recuperaciones'),
    metric('intercepciones', 'Intercepciones'), metric('atajadas', 'Atajadas'), metric('tarjetas', 'Tarjetas'),
    metric('tiros', 'Tiros', { tier: 'advanced' }), metric('tiros_arco', 'Tiros al arco', { tier: 'advanced' }),
    metric('perdidas', 'Pérdidas', { tier: 'advanced' }),
  ],
  rugby: [
    metric('tries', 'Tries'), metric('conversiones', 'Conversiones'), metric('tackles', 'Tackles'), metric('metros', 'Metros'),
    metric('recuperaciones', 'Recuperaciones'), metric('tarjetas', 'Tarjetas'), metric('tackles_efectivos', 'Tackles efectivos', { tier: 'advanced' }),
    metric('carries', 'Carries', { tier: 'advanced' }), metric('turnovers', 'Turnovers', { tier: 'advanced' }),
    metric('penales', 'Penales', { tier: 'advanced' }),
  ],
  natacion: [
    metric('tiempo_segundos', 'Tiempo', { aggregate: 'min', unit: 's', decimals: 2, record: { compare: 'min', unit: 's' } }),
    metric('posicion', 'Posición'), metric('puntos', 'Puntos', { decimals: 2 }), metric('serie', 'Serie', { tier: 'advanced' }),
    metric('carril', 'Carril', { tier: 'advanced' }), metric('reaccion_segundos', 'Reacción', { tier: 'advanced', unit: 's', decimals: 2 }),
  ],
  atletismo: [
    metric('marca', 'Marca', { aggregate: 'latest', decimals: 3, record: { compare: 'auto' } }),
    metric('posicion', 'Posición'), metric('puntos', 'Puntos', { decimals: 2 }), metric('serie', 'Serie', { tier: 'advanced' }),
    metric('viento', 'Viento', { tier: 'advanced', unit: 'm/s', decimals: 2 }), metric('intento_1', 'Intento 1', { tier: 'advanced', decimals: 3 }),
    metric('intento_2', 'Intento 2', { tier: 'advanced', decimals: 3 }), metric('intento_3', 'Intento 3', { tier: 'advanced', decimals: 3 }),
    metric('intento_4', 'Intento 4', { tier: 'advanced', decimals: 3 }), metric('intento_5', 'Intento 5', { tier: 'advanced', decimals: 3 }),
    metric('intento_6', 'Intento 6', { tier: 'advanced', decimals: 3 }),
  ],
  gimnasia: [
    metric('puntaje', 'Nota final', { aggregate: 'max', decimals: 3, record: { compare: 'max', unit: 'pts' } }),
    metric('posicion', 'Posición'), metric('dificultad', 'Dificultad', { tier: 'advanced', decimals: 3 }),
    metric('ejecucion', 'Ejecución', { tier: 'advanced', decimals: 3 }), metric('penalizaciones', 'Penalizaciones', { tier: 'advanced', decimals: 3 }),
  ],
  karate: [
    metric('puntos', 'Puntos'), metric('ippon', 'Ippon'), metric('waza_ari', 'Waza-ari'), metric('medallas', 'Medallas'),
    metric('puntaje_kata', 'Puntaje Kata', { aggregate: 'max', decimals: 2, record: { compare: 'max', unit: 'pts' } }),
    metric('penalizaciones', 'Penalizaciones', { tier: 'advanced' }), metric('posicion', 'Posición', { tier: 'advanced' }),
  ],
  artes_marciales: [
    metric('puntos', 'Puntos'), metric('victorias', 'Victorias'), metric('ippon', 'Ippon'), metric('knockdowns', 'Knockdowns'),
    metric('derribos', 'Derribos', { tier: 'advanced' }), metric('sumisiones', 'Sumisiones', { tier: 'advanced' }),
    metric('penalizaciones', 'Penalizaciones', { tier: 'advanced' }), metric('posicion', 'Posición', { tier: 'advanced' }),
  ],
  generico: [
    metric('puntos', 'Puntos', { decimals: 2 }), metric('victorias', 'Victorias'), metric('podios', 'Podios'),
    metric('posicion', 'Posición'), metric('valoracion', 'Valoración', { tier: 'advanced', decimals: 2 }),
  ],
});

const TEAM = Object.freeze({
  futbol: [
    teamMetric('posesion', 'Posesión', { unit: '%', decimals: 1, maxValue: 100 }), teamMetric('tiros', 'Tiros'),
    teamMetric('tiros_arco', 'Tiros al arco'), teamMetric('corners', 'Corners'), teamMetric('faltas', 'Faltas'),
    teamMetric('offsides', 'Offsides', { tier: 'advanced' }), teamMetric('pases_intentados', 'Pases intentados', { tier: 'advanced' }),
    teamMetric('pases_correctos', 'Pases correctos', { tier: 'advanced' }), teamMetric('recuperaciones', 'Recuperaciones', { tier: 'advanced' }),
    teamMetric('perdidas', 'Pérdidas', { tier: 'advanced' }),
  ],
  futsal: [
    teamMetric('posesion', 'Posesión', { unit: '%', decimals: 1, maxValue: 100 }), teamMetric('tiros', 'Tiros'),
    teamMetric('tiros_arco', 'Tiros al arco'), teamMetric('faltas', 'Faltas'), teamMetric('corners', 'Corners'),
    teamMetric('recuperaciones', 'Recuperaciones', { tier: 'advanced' }), teamMetric('perdidas', 'Pérdidas', { tier: 'advanced' }),
  ],
  basquetbol: [
    teamMetric('puntos_q1', 'Puntos Q1'), teamMetric('puntos_q2', 'Puntos Q2'), teamMetric('puntos_q3', 'Puntos Q3'), teamMetric('puntos_q4', 'Puntos Q4'),
    teamMetric('rebotes', 'Rebotes'), teamMetric('asistencias', 'Asistencias'), teamMetric('perdidas', 'Pérdidas'), teamMetric('robos', 'Robos'),
    teamMetric('tapones', 'Tapones', { tier: 'advanced' }), teamMetric('porcentaje_campo', '% tiros de campo', { tier: 'advanced', unit: '%', decimals: 1, maxValue: 100 }),
    teamMetric('porcentaje_triples', '% triples', { tier: 'advanced', unit: '%', decimals: 1, maxValue: 100 }),
    teamMetric('porcentaje_libres', '% libres', { tier: 'advanced', unit: '%', decimals: 1, maxValue: 100 }),
  ],
  voleibol: [
    teamMetric('aces', 'Aces'), teamMetric('bloqueos', 'Bloqueos'), teamMetric('ataques_positivos', 'Ataques +'),
    teamMetric('recepciones_positivas', 'Recepciones +'), teamMetric('errores', 'Errores'),
    teamMetric('saques', 'Saques', { tier: 'advanced' }), teamMetric('errores_saque', 'Errores saque', { tier: 'advanced' }),
    teamMetric('ataques', 'Ataques', { tier: 'advanced' }), teamMetric('recepciones', 'Recepciones', { tier: 'advanced' }),
  ],
  hockey: [
    teamMetric('tiros', 'Tiros'), teamMetric('tiros_arco', 'Tiros al arco'), teamMetric('corners_cortos', 'Corners cortos'),
    teamMetric('recuperaciones', 'Recuperaciones'), teamMetric('perdidas', 'Pérdidas'), teamMetric('tarjetas', 'Tarjetas'),
  ],
  rugby: [
    teamMetric('tries', 'Tries'), teamMetric('conversiones', 'Conversiones'), teamMetric('tackles', 'Tackles'),
    teamMetric('metros', 'Metros'), teamMetric('turnovers', 'Turnovers'), teamMetric('penales', 'Penales'),
    teamMetric('posesion', 'Posesión', { tier: 'advanced', unit: '%', decimals: 1, maxValue: 100 }),
  ],
});

const dedupeMetrics = (items = []) => {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    if (!item?.code || seen.has(item.code)) continue;
    seen.add(item.code);
    result.push(item);
  }
  return result;
};

const resolvePerformanceProfile = ({ discipline, code } = {}) => {
  const base = resolveCompetitiveProfile({ discipline, code });
  return {
    ...base,
    metrics: dedupeMetrics(INDIVIDUAL[base.code] || INDIVIDUAL.generico),
    teamMetrics: dedupeMetrics(TEAM[base.code] || []),
  };
};

const publicPerformanceProfile = (profileOrOptions = {}) => {
  const profile = profileOrOptions?.teamMetrics ? profileOrOptions : resolvePerformanceProfile(profileOrOptions);
  const basePublic = publicProfile(profile);
  return {
    ...basePublic,
    metricVersion: PERFORMANCE_VERSION,
    metrics: profile.metrics,
    teamMetrics: profile.teamMetrics,
    supportsTeamMetrics: profile.teamMetrics.length > 0,
    supportsPersonalRecords: profile.metrics.some((item) => Boolean(item.record)),
  };
};

const sanitizeMetricMap = (input, definitions = []) => {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const output = {};
  for (const definition of definitions) {
    const raw = source[definition.code];
    if (raw === '' || raw === null || raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) continue;
    const bounded = definition.maxValue === null ? Math.min(value, 1_000_000_000) : Math.min(value, definition.maxValue);
    const factor = 10 ** definition.decimals;
    output[definition.code] = Math.round(bounded * factor) / factor;
  }
  return output;
};

const slugifyEvent = (value) => String(value || 'evento')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'evento';

const resolveRecordRule = (profileOrOptions = {}, eventName = '', metricDefinition = null) => {
  const profile = profileOrOptions?.teamMetrics ? profileOrOptions : resolvePerformanceProfile(profileOrOptions);
  const definition = metricDefinition || profile.metrics.find((item) => item.record);
  if (!definition?.record) return null;
  let compare = definition.record.compare;
  let unit = definition.record.unit || definition.unit || null;
  if (compare === 'auto' && profile.code === 'atletismo') {
    const normalized = slugifyEvent(eventName);
    const fieldEvent = /(salto|lanzamiento|peso|disco|jabalina|martillo|altura|longitud|garrocha|triple)/.test(normalized);
    compare = fieldEvent ? 'max' : 'min';
    if (!unit) unit = fieldEvent ? 'm' : 's';
  }
  if (!['min', 'max'].includes(compare)) return null;
  return { compare, unit, metricCode: definition.code, metricLabel: definition.label };
};

const formatMetric = (definition, value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const text = number.toLocaleString('es-CL', {
    minimumFractionDigits: definition.decimals || 0,
    maximumFractionDigits: definition.decimals || 0,
  });
  return `${definition.label}: ${text}${definition.unit ? ` ${definition.unit}` : ''}`;
};

module.exports = {
  PERFORMANCE_VERSION,
  resolvePerformanceProfile,
  publicPerformanceProfile,
  sanitizeMetricMap,
  slugifyEvent,
  resolveRecordRule,
  formatMetric,
};