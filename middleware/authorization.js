const { isMasterAdminUser } = require('./masterAdmin');

const esSuperadmin = (user) => (
  String(user?.rol || '')
    .toLowerCase()
    .replace(/[_-]/g, '') === 'superadmin'
);

const isAuthorizedSuperadmin = (user) => esSuperadmin(user) && isMasterAdminUser(user);

const requireSuperadmin = (req, res, next) => {
  if (!isAuthorizedSuperadmin(req.user)) {
    return res.status(403).json({
      error: 'Acceso exclusivo para el superadministrador autorizado',
      code: 'SUPERADMIN_IDENTITY_REQUIRED',
    });
  }
  return next();
};

const requireOwnAcademyOrSuperadmin = (req, res, next) => {
  if (isAuthorizedSuperadmin(req.user) || String(req.user?.academia_id) === String(req.params.id)) {
    return next();
  }
  return res.status(403).json({ error: 'No puedes acceder a otra academia' });
};

module.exports = { requireSuperadmin, requireOwnAcademyOrSuperadmin, isAuthorizedSuperadmin };
