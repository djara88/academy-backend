const supabase = require('../config/supabase');

const normalizeAcademyId = (value) => {
  const academyId = String(value || '').trim();
  if (!academyId) {
    const error = new Error('Tenant repository requires a non-empty academy id.');
    error.code = 'TENANT_CONTEXT_REQUIRED';
    throw error;
  }
  return academyId;
};

const scopeRows = (academyId, values) => {
  const rows = Array.isArray(values) ? values : [values];
  const scoped = rows.map((row) => {
    const current = String(row?.academia_id || '').trim();
    if (current && current !== academyId) {
      const error = new Error('Attempted to write data for another academy.');
      error.code = 'CROSS_TENANT_ACCESS_DENIED';
      throw error;
    }
    return { ...(row || {}), academia_id: academyId };
  });
  return Array.isArray(values) ? scoped : scoped[0];
};

const sanitizeUpdate = (academyId, values) => {
  const current = String(values?.academia_id || '').trim();
  if (current && current !== academyId) {
    const error = new Error('Attempted to move data to another academy.');
    error.code = 'CROSS_TENANT_ACCESS_DENIED';
    throw error;
  }
  const sanitized = { ...(values || {}) };
  delete sanitized.academia_id;
  return sanitized;
};

const createTenantRepository = ({ academyId, client = supabase } = {}) => {
  const tenantId = normalizeAcademyId(academyId);

  const table = (tableName) => {
    const name = String(tableName || '').trim();
    if (!name) throw new Error('Tenant repository requires a table name.');

    return {
      select(columns = '*', options) {
        return client.from(name).select(columns, options).eq('academia_id', tenantId);
      },
      update(values) {
        return client.from(name).update(sanitizeUpdate(tenantId, values)).eq('academia_id', tenantId);
      },
      delete() {
        return client.from(name).delete().eq('academia_id', tenantId);
      },
      insert(values, options) {
        return client.from(name).insert(scopeRows(tenantId, values), options);
      },
      upsert(values, options) {
        return client.from(name).upsert(scopeRows(tenantId, values), options);
      },
    };
  };

  return Object.freeze({ academyId: tenantId, table });
};

const tenantRepositoryFromRequest = (req, client = supabase) => {
  if (req?.tenant?.isSuperadmin || !req?.tenant?.academyId) {
    const error = new Error('A tenant-scoped repository cannot be created without a concrete academy context.');
    error.code = 'TENANT_CONTEXT_REQUIRED';
    throw error;
  }
  return createTenantRepository({ academyId: req.tenant.academyId, client });
};

module.exports = {
  createTenantRepository,
  tenantRepositoryFromRequest,
  scopeRows,
  sanitizeUpdate,
};
