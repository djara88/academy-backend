const normalizeRole = (value) => String(value || '').toLowerCase().replace(/[_-]/g, '');

const isSuperadminMfaEnforced = () => (
  ['1', 'true', 'yes', 'on'].includes(String(process.env.SUPERADMIN_MFA_ENFORCE || '').trim().toLowerCase())
);

const requireSuperadminMfa = (req, res, next) => {
  if (!isSuperadminMfaEnforced()) return next();
  if (normalizeRole(req.user?.rol) !== 'superadmin') return next();
  if (req.auth?.aal === 'aal2') return next();

  return res.status(403).json({
    error: 'Se requiere verificación MFA para acceder al panel maestro.',
    code: 'MFA_REQUIRED',
    required_aal: 'aal2',
  });
};

module.exports = { isSuperadminMfaEnforced, requireSuperadminMfa };
