const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('el router compatible de categorías no instala auth global sobre /api', () => {
  const categories = read('routes/categorias.js');
  assert.doesNotMatch(categories, /router\.use\(authMiddleware\)/);
  assert.match(categories, /router\.get\([^\n]+authMiddleware, listCategories\)/);
  assert.match(categories, /router\.post\([^\n]+authMiddleware, requireDirector, createCategory\)/);
});

test('el registro público sigue montado sin auth antes del router de academias', () => {
  const server = read('server.js');
  assert.match(server, /app\.use\('\/api\/academias\/registro-publico', registrationLimiter\)/);
  assert.match(server, /app\.use\('\/api', categoriaRoutes\)/);
  assert.match(server, /app\.use\('\/api\/academias', academiaRoutes\)/);
});
