const normalizeRole = (role) => String(role || '').trim().toLowerCase().replace(/[_-]/g, '');

const isProfessor = (user) => normalizeRole(user?.rol) === 'profesor';
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

const isAllowedProfessorRequest = (req) => {
  const path = req.originalUrl?.split('?')[0] || '';
  return path.startsWith('/api/profesores/me') || path === '/api/cambiar-password';
};

module.exports = {
  isProfessor,
  isDirector,
  isSuperadmin,
  requireDirector,
  requireProfessor,
  isAllowedProfessorRequest,
};
