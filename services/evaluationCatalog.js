const normalizeText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const METRIC_VERSION = 2;
const MIN_CUSTOM_METRICS = 3;
const MAX_CUSTOM_METRICS = 10;

const PROFILES = Object.freeze({
  futbol: {
    code: 'futbol', label: 'Fútbol', roleLabel: 'Posición',
    roles: ['Arquero', 'Defensa', 'Mediocampista', 'Delantero'],
    metrics: ['Control de balón', 'Pase', 'Remate', '1 vs 1', 'Toma de decisiones', 'Condición física'],
    roleProfiles: {
      Arquero: ['Reflejos', 'Blocaje', 'Juego aéreo', 'Distribución', 'Juego con los pies', 'Toma de decisiones'],
    },
  },
  futsal: {
    code: 'futsal', label: 'Futsal', roleLabel: 'Posición',
    roles: ['Arquero', 'Cierre', 'Ala', 'Pívot'],
    metrics: ['Control orientado', 'Pase rápido', 'Finalización', '1 vs 1', 'Toma de decisiones', 'Intensidad'],
    roleProfiles: {
      Arquero: ['Reflejos', 'Blocaje', '1 vs 1', 'Distribución', 'Juego con los pies', 'Toma de decisiones'],
    },
  },
  basquetbol: {
    code: 'basquetbol', label: 'Básquetbol', roleLabel: 'Posición / rol',
    roles: ['Base', 'Escolta', 'Alero', 'Ala-pívot', 'Pívot'],
    metrics: ['Manejo de balón', 'Pase', 'Tiro', 'Defensa', 'Rebote', 'Toma de decisiones'],
  },
  voleibol: {
    code: 'voleibol', label: 'Vóleibol', roleLabel: 'Posición / rol',
    roles: ['Armador', 'Opuesto', 'Central', 'Punta', 'Líbero'],
    metrics: ['Saque', 'Recepción', 'Colocación', 'Ataque', 'Bloqueo', 'Desplazamiento'],
  },
  tenis: {
    code: 'tenis', label: 'Tenis', roleLabel: 'Perfil de juego', roles: [],
    metrics: ['Saque', 'Derecha', 'Revés', 'Volea', 'Movilidad', 'Toma de decisiones'],
  },
  padel: {
    code: 'padel', label: 'Pádel', roleLabel: 'Lado / rol', roles: ['Drive', 'Revés'],
    metrics: ['Saque', 'Derecha', 'Revés', 'Volea', 'Bandeja / smash', 'Posicionamiento'],
  },
  hockey: {
    code: 'hockey', label: 'Hockey', roleLabel: 'Posición / rol', roles: [],
    metrics: ['Control', 'Pase', 'Remate', 'Marcaje', 'Posicionamiento', 'Condición física'],
  },
  atletismo: {
    code: 'atletismo', label: 'Atletismo', roleLabel: 'Prueba / especialidad', roles: [],
    metrics: ['Técnica', 'Velocidad', 'Resistencia', 'Potencia', 'Movilidad', 'Consistencia'],
  },
  natacion: {
    code: 'natacion', label: 'Natación', roleLabel: 'Estilo / especialidad', roles: [],
    metrics: ['Técnica', 'Resistencia', 'Velocidad', 'Salida', 'Virajes', 'Respiración'],
  },
  gimnasia: {
    code: 'gimnasia', label: 'Gimnasia', roleLabel: 'Aparato / especialidad', roles: [],
    metrics: ['Técnica', 'Flexibilidad', 'Fuerza', 'Coordinación', 'Equilibrio', 'Ejecución'],
  },
  karate: {
    code: 'karate', label: 'Karate', roleLabel: 'Modalidad / especialidad',
    roles: ['Kata', 'Kumite', 'Formativo / Kihon'],
    metrics: ['Kihon / técnica base', 'Kata', 'Kumite', 'Velocidad', 'Control', 'Condición física'],
    roleProfiles: {
      Kata: ['Técnica', 'Precisión', 'Equilibrio', 'Ritmo', 'Potencia', 'Concentración'],
      Kumite: ['Técnica', 'Distancia / Maai', 'Timing', 'Velocidad', 'Defensa', 'Control'],
      'Formativo / Kihon': ['Posturas', 'Técnica', 'Coordinación', 'Velocidad', 'Control', 'Disciplina'],
    },
  },
  artes_marciales: {
    code: 'artes_marciales', label: 'Artes marciales', roleLabel: 'Disciplina / especialidad', roles: [],
    metrics: ['Técnica', 'Velocidad', 'Potencia', 'Defensa', 'Control', 'Condición física'],
  },
  rugby: {
    code: 'rugby', label: 'Rugby', roleLabel: 'Posición / rol', roles: [],
    metrics: ['Manejo de balón', 'Pase', 'Tackle', 'Posicionamiento', 'Velocidad', 'Resistencia'],
  },
  generico: {
    code: 'generico', label: 'Deporte', roleLabel: 'Rol / especialidad', roles: [],
    metrics: ['Técnica', 'Condición física', 'Coordinación', 'Toma de decisiones', 'Consistencia', 'Actitud'],
  },
});

const aliases = new Map([
  ['futbol', 'futbol'], ['football', 'futbol'],
  ['futsal', 'futsal'],
  ['basquetbol', 'basquetbol'], ['basketbol', 'basquetbol'], ['basketball', 'basquetbol'], ['basquet', 'basquetbol'],
  ['voleibol', 'voleibol'], ['volley', 'voleibol'], ['volleyball', 'voleibol'],
  ['tenis', 'tenis'], ['tennis', 'tenis'],
  ['padel', 'padel'],
  ['hockey', 'hockey'],
  ['atletismo', 'atletismo'],
  ['natacion', 'natacion'],
  ['gimnasia', 'gimnasia'],
  ['karate', 'karate'], ['karate do', 'karate'], ['karate-do', 'karate'],
  ['artes marciales', 'artes_marciales'], ['arte marcial', 'artes_marciales'], ['artes_marciales', 'artes_marciales'],
  ['taekwondo', 'artes_marciales'], ['judo', 'artes_marciales'], ['jiu jitsu', 'artes_marciales'], ['jiu-jitsu', 'artes_marciales'],
  ['bjj', 'artes_marciales'], ['kickboxing', 'artes_marciales'], ['muay thai', 'artes_marciales'],
  ['kung fu', 'artes_marciales'], ['wushu', 'artes_marciales'], ['aikido', 'artes_marciales'],
  ['rugby', 'rugby'],
  ['generico', 'generico'],
]);

const resolveDisciplineCode = (discipline) => aliases.get(normalizeText(discipline)) || 'generico';

const validCustomMetrics = (config) => {
  if (!Array.isArray(config?.metrics)) return [];
  const seen = new Set();
  const metrics = [];
  for (const item of config.metrics) {
    const metric = String(item || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!metric) continue;
    const key = normalizeText(metric);
    if (seen.has(key)) continue;
    seen.add(key);
    metrics.push(metric);
    if (metrics.length >= MAX_CUSTOM_METRICS) break;
  }
  return metrics;
};

const sanitizeCustomEvaluationConfig = (input, previousVersion = 0) => {
  const metrics = validCustomMetrics(input);
  if (metrics.length < MIN_CUSTOM_METRICS) {
    const error = new Error(`Define entre ${MIN_CUSTOM_METRICS} y ${MAX_CUSTOM_METRICS} criterios de evaluación distintos.`);
    error.status = 400;
    error.code = 'INVALID_CUSTOM_EVALUATION_METRICS';
    throw error;
  }
  return {
    metrics,
    version: Math.min(32767, Math.max(1, Number(previousVersion || 0) + 1)),
  };
};

const resolveEvaluationProfile = ({ discipline, role, customConfig, scopeId } = {}) => {
  const code = resolveDisciplineCode(discipline);
  const base = PROFILES[code] || PROFILES.generico;
  const customMetrics = validCustomMetrics(customConfig);
  const usingCustomMetrics = customMetrics.length >= MIN_CUSTOM_METRICS;
  const normalizedRole = String(role || '').trim();
  const roleMetrics = base.roleProfiles?.[normalizedRole];
  const metrics = usingCustomMetrics ? customMetrics : (roleMetrics || base.metrics);
  const standardProfileCode = roleMetrics ? `${code}:${normalizeText(normalizedRole).replace(/\s+/g, '_')}` : code;
  const customVersion = Math.min(32767, Math.max(1, Math.round(Number(customConfig?.version || 1))));

  return {
    code,
    label: customConfig?.label ? String(customConfig.label).trim().slice(0, 80) : base.label,
    roleLabel: customConfig?.roleLabel ? String(customConfig.roleLabel).trim().slice(0, 80) : base.roleLabel,
    roles: Array.isArray(customConfig?.roles) && customConfig.roles.length
      ? customConfig.roles.map((item) => String(item || '').trim().slice(0, 80)).filter(Boolean).slice(0, 20)
      : base.roles,
    metrics,
    profileCode: usingCustomMetrics ? `${code}:custom:${String(scopeId || 'default').slice(0, 80)}` : standardProfileCode,
    metricVersion: usingCustomMetrics ? customVersion : METRIC_VERSION,
    standardMetricVersion: METRIC_VERSION,
    custom: usingCustomMetrics,
    supportsFootballStats: ['futbol', 'futsal'].includes(code),
  };
};

const sanitizeRadarMetrics = (input, allowedMetrics) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const allowed = new Set((allowedMetrics || []).map(String));
  const output = {};
  for (const [key, raw] of Object.entries(input)) {
    if (allowed.size && !allowed.has(key)) continue;
    const value = Math.round(Number(raw));
    if (!Number.isFinite(value)) continue;
    output[String(key).slice(0, 80)] = Math.max(0, Math.min(100, value));
  }
  return output;
};

const evaluationCompatibilityKey = (evaluation = {}) => {
  const profile = String(evaluation.perfil_evaluacion || '').trim();
  if (profile) return `profile:${profile}:v${Number(evaluation.metricas_version || 1)}`;
  const metrics = Object.keys(evaluation.datos_radar || {}).sort((a, b) => a.localeCompare(b, 'es')).join('|');
  return `legacy:${metrics}`;
};

const selectComparableEvaluations = (evaluations = []) => {
  const ordered = Array.isArray(evaluations) ? evaluations.filter(Boolean) : [];
  if (!ordered.length) return [];
  const latest = ordered[0];
  const key = evaluationCompatibilityKey(latest);
  const previous = ordered.slice(1).find((evaluation) => evaluationCompatibilityKey(evaluation) === key);
  return previous ? [latest, previous] : [latest];
};

module.exports = {
  METRIC_VERSION,
  MIN_CUSTOM_METRICS,
  MAX_CUSTOM_METRICS,
  PROFILES,
  resolveDisciplineCode,
  resolveEvaluationProfile,
  sanitizeCustomEvaluationConfig,
  sanitizeRadarMetrics,
  evaluationCompatibilityKey,
  selectComparableEvaluations,
};