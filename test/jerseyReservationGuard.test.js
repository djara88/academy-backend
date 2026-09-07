const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const guardSource = fs.readFileSync(path.join(root, 'middleware', 'jerseyReservationGuard.js'), 'utf8');

test('pre-matrícula valida el dorsal antes de crear o editar', () => {
  assert.match(serverSource, /app\.post\('\/api\/prematriculas',\s*authMiddleware,\s*jerseyReservationGuard\)/);
  assert.match(serverSource, /app\.put\('\/api\/prematriculas\/:id',\s*authMiddleware,\s*jerseyReservationGuard\)/);
  assert.match(serverSource, /app\.use\('\/api\/prematriculas',\s*prematriculaRoutes\)/);

  const postGuardIndex = serverSource.indexOf("app.post('/api/prematriculas', authMiddleware, jerseyReservationGuard)");
  const routerIndex = serverSource.indexOf("app.use('/api/prematriculas', prematriculaRoutes)");
  assert.ok(postGuardIndex >= 0 && postGuardIndex < routerIndex, 'el guard debe ejecutarse antes del router de pre-matrículas');
});

test('guard usa rama, categoría y excluye la pre-matrícula editada', () => {
  assert.match(guardSource, /assertJerseyNumberAvailable/);
  assert.match(guardSource, /branchId:\s*player\.rama_id/);
  assert.match(guardSource, /categoryId:\s*player\.categoria_id\s*\|\|\s*null/);
  assert.match(guardSource, /excludePrematriculaId:\s*req\.params\?\.id\s*\|\|\s*null/);
  assert.match(guardSource, /JERSEY_BRANCH_REQUIRED/);
});
