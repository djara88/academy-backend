const PLAN_CODES = Object.freeze({
  FORMACION: 'formacion',
  COMPETENCIA: 'competencia',
  ALTO_RENDIMIENTO: 'alto_rendimiento',
});

const FEATURES = Object.freeze({
  CORE: 'core',
  FINANCE: 'finanzas',
  UNIFORMS: 'uniformes',
  PROFESSORS: 'profesores',
  MATCHES: 'partidos',
  TOURNAMENTS: 'torneos',
  MATCH_PREPARATION: 'preparacion_partidos',
  ATTENDANCE_ALERTS: 'alertas_asistencia',
  EVALUATIONS: 'evaluaciones',
  MEDICAL: 'ficha_medica',
  ADVANCED_ANALYTICS: 'analitica_avanzada',
  CUSTOM_BRANDING: 'marca_personalizada',
  EXPORTS: 'exportaciones',
  GUARDIANS: 'apoderados',
});

const BASE_FEATURES = [
  FEATURES.CORE,
  FEATURES.FINANCE,
  FEATURES.UNIFORMS,
  FEATURES.PROFESSORS,
  FEATURES.MATCHES,
];

const PLAN_DEFINITIONS = Object.freeze({
  [PLAN_CODES.FORMACION]: {
    code: PLAN_CODES.FORMACION,
    name: 'Formación',
    audience: 'Academias que necesitan ordenar su operación diaria y crecer con control.',
    professorLimit: 3,
    playerLimit: 100,
    priceClp: 30000,
    features: BASE_FEATURES,
  },
  [PLAN_CODES.COMPETENCIA]: {
    code: PLAN_CODES.COMPETENCIA,
    name: 'Competencia',
    audience: 'Academias con varias categorías, torneos y trabajo técnico coordinado.',
    professorLimit: 10,
    playerLimit: 300,
    priceClp: 60000,
    features: [
      ...BASE_FEATURES,
      FEATURES.TOURNAMENTS,
      FEATURES.MATCH_PREPARATION,
      FEATURES.ATTENDANCE_ALERTS,
      FEATURES.EVALUATIONS,
      FEATURES.EXPORTS,
    ],
  },
  [PLAN_CODES.ALTO_RENDIMIENTO]: {
    code: PLAN_CODES.ALTO_RENDIMIENTO,
    name: 'Alto Rendimiento',
    audience: 'Organizaciones que requieren trazabilidad, rendimiento y operación avanzada.',
    professorLimit: 30,
    playerLimit: null,
    priceClp: 100000,
    features: [
      ...BASE_FEATURES,
      FEATURES.TOURNAMENTS,
      FEATURES.MATCH_PREPARATION,
      FEATURES.ATTENDANCE_ALERTS,
      FEATURES.EVALUATIONS,
      FEATURES.MEDICAL,
      FEATURES.ADVANCED_ANALYTICS,
      FEATURES.CUSTOM_BRANDING,
      FEATURES.EXPORTS,
    ],
  },
});

const normalizePlanText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const isTrialPlan = (academy = {}) => {
  const plan = normalizePlanText(academy.plan);
  return plan.includes('prueba') || plan.includes('trial');
};

const resolvePlanCode = (academy = {}) => {
  if (PLAN_DEFINITIONS[academy.plan_codigo]) return academy.plan_codigo;
  const legacy = normalizePlanText(academy.plan);
  if (legacy.includes('alto rendimiento') || legacy.includes('elite')) return PLAN_CODES.ALTO_RENDIMIENTO;
  if (legacy.includes('competencia') || legacy.includes('pro')) return PLAN_CODES.COMPETENCIA;
  return PLAN_CODES.FORMACION;
};

const getPlanDefinition = (academy = {}) => PLAN_DEFINITIONS[resolvePlanCode(academy)];

const getAcademyEntitlements = (academy = {}) => {
  const plan = getPlanDefinition(academy);
  // La prueba de 15 días expone el producto completo para demostrar su valor.
  const trial = isTrialPlan(academy);
  const baseFeatures = trial
    ? PLAN_DEFINITIONS[PLAN_CODES.ALTO_RENDIMIENTO].features
    : plan.features;
  const features = new Set(baseFeatures);
  if (trial || academy.licencia_apoderados === true) features.add(FEATURES.GUARDIANS);

  const manualProfessorLimit = Number(academy.max_profesores);
  return {
    plan: { code: plan.code, name: plan.name, audience: plan.audience, trial },
    limits: {
      professors: trial
        ? PLAN_DEFINITIONS[PLAN_CODES.ALTO_RENDIMIENTO].professorLimit
        : Number.isInteger(manualProfessorLimit) && manualProfessorLimit > 0
          ? manualProfessorLimit
          : plan.professorLimit,
      players: trial ? null : plan.playerLimit,
    },
    addOns: { guardians: trial || academy.licencia_apoderados === true, guardiansIncludedByTrial: trial },
    pricing: { planClp: plan.priceClp, guardiansClp: 15000 },
    features: [...features],
  };
};

const hasFeature = (academy, feature) => getAcademyEntitlements(academy).features.includes(feature);
const getPlanProfessorLimit = (planCode) => PLAN_DEFINITIONS[planCode]?.professorLimit || PLAN_DEFINITIONS.formacion.professorLimit;

module.exports = {
  PLAN_CODES,
  PLAN_DEFINITIONS,
  FEATURES,
  normalizePlanText,
  resolvePlanCode,
  getPlanDefinition,
  getAcademyEntitlements,
  hasFeature,
  getPlanProfessorLimit,
  isTrialPlan,
};
