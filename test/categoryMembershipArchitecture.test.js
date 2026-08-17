const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const branchContext = fs.readFileSync(path.join(__dirname, '..', 'services', 'branchContext.js'), 'utf8');
const categoriesRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'categorias.js'), 'utf8');
const legacyPlayersRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'jugadores.js'), 'utf8');

test('jugador_categoria sigue siendo la relación muchos-a-muchos de categorías', () => {
  assert.match(legacyPlayersRoute, /jugador_categoria\s*\(\s*categorias/);
  assert.match(branchContext, /from\('jugador_categoria'\)/);
  assert.match(branchContext, /getCategoryMemberIds/);
});

test('el alcance por categoría valida membresía sin convertir la inscripción en una sola categoría', () => {
  assert.match(branchContext, /categoria_id es solo una referencia de compatibilidad|categoria_id en/);
  assert.match(branchContext, /CATEGORY_MEMBERSHIP_REQUIRED/);
  const activeEnrollmentSection = branchContext.slice(
    branchContext.indexOf('const getActiveEnrollments'),
    branchContext.indexOf('const getPlayersForEnrollments'),
  );
  assert.doesNotMatch(activeEnrollmentSection, /query\s*=\s*query\.eq\('categoria_id'/);
});

test('asignar es aditivo y existe retiro explícito de una categoría', () => {
  assert.match(categoriesRoute, /Asignación aditiva/);
  assert.match(categoriesRoute, /upsert\(\[\{ jugador_id: player\.id, categoria_id: category\.id \}\]/);
  assert.match(categoriesRoute, /router\.delete\(\['\/categorias\/:categoryId\/jugadores\/:playerId'/);
  assert.match(categoriesRoute, /getBranchMemberships/);
});
