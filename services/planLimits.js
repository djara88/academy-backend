const { getAcademyEntitlements, normalizePlanText } = require('./planCatalog');
const DEFAULT_PROFESSOR_LIMIT = 2;
const normalizePlan = normalizePlanText;

const getProfessorLimit = (academy = {}) => {
  return getAcademyEntitlements(academy).limits.professors || DEFAULT_PROFESSOR_LIMIT;
};

module.exports = { DEFAULT_PROFESSOR_LIMIT, getProfessorLimit, normalizePlan };
