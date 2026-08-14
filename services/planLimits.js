const DEFAULT_PROFESSOR_LIMIT = 2;

const normalizePlan = (plan) => String(plan || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const PROFESSOR_LIMITS = [
  { matches: ['alto rendimiento', 'elite', 'enterprise'], limit: 15 },
  { matches: ['competencia', 'pro', 'profesional'], limit: 6 },
  { matches: ['formacion', 'basic', 'basico', 'prueba 15 dias', 'trial'], limit: 2 },
];

const getProfessorLimit = (academy = {}) => {
  const override = Number(academy.max_profesores);
  if (Number.isInteger(override) && override > 0) return override;

  const normalized = normalizePlan(academy.plan);
  return PROFESSOR_LIMITS.find(({ matches }) => matches.some((name) => normalized.includes(name)))?.limit
    || DEFAULT_PROFESSOR_LIMIT;
};

module.exports = { DEFAULT_PROFESSOR_LIMIT, getProfessorLimit, normalizePlan };
