'use strict';

const { fetchWithTimeout } = require('./httpClient');

const emailDeliveryConfigured = () => Boolean(
  String(process.env.BREVO_API_KEY || '').trim() && String(process.env.BREVO_SENDER_EMAIL || '').trim(),
);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const accountLinkRedirect = (path) => {
  const base = String(process.env.AUTH_PUBLIC_APP_ORIGIN || 'https://deportivo.lestra.app').trim();
  const origin = new URL(base);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/') {
    throw new Error('AUTH_PUBLIC_APP_ORIGIN debe ser un origen HTTPS sin ruta ni credenciales.');
  }
  if (!['/login', '/cambiar-password'].includes(path)) throw new Error('Ruta de verificación no autorizada.');
  return new URL(path, origin).toString();
};

const sendAccountLink = async ({ to, recipientName, academyName, link, purpose }) => {
  if (!emailDeliveryConfigured()) {
    const err = new Error('Servicio de correo de cuentas no configurado.');
    err.code = 'ACCOUNT_EMAIL_NOT_CONFIGURED';
    throw err;
  }
  if (!['verify', 'recover'].includes(purpose)) throw new Error('Tipo de correo no autorizado.');
  const target = new URL(String(link));
  if (target.protocol !== 'https:' || target.username || target.password) {
    throw new Error('Supabase devolvió un enlace de cuenta inválido.');
  }
  const header = purpose === 'verify' ? 'Confirma tu correo para activar Lestra' : 'Recupera el acceso a Lestra';
  const help = purpose === 'verify'
    ? 'Para activar tu academia, confirma la propiedad de tu correo electrónico.'
    : 'Solicitaste recuperar tu acceso. La contraseña anterior no se modificará hasta que completes el cambio.';
  const buttonText = purpose === 'verify' ? 'Confirmar mi correo' : 'Cambiar mi contraseña';
  const response = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': String(process.env.BREVO_API_KEY).trim(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'Lestra Deportivo', email: String(process.env.BREVO_SENDER_EMAIL).trim() },
      to: [{ email: String(to) }],
      subject: header,
      htmlContent: `<div style="font-family:Arial,sans-serif;color:#192232;line-height:1.6"><h2>${escapeHtml(header)}</h2><p>Hola ${escapeHtml(recipientName || 'deportista')},</p><p>${escapeHtml(help)}</p><p>${escapeHtml(academyName)}</p><p><a href="${escapeHtml(target.toString())}" style="display:inline-block;padding:13px 18px;background:#3157ff;color:white;border-radius:8px;text-decoration:none">${buttonText}</a></p><p>Si no solicitaste esta acción, ignora este mensaje. No compartas el enlace.</p></div>`,
    }),
  }, 10000);
  if (!response.ok) {
    const err = new Error('El proveedor de correo no confirmó la entrega.');
    err.code = 'ACCOUNT_EMAIL_DELIVERY_FAILED';
    err.status = response.status;
    throw err;
  }
};

module.exports = { emailDeliveryConfigured, escapeHtml, accountLinkRedirect, sendAccountLink };
