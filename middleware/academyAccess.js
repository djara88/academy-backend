const { isAuthorizedSuperadmin } = require('./authorization');

const requireAcademyParamAccess = (paramName = 'academiaId') => (req, res, next) => {
  const requestedAcademyId = String(req.params?.[paramName] || '').trim();
  const userAcademyId = String(req.user?.academia_id || '').trim();

  if (isAuthorizedSuperadmin(req.user) || (userAcademyId && userAcademyId === requestedAcademyId)) {
    return next();
  }

  return res.status(403).json({
    error: 'No puedes operar recursos de otra academia',
    code: 'CROSS_TENANT_ACCESS_DENIED',
  });
};

module.exports = { requireAcademyParamAccess };
