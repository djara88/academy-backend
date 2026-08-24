const PLAN_CODES = Object.freeze({
  FORMACION: 'formacion',
  COMPETENCIA: 'competencia',
  ALTO_RENDIMIENTO: 'alto_rendimiento',
});

const GUARDIAN_ADDON_CLP = 15000;

const FEATURES = Object.freeze({
  CORE: 'core',
  FINANCE: 'finanzas',
  UNIFORMS: 'uniformes',
  PROFESSORS: 'profesores',
  EVALUATIONS: 'evaluaciones',
  FRIENDLIES: 'amistosos',
  PUBLIC_PAGE: 'pagina_publica',
  BASIC_EXPORTS: 'exportaciones_basicas',
  OPERATIONAL_NOTIFICATIONS: 'notificaciones_operativas',
  MATCHES: 'partidos',
  TOURNAMENTS: 'torneos',
  MATCH_PREPARATION: 'preparacion_partidos',
  ATTENDANCE_ALERTS: 'alertas_asistencia',
  CUSTOM_EVALUATION_CRITERIA: 'criterios_evaluacion_personalizados',
  CUSTOM_RECOGNITIONS: 'reconocimientos_personalizados',
  MEDICAL: 'ficha_medica',
  ADVANCED_ANALYTICS: 'analitica_avanzada',
  CUSTOM_BRANDING: 'marca_personalizada',
  EXPORTS: 'exportaciones',
  GUARDIANS: 'apoderados',
  WHATSAPP_GROUPS: 'whatsapp_grupos',
  ADVANCED_COMMUNICATIONS: 'comunicaciones_avanzadas',
});

// Base compartida por los tres planes. Amistosos queda fuera de esta base porque
// es una herramienta exclusiva de Formación: Competencia y Alto Rendimiento
// programan su actividad desde el motor de Eventos/Torneos, evitando duplicidad.
const BASE_FEATURES = [
  FEATURES.CORE,
  FEATURES.FINANCE,
  FEATURES.UNIFORMS,
  FEATURES.PROFESSORS,
  FEATURES.EVALUATIONS,
  FEATURES.PUBLIC_PAGE,
  FEATURES.BASIC_EXPORTS,
  FEATURES.OPERATIONAL_NOTIFICATIONS,
];

const FORMATION_FEATURES = [
  ...BASE_FEATURES,
  FEATURES.FRIENDLIES,
];

const COMPETITION_FEATURES = [
  ...BASE_FEATURES,
  FEATURES.MATCHES,
  FEATURES.TOURNAMENTS,
  FEATURES.MATCH_PREPARATION,
  FEATURES.ATTENDANCE_ALERTS,
  FEATURES.CUSTOM_EVALUATION_CRITERIA,
  FEATURES.CUSTOM_RECOGNITIONS,
  FEATURES.EXPORTS,
  FEATURES.WHATSAPP_GROUPS,
];

const PLAN_DEFINITIONS = Object.freeze({
  [PLAN_CODES.FORMACION]: {
    code: PLAN_CODES.FORMACION,
    name: 'Formación',
    audience: 'Profesionaliza la operación diaria de tu academia con gestión deportiva y administrativa en un solo lugar.',
    professorLimit: 5,
    playerLimit: 100,
    siteLimit: 1,
    branchLimit: 1,
    priceClp: 44990,
    features: FORMATION_FEATURES,
  },
  [PLAN_CODES.COMPETENCIA]: {
    code: PLAN_CODES.COMPETENCIA,
    name: 'Competencia',
    audience: 'Academias que quieren automatizar su operación y gestionar toda su actividad competitiva.',
    professorLimit: 10,
    playerLimit: 300,
    siteLimit: 2,
    branchLimit: 2,
    priceClp: 99990,
    features: COMPETITION_FEATURES,
  },
  [PLAN_CODES.ALTO_RENDIMIENTO]: {
    code: PLAN_CODES.ALTO_RENDIMIENTO,
    name: 'Alto Rendimiento',
    audience: 'Organizaciones que necesitan medir, proteger y mejorar el rendimiento de sus deportistas con seguimiento longitudinal.',
    professorLimit: 30,
    playerLimit: null,
    siteLimit: null,
    branchLimit: null,
    priceClp: 149990,
    features: [
      ...COMPETITION_FEATURES,
      FEATURES.MEDICAL,
      FEATURES.ADVANCED_ANALYTICS,
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

const guardianLicenseIsActive = (academy = {}, today = new Date().toISOString().slice(0, 10)) => {
  if (isTrialPlan(academy)) return true;
  if (academy.licencia_apoderados !== true) return false;
  if (!academy.guardian_license_ends_at) return true;
  return String(academy.guardian_license_ends_at).slice(0, 10) >= today;
};

const getPlanDefinition = (academy = {}) => PLAN_DEFINITIONS[resolvePlanCode(academy)];

const getAcademyEntitlements = (academy = {}) => {
  const plan = getPlanDefinition(academy);
  const trial = isTrialPlan(academy);
  const trialPlan = PLAN_DEFINITIONS[PLAN_CODES.ALTO_RENDIMIENTO];
  const features = new Set(trial ? trialPlan.features : plan.features);
  const guardianActive = guardianLicenseIsActive(academy);
  if (guardianActive) features.add(FEATURES.GUARDIANS);

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
      guardians: guardianActive,
      guardiansIncludedByPlan: false,
      guardiansIncludedByTrial: trial,
      guardianLicenseEndsAt: trial ? academy.trial_ends_at || null : academy.guardian_license_ends_at || null,
    },
    pricing: { planClp: plan.priceClp, guardiansClp: GUARDIAN_ADDON_CLP },
    features: [...features],
  };
};

const hasFeature = (academy, feature) => getAcademyEntitlements(academy).features.includes(feature);
const getPlanProfessorLimit = (planCode) => PLAN_DEFINITIONS[planCode]?.professorLimit || PLAN_DEFINITIONS.formacion.professorLimit;

module.exports = {
  PLAN_CODES,
  PLAN_DEFINITIONS,
  FEATURES,
  GUARDIAN_ADDON_CLP,
  normalizePlanText,
  resolvePlanCode,
  getPlanDefinition,
  getAcademyEntitlements,
  guardianLicenseIsActive,
  hasFeature,
  getPlanProfessorLimit,
  isTrialPlan,
};
