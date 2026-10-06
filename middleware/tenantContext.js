const { isAuthorizedSuperadmin } = require('./authorization');

const normalizeTenantId = (value) => {
  const normalized = String(value || '').trim();
  return normalized || null;
};

const requestedTenantIds = (req) => {
  const candidates = [
    req.body?.academia_id,
    req.body?.academiaId,
    req.query?.academia_id,
    req.query?.academiaId,
    req.params?.academia_id,
    req.params?.academiaId,
    req.params?.academy_id,
    req.params?.academyId,
  ];
  return [...new Set(candidates.map(normalizeTenantId).filter(Boolean))];
};

const requireTenantContext = (req, res, next) => {
  if (isAuthorizedSuperadmin(req.user)) {
    req.tenant = Object.freeze({ academyId: null, isSuperadmin: true });
    return next();
  }

  const academyId = normalizeTenantId(req.user?.academia_id);
  if (!academyId) {
    return res.status(403).json({
      error: 'No existe un contexto de academia válido para esta sesión.',
      code: 'TENANT_CONTEXT_REQUIRED',
    });
  }

  const conflicting = requestedTenantIds(req).find((requestedId) => requestedId !== academyId);
  if (conflicting) {
    return res.status(403).json({
      error: 'No puedes operar recursos de otra academia.',
      code: 'CROSS_TENANT_ACCESS_DENIED',
    });
  }

  req.tenant = Object.freeze({ academyId, isSuperadmin: false });
  return next();
};

module.exports = { normalizeTenantId, requestedTenantIds, requireTenantContext };
