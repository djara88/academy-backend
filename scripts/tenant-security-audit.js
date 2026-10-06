const fs = require('node:fs');

const criticalRoutes = [
  'routes/alumnos.js',
  'routes/jugadores.js',
  'routes/matriculas.js',
  'routes/finanzas.js',
  'routes/finanzasMultirama.js',
  'routes/apoderados.js',
  'routes/profesoresMultirama.js',
];

for (const file of criticalRoutes) {
  const source = fs.readFileSync(file, 'utf8');
  if (/req\.user\.academia_id/.test(source) || /\{\s*academia_id\s*\}\s*=\s*req\.user/.test(source)) {
    throw new Error(`Tenant audit failed: ${file} reads academia_id directly from req.user instead of immutable req.tenant.`);
  }
  if (!source.includes('requireTenantContext')) {
    throw new Error(`Tenant audit failed: ${file} does not install requireTenantContext.`);
  }
}

const academyAccess = fs.readFileSync('middleware/academyAccess.js', 'utf8');
if (!academyAccess.includes('isAuthorizedSuperadmin')) {
  throw new Error('Tenant audit failed: academyAccess must restrict cross-tenant bypass to the authorized master UUID.');
}
if (/rol[^\n]*superadmin/i.test(academyAccess)) {
  throw new Error('Tenant audit failed: academyAccess must not grant bypass from a role string alone.');
}

const tenantContext = fs.readFileSync('middleware/tenantContext.js', 'utf8');
for (const expected of ['CROSS_TENANT_ACCESS_DENIED', 'Object.freeze', 'req.user?.academia_id']) {
  if (!tenantContext.includes(expected)) throw new Error(`Tenant audit failed: tenant context missing ${expected}.`);
}

const repository = fs.readFileSync('services/tenantRepository.js', 'utf8');
for (const expected of [
  ".eq('academia_id', tenantId)",
  'CROSS_TENANT_ACCESS_DENIED',
  'scopeRows',
  'sanitizeUpdate',
]) {
  if (!repository.includes(expected)) throw new Error(`Tenant audit failed: tenant repository missing ${expected}.`);
}

const finance = fs.readFileSync('routes/finanzas.js', 'utf8');
const financeMulti = fs.readFileSync('routes/finanzasMultirama.js', 'utf8');
for (const [file, source] of [['routes/finanzas.js', finance], ['routes/finanzasMultirama.js', financeMulti]]) {
  if (!source.includes('createTenantRepository')) {
    throw new Error(`Tenant audit failed: ${file} financial writes are not using the tenant repository.`);
  }
}

const professor = fs.readFileSync('routes/profesoresMultirama.js', 'utf8');
if (!/academia_id:\s*req\.tenant\.academyId[\s\S]{0,250}upsert\(rows/.test(professor)) {
  throw new Error('Tenant audit failed: attendance upsert rows must carry the authenticated academy_id.');
}

console.log('Tenant isolation security audit passed.');
