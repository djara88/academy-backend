const express = require('express');
const { requireWebhookSecret } = require('../middleware/webhookAuth');
const supabase = require('../config/supabase');
const { fetchWithTimeout } = require('../services/httpClient');
const {
  comparablePhone,
  extractMessageId,
  ingestInboundWhatsApp,
  updateWhatsAppDelivery,
} = require('../services/chatWhatsApp');

const router = express.Router();
const BACKEND_URL = process.env.BACKEND_URL ? process.env.BACKEND_URL.replace(/\/$/, '') : 'https://academy-backend-kqsv.onrender.com';
const WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET;

const extractText = (body) => {
  const payload = body?.data || body;
  const message = payload?.message;
  if (!message) return '';
  return String(
    message.conversation
    || message.extendedTextMessage?.text
    || message.buttonsResponseMessage?.selectedButtonId
    || message.listResponseMessage?.singleSelectReply?.selectedRowId
    || ''
  ).trim();
};

const getPayload = (body) => body?.data || body || {};
const getRemoteJid = (body) => String(getPayload(body)?.key?.remoteJid || body?.sender || '').trim();
const getPhone = (body) => getRemoteJid(body).split('@')[0].replace(/\D/g, '');

const hasPendingAutomation = async (academyId, phone) => {
  const suffix = comparablePhone(phone);
  if (!suffix) return false;
  const [matchResult, tournamentResult] = await Promise.all([
    supabase.from('partido_citaciones')
      .select('id,partidos!inner(academia_id)')
      .eq('partidos.academia_id', academyId)
      .like('telefono_apoderado', `%${suffix}%`)
      .neq('paso_bot', 'FINALIZADO')
      .limit(1),
    supabase.from('torneo_participantes')
      .select('id,torneos!inner(academia_id)')
      .eq('torneos.academia_id', academyId)
      .like('telefono_apoderado', `%${suffix}%`)
      .neq('paso_bot', 'FINALIZADO')
      .limit(1),
  ]);
  if (matchResult.error) throw matchResult.error;
  if (tournamentResult.error) throw tournamentResult.error;
  return Boolean(matchResult.data?.length || tournamentResult.data?.length);
};

const forwardToAutomationWebhook = async (academyId, body) => {
  if (!WEBHOOK_SECRET) return;
  try {
    await fetchWithTimeout(`${BACKEND_URL}/api/whatsapp/webhook/${academyId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Syncademia-Webhook-Secret': WEBHOOK_SECRET,
      },
      body: JSON.stringify(body),
    }, 12000);
  } catch (error) {
    console.error('No fue posible reenviar un evento a la automatización WhatsApp:', error?.message || 'Error desconocido');
  }
};

const processMessageUpsert = async (academyId, body) => {
  const payload = getPayload(body);
  if (!payload?.key || payload.key.fromMe) return;
  const remoteJid = getRemoteJid(body);
  if (!remoteJid || remoteJid.includes('@g.us')) return;
  const text = extractText(body);
  if (!text) return;
  const phone = getPhone(body);
  if (!phone) return;

  const automationPending = await hasPendingAutomation(academyId, phone);
  if (automationPending) {
    await forwardToAutomationWebhook(academyId, body);
    return;
  }

  const result = await ingestInboundWhatsApp({
    academyId,
    phone,
    body: text,
    externalMessageId: extractMessageId(body),
  });
  if (!result.stored && !['tutor_not_found', 'ambiguous_phone'].includes(result.reason)) {
    console.warn(`Mensaje WhatsApp no almacenado en Comunicaciones: ${result.reason || 'sin motivo'}`);
  }
};

const processMessageUpdate = async (body) => {
  const payload = getPayload(body);
  const externalMessageId = extractMessageId(body);
  const status = payload?.update?.status
    || payload?.status
    || payload?.messageUpdate?.status
    || body?.status;
  if (!externalMessageId || status == null) return;
  await updateWhatsAppDelivery({ externalMessageId, status });
};

router.post('/webhook/:academiaId', requireWebhookSecret, async (req, res) => {
  res.status(200).send('OK');
  const academyId = req.params.academiaId;
  const event = String(req.body?.event || '').toLowerCase();
  try {
    if (event.includes('messages.update') || event.includes('send.message.update')) {
      await processMessageUpdate(req.body);
      return;
    }
    await processMessageUpsert(academyId, req.body);
  } catch (error) {
    console.error('Error procesando puente WhatsApp ↔ Comunicaciones:', error?.message || 'Error desconocido');
  }
});

module.exports = router;
