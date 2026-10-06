const supabase = require('../config/supabase');
const { fetchWithTimeout } = require('./httpClient');

const MAX_ATTEMPTS = 5;
const DEFAULT_POLL_MS = 30000;
const STALE_PROCESSING_MS = 10 * 60 * 1000;

const getNotificationRecipient = () => String(process.env.SUPERADMIN_NOTIFICATION_EMAIL || '').trim().toLowerCase();

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const formatChileDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('es-CL', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Santiago',
  }).format(date);
};

const buildAcademyEmail = (academy) => {
  const rows = [
    ['Academia', academy.nombre],
    ['Director/a', academy.nombre_director],
    ['Correo director', academy.director_email],
    ['Correo academia', academy.correo_academia],
    ['Teléfono', academy.telefono],
    ['Dirección', academy.direccion],
    ['Plan', academy.plan || academy.plan_codigo],
    ['Estado suscripción', academy.subscription_status],
    ['Registrada', formatChileDateTime(academy.created_at)],
    ['Fin de prueba', academy.trial_ends_at ? formatChileDateTime(academy.trial_ends_at) : 'No aplica'],
    ['ID interno', academy.id],
  ];

  const tableRows = rows
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
    .map(([label, value]) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#374151;">${escapeHtml(label)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#111827;">${escapeHtml(value)}</td>
      </tr>`)
    .join('');

  return `
    <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#111827;">
      <div style="padding:24px;border:1px solid #e5e7eb;border-radius:14px;background:#ffffff;">
        <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;">Lestra · Administración SaaS</div>
        <h2 style="margin:8px 0 8px;font-size:24px;">Nueva escuela registrada</h2>
        <p style="margin:0 0 18px;color:#4b5563;">Se registró una nueva academia en Lestra. Estos son los datos disponibles al momento del alta.</p>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
          ${tableRows}
        </table>
        <p style="margin:18px 0 0;font-size:12px;color:#6b7280;">Este mensaje es informativo. No contiene contraseñas ni credenciales de acceso.</p>
      </div>
    </div>`;
};

const sendBrevoNotification = async (academy, recipient) => {
  const apiKey = String(process.env.BREVO_API_KEY || '').trim();
  const senderEmail = String(process.env.BREVO_SENDER_EMAIL || '').trim();
  if (!apiKey || !senderEmail) {
    const error = new Error('Brevo no está configurado para notificaciones administrativas.');
    error.code = 'BREVO_NOT_CONFIGURED';
    throw error;
  }

  const response = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'Lestra', email: senderEmail },
      to: [{ email: recipient }],
      subject: `🏫 Nueva escuela registrada en Lestra: ${academy.nombre || 'Sin nombre'}`,
      htmlContent: buildAcademyEmail(academy),
    }),
  }, 10000);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Brevo respondió ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
};

const retryDelayMs = (attempts) => Math.min(60 * 60 * 1000, Math.max(60 * 1000, (2 ** Math.max(0, attempts - 1)) * 60 * 1000));

const startAcademyRegistrationNotifier = () => {
  if (String(process.env.ACADEMY_REGISTRATION_EMAIL_NOTIFICATIONS || 'true').toLowerCase() === 'false') {
    return { stop() {} };
  }

  const pollMs = Math.max(15000, Number(process.env.ACADEMY_REGISTRATION_EMAIL_POLL_MS || DEFAULT_POLL_MS));
  let running = false;
  let stopped = false;
  let warnedMissingConfig = false;

  const processPending = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const recipient = getNotificationRecipient();
      const brevoReady = Boolean(String(process.env.BREVO_API_KEY || '').trim() && String(process.env.BREVO_SENDER_EMAIL || '').trim());
      if (!recipient || !brevoReady) {
        if (!warnedMissingConfig) {
          console.warn('⚠️ Alertas de nuevas academias inactivas: falta SUPERADMIN_NOTIFICATION_EMAIL o configuración de Brevo.');
          warnedMissingConfig = true;
        }
        return;
      }
      warnedMissingConfig = false;

      const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
      await supabase.from('site_admin_notifications')
        .update({ status: 'pending', processing_at: null, next_attempt_at: new Date().toISOString() })
        .eq('tipo', 'new_academy')
        .eq('status', 'processing')
        .lt('processing_at', staleBefore);

      const nowIso = new Date().toISOString();
      const { data: pending, error: pendingError } = await supabase
        .from('site_admin_notifications')
        .select('id,academia_id,attempts')
        .eq('tipo', 'new_academy')
        .eq('status', 'pending')
        .lte('next_attempt_at', nowIso)
        .order('created_at', { ascending: true })
        .limit(10);
      if (pendingError) throw pendingError;

      for (const notification of pending || []) {
        if (stopped) break;

        const { data: claimed, error: claimError } = await supabase
          .from('site_admin_notifications')
          .update({ status: 'processing', processing_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', notification.id)
          .eq('status', 'pending')
          .select('id')
          .maybeSingle();
        if (claimError) throw claimError;
        if (!claimed) continue;

        try {
          const { data: academy, error: academyError } = await supabase
            .from('academias')
            .select('id,nombre,nombre_director,director_email,correo_academia,telefono,direccion,plan,plan_codigo,subscription_status,trial_started_at,trial_ends_at,created_at')
            .eq('id', notification.academia_id)
            .maybeSingle();
          if (academyError) throw academyError;
          if (!academy) throw new Error('La academia asociada a la notificación ya no existe.');

          await sendBrevoNotification(academy, recipient);
          await supabase.from('site_admin_notifications').update({
            status: 'sent', recipient, sent_at: new Date().toISOString(), processing_at: null,
            attempts: Number(notification.attempts || 0) + 1, last_error: null, updated_at: new Date().toISOString(),
          }).eq('id', notification.id);
          console.log(`📧 Notificación de nueva academia enviada: ${academy.nombre || academy.id}`);
        } catch (error) {
          const attempts = Number(notification.attempts || 0) + 1;
          const failed = attempts >= MAX_ATTEMPTS;
          await supabase.from('site_admin_notifications').update({
            status: failed ? 'failed' : 'pending',
            attempts,
            processing_at: null,
            next_attempt_at: new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
            last_error: String(error?.message || error).slice(0, 1000),
            updated_at: new Date().toISOString(),
          }).eq('id', notification.id);
          console.error('❌ No fue posible enviar alerta de nueva academia:', error?.message || error);
        }
      }
    } catch (error) {
      console.error('❌ Error procesando alertas de nuevas academias:', error?.message || error);
    } finally {
      running = false;
    }
  };

  const startupTimer = setTimeout(processPending, 3000);
  startupTimer.unref?.();
  const timer = setInterval(processPending, pollMs);
  timer.unref?.();
  console.log(`📨 Alertas de nuevas academias activas (cada ${Math.round(pollMs / 1000)} s).`);

  return {
    stop() {
      stopped = true;
      clearTimeout(startupTimer);
      clearInterval(timer);
    },
    runNow: processPending,
  };
};

module.exports = { startAcademyRegistrationNotifier, buildAcademyEmail, getNotificationRecipient };
