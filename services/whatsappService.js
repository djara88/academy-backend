// services/whatsappService.js

const supabase = require('../config/supabase');
const { fetchWithTimeout } = require('./httpClient');

const EVOLUTION_URL = process.env.EVOLUTION_API_URL ? process.env.EVOLUTION_API_URL.replace(/\/$/, '') : '';
const API_KEY = process.env.EVOLUTION_API_KEY;
const WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET;
const BACKEND_URL = process.env.BACKEND_URL ? process.env.BACKEND_URL.replace(/\/$/, '') : 'https://academy-backend-kqsv.onrender.com';
const EVOLUTION_TIMEOUT_MS = Math.max(3000, Number(process.env.EVOLUTION_TIMEOUT_MS || 12000));
const WHATSAPP_EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'SEND_MESSAGE_UPDATE'];

const getHeaders = () => ({
  'Content-Type': 'application/json',
  'apikey': API_KEY
});

const evolutionFetch = (url, options = {}) => fetchWithTimeout(url, options, EVOLUTION_TIMEOUT_MS);

const getWebhookHeaders = () => {
  if (!WEBHOOK_SECRET || WEBHOOK_SECRET.length < 32) {
    throw new Error('WHATSAPP_WEBHOOK_SECRET no está configurado o es demasiado corto');
  }

  return {
    'X-Syncademia-Webhook-Secret': WEBHOOK_SECRET,
  };
};

const parseResponse = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (_error) {
    console.error(`❌ Evolution API devolvió una respuesta no válida (HTTP ${response.status}).`);
    throw new Error(`Servidor de WhatsApp respondió con error HTTP ${response.status}.`);
  }
};

const extractGroupJid = (data) => {
  const candidates = [
    data?.id,
    data?.groupJid,
    data?.group?.id,
    data?.group?.groupJid,
    data?.group?.gid,
    data?.data?.id,
    data?.data?.groupJid,
    data?.data?.group?.id,
  ];
  return candidates.map((value) => String(value || '').trim()).find((value) => value.includes('@g.us')) || null;
};

const configurarWebhook = async (academiaId) => {
  if (!EVOLUTION_URL) return;

  const instanceName = `academia_${academiaId}`;
  const webhookUrl = `${BACKEND_URL}/api/whatsapp-bridge/webhook/${academiaId}`;
  const webhookHeaders = getWebhookHeaders();

  try {
    const response = await evolutionFetch(`${EVOLUTION_URL}/webhook/set/${instanceName}`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: webhookUrl,
          byEvents: false,
          base64: false,
          events: WHATSAPP_EVENTS,
          headers: webhookHeaders,
        }
      })
    });

    if (response.ok) {
      console.log('🔗 Webhook omnicanal de WhatsApp configurado con éxito.');
    } else {
      console.warn(`⚠️ No se pudo configurar un webhook de WhatsApp (HTTP ${response.status}).`);
    }
  } catch (error) {
    console.error('❌ Error configurando webhook de WhatsApp:', error?.message || 'Error desconocido');
    throw error;
  }
};

const conectarAcademia = async (academiaId) => {
  if (!EVOLUTION_URL) {
    throw new Error('EVOLUTION_API_URL no está configurada');
  }

  const instanceName = `academia_${academiaId}`;

  try {
    await configurarWebhook(academiaId);

    const stateResponse = await evolutionFetch(`${EVOLUTION_URL}/instance/connectionState/${instanceName}`, {
      headers: getHeaders()
    });

    if (stateResponse.status === 404) {
      const createResponse = await evolutionFetch(`${EVOLUTION_URL}/instance/create`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          instanceName,
          qrcode: true,
          integration: 'WHATSAPP-BAILEYS',
          webhook: {
            enabled: true,
            url: `${BACKEND_URL}/api/whatsapp-bridge/webhook/${academiaId}`,
            byEvents: false,
            base64: false,
            events: WHATSAPP_EVENTS,
            headers: getWebhookHeaders(),
          }
        })
      });
      return await parseResponse(createResponse);
    }

    const connectResponse = await evolutionFetch(`${EVOLUTION_URL}/instance/connect/${instanceName}`, {
      method: 'GET',
      headers: getHeaders()
    });

    return await parseResponse(connectResponse);
  } catch (error) {
    console.error('❌ Error al conectar una instancia de WhatsApp:', error?.message || 'Error desconocido');
    throw error;
  }
};

const enviarMensaje = async (academiaId, numero, mensaje) => {
  if (!EVOLUTION_URL) {
    throw new Error('EVOLUTION_API_URL no está configurada');
  }

  const instanceName = `academia_${academiaId}`;

  try {
    const response = await evolutionFetch(`${EVOLUTION_URL}/message/sendText/${instanceName}`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        number: numero,
        text: mensaje
      })
    });

    const data = await parseResponse(response);

    if (!response.ok) {
      throw new Error(data.message || 'Error al enviar el mensaje');
    }

    return data;
  } catch (error) {
    console.error('❌ Error enviando un mensaje de WhatsApp:', error?.message || 'Error desconocido');
    throw error;
  }
};

const crearGrupo = async (academiaId, { subject, description = '', participants = [] }) => {
  if (!EVOLUTION_URL) throw new Error('EVOLUTION_API_URL no está configurada');
  const instanceName = `academia_${academiaId}`;
  const cleanParticipants = [...new Set((participants || []).map((value) => String(value || '').replace(/\D/g, '')).filter((value) => value.length >= 8))];
  if (!subject || cleanParticipants.length === 0) throw new Error('El grupo necesita un nombre y al menos un participante válido.');

  const response = await evolutionFetch(`${EVOLUTION_URL}/group/create/${instanceName}`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      subject: String(subject).trim().slice(0, 100),
      description: String(description || '').trim().slice(0, 500),
      participants: cleanParticipants,
    }),
  });
  const data = await parseResponse(response);
  if (!response.ok) throw new Error(data?.message || 'No fue posible crear el grupo de WhatsApp.');
  return { data, groupJid: extractGroupJid(data), participants: cleanParticipants };
};

const actualizarParticipantesGrupo = async (academiaId, groupJid, action, participants = []) => {
  if (!EVOLUTION_URL) throw new Error('EVOLUTION_API_URL no está configurada');
  const instanceName = `academia_${academiaId}`;
  const cleanParticipants = [...new Set((participants || []).map((value) => String(value || '').replace(/\D/g, '')).filter((value) => value.length >= 8))];
  if (!groupJid || cleanParticipants.length === 0) return { success: true, skipped: true };
  if (!['add', 'remove', 'promote', 'demote'].includes(action)) throw new Error('Acción de grupo no válida.');

  const response = await evolutionFetch(`${EVOLUTION_URL}/group/updateParticipant/${instanceName}`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ groupJid, action, participants: cleanParticipants }),
  });
  const data = await parseResponse(response);
  if (!response.ok) throw new Error(data?.message || 'No fue posible actualizar los participantes del grupo.');
  return data;
};

const obtenerParticipantesGrupo = async (academiaId, groupJid) => {
  if (!EVOLUTION_URL) throw new Error('EVOLUTION_API_URL no está configurada');
  const instanceName = `academia_${academiaId}`;
  const response = await evolutionFetch(`${EVOLUTION_URL}/group/participants/${instanceName}?groupJid=${encodeURIComponent(groupJid)}`, {
    method: 'GET', headers: getHeaders(),
  });
  const data = await parseResponse(response);
  if (!response.ok) throw new Error(data?.message || 'No fue posible consultar los participantes del grupo.');
  return data?.participants || data?.data?.participants || [];
};

const enviarMensajeGrupo = async (academiaId, groupJid, mensaje) => enviarMensaje(academiaId, groupJid, mensaje);

const sincronizarWebhooksActivos = async () => {
  if (!EVOLUTION_URL || !API_KEY || !WEBHOOK_SECRET) {
    console.warn('⚠️ Sincronización automática de webhooks omitida: configuración incompleta.');
    return;
  }

  try {
    const { data: academias, error } = await supabase
      .from('academias')
      .select('id')
      .eq('estado', 'Activa');

    if (error) throw error;

    for (const academia of academias || []) {
      await configurarWebhook(academia.id);
    }

    console.log(`🔐 Webhooks omnicanal sincronizados para ${(academias || []).length} academia(s) activa(s).`);
  } catch (error) {
    console.error('❌ No fue posible sincronizar los webhooks seguros al iniciar:', error?.message || 'Error desconocido');
  }
};

setImmediate(() => {
  void sincronizarWebhooksActivos();
});

module.exports = {
  conectarAcademia,
  enviarMensaje,
  configurarWebhook,
  crearGrupo,
  actualizarParticipantesGrupo,
  obtenerParticipantesGrupo,
  enviarMensajeGrupo,
};
