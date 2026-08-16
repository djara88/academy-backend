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
  CUSTOM_EVALUATION_CRITERIA: 'criterios_evaluacion_personalizados',
  MEDICAL: 'ficha_medica',
  ADVANCED_ANALYTICS: 'analitica_avanzada',
  CUSTOM_BRANDING: 'marca_personalizada',
  EXPORTS: 'exportaciones',
  GUARDIANS: 'apoderados',
  WHATSAPP_GROUPS: 'whatsapp_grupos',
  ADVANCED_COMMUNICATIONS: 'comunicaciones_avanzadas',
});

// Formación debe sentirse como un producto completo. Incluye evaluación y radar
// multideporte con criterios estándar de Syncademia. La personalización de esos
// criterios diferencia Competencia y Alto Rendimiento.
const BASE_FEATURES = [
  FEATURES.CORE,
  FEATURES.FINANCE,
  FEATURES.UNIFORMS,
  FEATURES.PROFESSORS,
  FEATURES.MATCHES,
  FEATURES.TOURNAMENTS,
  FEATURES.GUARDIANS,
  FEATURES.EVALUATIONS,
];

const COMPETITION_FEATURES = [
  ...BASE_FEATURES,
  FEATURES.MATCH_PREPARATION,
  FEATURES.ATTENDANCE_ALERTS,
  FEATURES.CUSTOM_EVALUATION_CRITERIA,
  FEATURES.EXPORTS,
  FEATURES.WHATSAPP_GROUPS,
];

const PLAN_DEFINITIONS = Object.freeze({
  [PLAN_CODES.FORMACION]: {
    code: PLAN_CODES.FORMACION,
    name: 'Formación',
    audience: 'Todo lo necesario para administrar profesionalmente una academia.',
    professorLimit: 3,
    playerLimit: 100,
    siteLimit: 1,
    branchLimit: 1,
    priceClp: 59000,
    features: BASE_FEATURES,
  },
  [PLAN_CODES.COMPETENCIA]: {
    code: PLAN_CODES.COMPETENCIA,
    name: 'Competencia',
    audience: 'Academias que quieren automatizar su operación y conectar a toda su comunidad.',
    professorLimit: 10,
    playerLimit: 300,
    siteLimit: 2,
    branchLimit: 2,
    priceClp: 99000,
    features: COMPETITION_FEATURES,
  },
  [PLAN_CODES.ALTO_RENDIMIENTO]: {
    code: PLAN_CODES.ALTO_RENDIMIENTO,
    name: 'Alto Rendimiento',
    audience: 'Organizaciones deportivas que requieren operación, rendimiento y trazabilidad avanzados.',
    professorLimit: 30,
    playerLimit: null,
    siteLimit: null,
    branchLimit: null,
    priceClp: 149000,
    features: [
      ...COMPETITION_FEATURES,
      FEATURES.MEDICAL,
      FEATURES.ADVANCED_ANALYTICS,
      FEATURES.CUSTOM_BRANDING,
      FEATURES.ADVANCED_COMMUNICATIONS,
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
  // La prueba de 15 días expone Alto Rendimiento completo, incluida capacidad
  // multi-sede/multi-rama y criterios personalizados, para demostrar el valor real.
  const trial = isTrialPlan(academy);
  const trialPlan = PLAN_DEFINITIONS[PLAN_CODES.ALTO_RENDIMIENTO];
  const features = new Set(trial ? trialPlan.features : plan.features);

  const manualProfessorLimit = Number(academy.max_profesores);
  return {
    plan: { code: plan.code, name: plan.name, audience: plan.audience, trial },
    limits: {
      professors: trial
        ? trialPlan.professorLimit
        : Number.isInteger(manualProfessorLimit) && manualProfessorLimit > 0
          ? manualProfessorLimit
          : plan.professorLimit,
      players: trial ? null : plan.playerLimit,
      sites: trial ? null : plan.siteLimit,
      branches: trial ? null : plan.branchLimit,
    },
    addOns: {
      guardians: true,
      guardiansIncludedByPlan: true,
      guardiansIncludedByTrial: trial,
    },
    pricing: { planClp: plan.priceClp, guardiansClp: 0 },
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