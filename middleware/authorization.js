const { isMasterAdminUser } = require('./masterAdmin');
const { requireSuperadminMfa } = require('./requireMfa');

const esSuperadmin = (user) => (
  String(user?.rol || '')
    .toLowerCase()
    .replace(/[_-]/g, '') === 'superadmin'
);

const isAuthorizedSuperadmin = (user) => esSuperadmin(user) && isMasterAdminUser(user);

// Centralize the AAL2 gate, including routes outside /api/saas-admin.
// Identity alone is not enough for privileged reads, writes, deletes or resets.
const requireSuperadmin = (req, res, next) => {
  if (!isAuthorizedSuperadmin(req.user)) {
    return res.status(403).json({
      error: 'Acceso exclusivo para el superadministrador autorizado',
      code: 'SUPERADMIN_IDENTITY_REQUIRED',
    });
  }
  return requireSuperadminMfa(req, res, next);
};

const requireOwnAcademyOrSuperadmin = (req, res, next) => {
  if (isAuthorizedSuperadmin(req.user)) {
    return requireSuperadminMfa(req, res, next);
  }
  if (String(req.user?.academia_id || '') && String(req.user.academia_id) === String(req.params?.id)) {
    return next();
  }
  return res.status(403).json({ error: 'No puedes acceder a otra academia' });
};

module.exports = { requireSuperadmin, requireOwnAcademyOrSuperadmin, isAuthorizedSuperadmin };
