const express = require('express');
const { requireWebhookSecret } = require('../middleware/webhookAuth');
const authMiddleware = require('../middleware/auth');
const { requireAcademyParamAccess } = require('../middleware/academyAccess');
const supabase = require('../config/supabase');
const { fetchWithTimeout } = require('../services/httpClient');
const whatsappService = require('../services/whatsappService');
const {
  comparablePhone,
  extractMessageId,
  ingestInboundWhatsApp,
  updateWhatsAppDelivery,
} = require('../services/chatWhatsApp');
const { captureAbsenceReply } = require('../services/absenceFollowupService');

const router = express.Router();
const BACKEND_URL = process.env.BACKEND_URL ? process.env.BACKEND_URL.replace(/\/$/, '') : 'https://academy-backend-kqsv.onrender.com';
const WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET;
const EVOLUTION_URL = process.env.EVOLUTION_API_URL ? process.env.EVOLUTION_API_URL.replace(/\/$/, '') : '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_TIMEOUT_MS = Math.max(3000, Number(process.env.EVOLUTION_TIMEOUT_MS || 12000));
const requireAcademyAccess = requireAcademyParamAccess('academiaId');

const evolutionHeaders = () => ({
  'Content-Type': 'application/json',
  apikey: EVOLUTION_API_KEY,
});

const evolutionRequest = async (path, options = {}) => {
  if (!EVOLUTION_URL || !EVOLUTION_API_KEY) {
    throw new Error('La integración de WhatsApp no está configurada en el servidor.');
  }
  return fetchWithTimeout(`${EVOLUTION_URL}${path}`, {
    ...options,
    headers: { ...evolutionHeaders(), ...(options.headers || {}) },
  }, EVOLUTION_TIMEOUT_MS);
};

const readEvolutionBody = async (response) => {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch (_error) { return { message: text }; }
};

const instanceNameFor = (academyId) => `academia_${academyId}`;
const extractState = (data) => String(data?.instance?.state || data?.data?.instance?.state || data?.data?.state || data?.state || '').toLowerCase();
const extractQr = (data) => data?.qrcode?.base64 || data?.data?.qrcode?.base64 || data?.base64 || data?.data?.base64 || null;
const extractPhone = (data) => {
  const raw = data?.instance?.ownerJid || data?.data?.instance?.ownerJid || data?.ownerJid || data?.data?.ownerJid || '';
  return String(raw).split('@')[0].replace(/\D/g, '') || null;
};

const connectionPayload = (data = {}, extra = {}) => {
  const state = extractState(data);
  return {
    conectado: state === 'open',
    estado: state || extra.estado || 'disconnected',
    qrCode: extractQr(data),
    numero: extractPhone(data),
    ...extra,
  };
};

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
  const looksLikeAutomationReply = /^(si|sí|no|confirmo|confirmar|rechazo|acepto)$/i.test(text);
  if (automationPending && looksLikeAutomationReply) {
    await forwardToAutomationWebhook(academyId, body);
    return;
  }

  const absenceReply = await captureAbsenceReply({ academyId, phone, body: text });
  if (absenceReply.handled) {
    await ingestInboundWhatsApp({ academyId, phone, body: text, externalMessageId: extractMessageId(body) });
    return;
  }

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

// Estado sin efectos secundarios: consultar no crea ni reconecta instancias.
router.get('/connection/:academiaId', authMiddleware, requireAcademyAccess, async (req, res) => {
  const academyId = req.params.academiaId;
  try {
    const response = await evolutionRequest(`/instance/connectionState/${instanceNameFor(academyId)}`, { method: 'GET' });
    if (response.status === 404) {
      return res.json({ conectado: false, estado: 'not_created', qrCode: null, numero: null });
    }
    const data = await readEvolutionBody(response);
    if (!response.ok) return res.status(502).json({ error: data?.message || 'No fue posible consultar WhatsApp.' });
    return res.json(connectionPayload(data));
  } catch (error) {
    return res.status(500).json({ error: error.message || 'No fue posible consultar WhatsApp.' });
  }
});

// Crea/reutiliza la instancia de la academia y entrega QR cuando corresponde.
router.post('/connection/:academiaId/connect', authMiddleware, requireAcademyAccess, async (req, res) => {
  const academyId = req.params.academiaId;
  try {
    const data = await whatsappService.conectarAcademia(academyId);
    return res.json(connectionPayload(data, { success: true }));
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'No fue posible iniciar la conexión.' });
  }
});

// Cierra la sesión actual sin afectar datos de Lestra.
router.post('/connection/:academiaId/disconnect', authMiddleware, requireAcademyAccess, async (req, res) => {
  const academyId = req.params.academiaId;
  try {
    const response = await evolutionRequest(`/instance/logout/${instanceNameFor(academyId)}`, { method: 'DELETE' });
    const data = await readEvolutionBody(response);
    if (!response.ok && response.status !== 404) {
      return res.status(502).json({ success: false, error: data?.message || 'No fue posible desconectar WhatsApp.' });
    }
    return res.json({ success: true, conectado: false, estado: 'disconnected', qrCode: null, numero: null });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'No fue posible desconectar WhatsApp.' });
  }
});

// Cambio de número: elimina la sesión técnica anterior y genera una vinculación limpia.
router.post('/connection/:academiaId/change-number', authMiddleware, requireAcademyAccess, async (req, res) => {
  const academyId = req.params.academiaId;
  const instanceName = instanceNameFor(academyId);
  try {
    const deleteResponse = await evolutionRequest(`/instance/delete/${instanceName}`, { method: 'DELETE' });
    const deleteData = await readEvolutionBody(deleteResponse);
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      return res.status(502).json({ success: false, error: deleteData?.message || 'No fue posible liberar el número anterior.' });
    }

    const data = await whatsappService.conectarAcademia(academyId);
    return res.json(connectionPayload(data, {
      success: true,
      numero: null,
      mensaje: 'Sesión anterior liberada. Escanea el nuevo QR con el número que deseas usar.',
    }));
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'No fue posible cambiar el número de WhatsApp.' });
  }
});

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
