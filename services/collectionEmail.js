const { fetchWithTimeout } = require('./httpClient');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const sendBrevo = async ({ to, name, subject, htmlContent }) => {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail || !to) return false;
  const response = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Lestra Deportivo', email: senderEmail },
      to: [{ email: to, name: name || 'Apoderado' }],
      subject,
      htmlContent,
    }),
  }, 10000);
  if (!response.ok) throw new Error(`Brevo respondió con estado ${response.status}`);
  return true;
};

const sendCollectionVerificationEmail = ({ email, name, academyName, code }) => sendBrevo({
  to: email,
  name,
  subject: `Código para consultar pagos · ${academyName}`,
  htmlContent: `
    <div style="font-family:Arial,sans-serif;color:#17202a;line-height:1.6;max-width:620px;margin:auto">
      <h2>Consulta segura de estado de cuenta</h2>
      <p><strong>${escapeHtml(academyName)}</strong> utiliza Lestra Deportivo para gestionar su cobranza.</p>
      <p>Tu código temporal es:</p>
      <div style="font-size:30px;font-weight:800;letter-spacing:8px;padding:16px 20px;background:#f3f6f8;border-radius:12px;display:inline-block">${escapeHtml(code)}</div>
      <p>Este código vence en 10 minutos. Si no solicitaste esta consulta, puedes ignorar el mensaje.</p>
      <p style="font-size:12px;color:#6b7280">Por seguridad, Lestra nunca solicita contraseñas ni datos bancarios mediante este correo.</p>
    </div>`,
});

const sendCollectionStatementEmail = ({ email, name, academyName, totalPending, portalUrl, items = [] }) => {
  const money = (value) => new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(Number(value) || 0);
  const rows = items.slice(0, 12).map((item) => `<li style="margin:6px 0"><strong>${escapeHtml(item.label)}</strong>: ${escapeHtml(money(item.amount))}${item.installment ? ` · ${escapeHtml(item.installment)}` : ''}</li>`).join('');
  return sendBrevo({
    to: email,
    name,
    subject: `Estado de cuenta · ${academyName}`,
    htmlContent: `
      <div style="font-family:Arial,sans-serif;color:#17202a;line-height:1.6;max-width:640px;margin:auto">
        <h2>Estado de cuenta de ${escapeHtml(academyName)}</h2>
        <p>Hola ${escapeHtml(name || 'apoderado')}, estos son los conceptos pendientes registrados por la academia:</p>
        ${rows ? `<ul>${rows}</ul>` : '<p>No hay conceptos pendientes.</p>'}
        <p style="font-size:20px"><strong>Total pendiente: ${escapeHtml(money(totalPending))}</strong></p>
        <p><a href="${escapeHtml(portalUrl)}" style="display:inline-block;background:#289E9D;color:white;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">Ver estado de cuenta y opciones de pago</a></p>
        <p style="font-size:12px;color:#6b7280">El enlace es personal y temporal. No lo compartas. Informar una transferencia no la registra como pagada hasta que la academia la valide.</p>
      </div>`,
  });
};

module.exports = { sendCollectionVerificationEmail, sendCollectionStatementEmail };