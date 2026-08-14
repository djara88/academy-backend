const esSuperadmin = (user) => (
  String(user?.rol || '')
    .toLowerCase()
    .replace(/[_-]/g, '') === 'superadmin'
);

const requireSuperadmin = (req, res, next) => {
  if (!esSuperadmin(req.user)) {
    return res.status(403).json({ error: 'Acceso exclusivo para superadministradores' });
  }
  next();
};

const requireOwnAcademyOrSuperadmin = (req, res, next) => {
  if (esSuperadmin(req.user) || String(req.user?.academia_id) === String(req.params.id)) {
    return next();
  }
  return res.status(403).json({ error: 'No puedes acceder a otra academia' });
};

module.exports = { requireSuperadmin, requireOwnAcademyOrSuperadmin };
