const { fetchWithTimeout } = require('./httpClient');

const BRAND_NAME = 'Lestra';
const BRAND_TAGLINE = 'Gestión que mueve el deporte.';

const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const sendProfessorAccessEmail = async ({ email, name, academyName, temporaryPassword }) => {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) return false;

  const response = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: BRAND_NAME, email: senderEmail },
      to: [{ email, name }],
      subject: `Tu acceso como profesor de ${academyName}`,
      htmlContent: `
        <div style="font-family:Arial,sans-serif;color:#17202a;line-height:1.6">
          <h2>Hola ${escapeHtml(name)}</h2>
          <p><strong>${escapeHtml(academyName)}</strong> te ha creado un acceso de profesor en ${BRAND_NAME}.</p>
          <p>Correo: <strong>${escapeHtml(email)}</strong><br>Contraseña temporal: <strong>${escapeHtml(temporaryPassword)}</strong></p>
          <p>Al ingresar se te pedirá crear una contraseña personal. Tu portal mostrará únicamente las categorías asignadas por la dirección.</p>
          <p>${BRAND_NAME} · ${BRAND_TAGLINE}</p>
        </div>`,
    }),
  }, 10000);

  if (!response.ok) throw new Error(`Brevo respondió con estado ${response.status}`);
  return true;
};

const sendGuardianAccessEmail = async ({ email, name, academyName, temporaryPassword }) => {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) return false;
  const response = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { name: BRAND_NAME, email: senderEmail },
      to: [{ email, name }],
      subject: `Tu acceso de apoderado a ${academyName}`,
      htmlContent: `
        <div style="font-family:Arial,sans-serif;color:#17202a;line-height:1.6">
          <h2>Hola ${escapeHtml(name)}</h2>
          <p><strong>${escapeHtml(academyName)}</strong> habilitó tu acceso privado de apoderado en ${BRAND_NAME}.</p>
          <p>Correo: <strong>${escapeHtml(email)}</strong><br>Contraseña temporal: <strong>${escapeHtml(temporaryPassword)}</strong></p>
          <p>Solo podrás consultar información de los jugadores vinculados a tu cuenta. Al ingresar se te pedirá crear una contraseña personal.</p>
          <p>${BRAND_NAME} · ${BRAND_TAGLINE}</p>
        </div>`,
    }),
  }, 10000);
  if (!response.ok) throw new Error(`Brevo respondió con estado ${response.status}`);
  return true;
};

module.exports = { sendProfessorAccessEmail, sendGuardianAccessEmail };
