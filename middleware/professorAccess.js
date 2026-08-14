const normalizeRole = (role) => String(role || '').trim().toLowerCase().replace(/[_-]/g, '');

const isProfessor = (user) => normalizeRole(user?.rol) === 'profesor';
const isGuardian = (user) => ['apoderado', 'tutor'].includes(normalizeRole(user?.rol));
const isDirector = (user) => normalizeRole(user?.rol) === 'director';
const isSuperadmin = (user) => normalizeRole(user?.rol) === 'superadmin';

const requireDirector = (req, res, next) => {
  if (!isDirector(req.user)) {
    return res.status(403).json({ error: 'Acceso exclusivo para la dirección de la academia' });
  }
  return next();
};

const requireProfessor = (req, res, next) => {
  if (!isProfessor(req.user)) {
    return res.status(403).json({ error: 'Esta función corresponde al portal de profesores' });
  }
  return next();
};

const requireGuardian = (req, res, next) => {
  if (!isGuardian(req.user)) {
    return res.status(403).json({ error: 'Esta función corresponde al portal de apoderados' });
  }
  return next();
};

const isAllowedProfessorRequest = (req) => {
  const path = req.originalUrl?.split('?')[0] || '';
  return path.startsWith('/api/profesores/me') || path === '/api/academias/mi-plan' || path === '/api/cambiar-password';
};

const isAllowedGuardianRequest = (req) => {
  const path = req.originalUrl?.split('?')[0] || '';
  return path.startsWith('/api/apoderados/me') || path === '/api/academias/mi-plan' || path === '/api/cambiar-password';
};

module.exports = {
  isProfessor,
  isGuardian,
  isDirector,
  isSuperadmin,
  requireDirector,
  requireProfessor,
  requireGuardian,
  isAllowedProfessorRequest,
  isAllowedGuardianRequest,
};
