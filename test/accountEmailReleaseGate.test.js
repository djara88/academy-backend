const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { emailDeliveryConfigured, escapeHtml, accountLinkRedirect, sendAccountLink } = require('../services/accountEmail');

const read = () => fs.readFileSync(path.join(__dirname, '..', 'routes', 'academias.js'), 'utf8');
const withEnv = async (fn) => {
  const prevKey = process.env.BREVO_API_KEY;
  const prevEmail = process.env.BREVO_SENDER_EMAIL;
  const prevOrigin = process.env.AUTH_PUBLIC_APP_ORIGIN;
  const previousFetch = global.fetch;
  try { await fn(); }
  finally {
    if (prevKey === undefined) delete process.env.BREVO_API_KEY; else process.env.BREVO_API_KEY = prevKey;
    if (prevEmail === undefined) delete process.env.BREVO_SENDER_EMAIL; else process.env.BREVO_SENDER_EMAIL = prevEmail;
    if (prevOrigin === undefined) delete process.env.AUTH_PUBLIC_APP_ORIGIN; else process.env.AUTH_PUBLIC_APP_ORIGIN = prevOrigin;
    global.fetch = previousFetch;
  }
};

test('registro público crea usuario sin confirmar y exige un enlace de signup enviado', () => {
  const fragment = read().split("router.post('/registro-publico'")[1]?.split('// 🚀 NUEVA RUTA: COMPLETAR PERFIL CON GOOGLE')[0];
  assert.ok(fragment);
  assert.match(fragment, /generateLink\(\{\s*type: 'signup'/);
  assert.doesNotMatch(fragment, /email_confirm:\s*true/);
  assert.match(fragment, /sendAccountLink\(\{/);
  assert.match(fragment, /requiresEmailVerification: true/);
  assert.match(fragment, /createdAuthUser/);
});

test('el administrador envía recuperación de un solo uso sin sobrescribir contraseñas', () => {
  const fragment = read().split("router.post('/:id/reset-password'")[1]?.split('// RUTAS DE TÉRMINOS Y CONDICIONES')[0];
  assert.ok(fragment);
  assert.match(fragment, /generateLink\(\{\s*type: 'recovery'/);
  assert.match(fragment, /getUserById\(director\.id\)/);
  assert.match(fragment, /sendAccountLink\(\{/);
  assert.doesNotMatch(fragment, /updateUserById/);
  assert.doesNotMatch(fragment, /generateTemporaryPassword/);
});

test('sin entrega de correo las altas y recuperaciones fallan cerradas', async () => withEnv(async () => {
  delete process.env.BREVO_API_KEY;
  delete process.env.BREVO_SENDER_EMAIL;
  assert.equal(emailDeliveryConfigured(), false);
  await assert.rejects(
    sendAccountLink({ to: 'test@example.test', link: 'https://example.test/verify', purpose: 'verify' }),
    (err) => err.code === 'ACCOUNT_EMAIL_NOT_CONFIGURED'
  );
}));

test('el correo HTML neutraliza nombres maliciosos y comprueba respuesta de Brevo', async () => withEnv(async () => {
  process.env.BREVO_API_KEY = 'fixture-not-a-secret';
  process.env.BREVO_SENDER_EMAIL = 'noreply@example.test';
  let sent = null;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
    sent = JSON.parse(options.body);
    return new Response('', { status: 201 });
  };
  await sendAccountLink({
    to: 'owner@example.test',
    recipientName: '<script>alert(1)</script>',
    academyName: 'Club & equipo',
    link: 'https://example.test/verify?token=abc&next=login',
    purpose: 'verify',
  });
  assert.match(sent.htmlContent, /&lt;script&gt;/);
  assert.match(sent.htmlContent, /Club &amp; equipo/);
  assert.match(sent.htmlContent, /abc&amp;next=login/);
  assert.doesNotMatch(sent.htmlContent, /<script>/);
  assert.equal(escapeHtml('<>&'), '&lt;&gt;&amp;');
}));

test('enlaces de redirección son HTTPS y sólo usan rutas de autenticación conocidas', async () => withEnv(async () => {
  delete process.env.AUTH_PUBLIC_APP_ORIGIN;
  assert.equal(accountLinkRedirect('/login'), 'https://deportivo.lestra.app/login');
  assert.equal(accountLinkRedirect('/cambiar-password'), 'https://deportivo.lestra.app/cambiar-password');
  assert.throws(() => accountLinkRedirect('/api/delete'));
  process.env.AUTH_PUBLIC_APP_ORIGIN = 'http://localhost:5173';
  assert.throws(() => accountLinkRedirect('/login'));
}));

test('recuperación pública no revela existencia de cuentas y aplica limitador', () => {
  const route = read().split("router.post('/recuperar-acceso'")[1]?.split('// 🚀 NUEVA RUTA: REGISTRO PÚBLICO')[0];
  assert.ok(route);
  assert.match(route, /type: 'recovery'/);
  assert.match(route, /res.status\(202\)\.json\(generic\)/);
  assert.match(route, /sendAccountLink/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.use\('\/api\/academias\/recuperar-acceso', sensitiveLimiter\)/);
});
