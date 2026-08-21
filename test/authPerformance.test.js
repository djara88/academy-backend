const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'auth.js'), 'utf8');

test('auth verifica JWT con getClaims en vez de getUser por request', () => {
  assert.match(source, /supabase\.auth\.getClaims\(token\)/);
  assert.doesNotMatch(source, /supabase\.auth\.getUser\(token\)/);
});

test('superadmin se resuelve antes de consultar usuarios', () => {
  const masterIndex = source.indexOf('if (isMasterAdminUser(verifiedUser))');
  const usersQueryIndex = source.indexOf(".from('usuarios')");
  assert.ok(masterIndex >= 0, 'Debe existir fast-path de superadmin');
  assert.ok(usersQueryIndex >= 0, 'Debe mantenerse validación de usuarios normales');
  assert.ok(masterIndex < usersQueryIndex, 'Superadmin no debe pagar una consulta de perfil innecesaria');
});

test('usuarios normales siguen validando estado y academia en base de datos', () => {
  assert.match(source, /usuario\.activo === false/);
  assert.match(source, /\.from\('academias'\)/);
  assert.match(source, /getSubscriptionState\(academy\)/);
});
