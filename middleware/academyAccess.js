const isSuperadmin = (user) => (
  String(user?.rol || '').toLowerCase().replace(/[_-]/g, '') === 'superadmin'
);

const requireAcademyParamAccess = (paramName = 'academiaId') => (req, res, next) => {
  const requestedAcademyId = req.params?.[paramName];
  if (isSuperadmin(req.user) || String(req.user?.academia_id) === String(requestedAcademyId)) {
    return next();
  }
  return res.status(403).json({ error: 'No puedes operar recursos de otra academia' });
};

module.exports = { isSuperadmin, requireAcademyParamAccess };
