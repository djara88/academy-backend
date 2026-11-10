const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('el enlace público se genera en el dominio desplegado de Lestra Deportivo', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/publicPageAdmin.js'), 'utf8');
  assert.match(source, /LESTRA_PUBLIC_ACADEMY_ORIGIN \|\| 'https:\/\/deportivo\.lestra\.app'/);
  assert.doesNotMatch(source, /process\.env\.FRONTEND_URL \|\| 'https:\/\/lestra\.app'/);
  assert.match(source, /url: `\$\{publicBaseUrl\(\)\}\/a\/\$\{academy\.subdominio\}`/);
});
