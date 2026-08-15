// services/whatsappService.js

const supabase = require('../config/supabase');

const EVOLUTION_URL = process.env.EVOLUTION_API_URL ? process.env.EVOLUTION_API_URL.replace(/\/$/, '') : '';
const API_KEY = process.env.EVOLUTION_API_KEY;
const WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET;
const BACKEND_URL = process.env.BACKEND_URL ? process.env.BACKEND_URL.replace(/\/$/, '') : 'https://academy-backend-kqsv.onrender.com';

const getHeaders = () => ({
  'Content-Type': 'application/json',
  'apikey': API_KEY
});

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
  } catch (e) {
    console.error(`❌ Respuesta no válida de Evolution API (HTTP ${response.status}):`, text);
    throw new Error(`Servidor de WhatsApp respondió con error HTTP ${response.status}.`);
  }
};

const configurarWebhook = async (academiaId) => {
  if (!EVOLUTION_URL) return;

  const instanceName = `academia_${academiaId}`;
  const webhookUrl = `${BACKEND_URL}/api/whatsapp/webhook/${academiaId}`;
  const webhookHeaders = getWebhookHeaders();

  try {
    const response = await fetch(`${EVOLUTION_URL}/webhook/set/${instanceName}`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: webhookUrl,
          byEvents: false,
          base64: false,
          events: ['MESSAGES_UPSERT'],
          headers: webhookHeaders,
        }
      })
    });

    const responseText = await response.text();

    if (response.ok) {
      console.log(`🔗 Webhook seguro configurado con éxito para ${instanceName}`);
    } else {
      console.warn(`⚠️ No se pudo configurar el webhook para ${instanceName} (HTTP ${response.status}): ${responseText}`);
    }
  } catch (error) {
    console.error(`❌ Error configurando webhook para ${instanceName}:`, error.message);
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

    const stateResponse = await fetch(`${EVOLUTION_URL}/instance/connectionState/${instanceName}`, {
      headers: getHeaders()
    });

    if (stateResponse.status === 404) {
      const createResponse = await fetch(`${EVOLUTION_URL}/instance/create`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          instanceName: instanceName,
          qrcode: true,
          integration: 'WHATSAPP-BAILEYS',
          webhook: {
            enabled: true,
            url: `${BACKEND_URL}/api/whatsapp/webhook/${academiaId}`,
            byEvents: false,
            base64: false,
            events: ['MESSAGES_UPSERT'],
            headers: getWebhookHeaders(),
          }
        })
      });
      return await parseResponse(createResponse);
    }

    const connectResponse = await fetch(`${EVOLUTION_URL}/instance/connect/${instanceName}`, {
      method: 'GET',
      headers: getHeaders()
    });
    
    return await parseResponse(connectResponse);
  } catch (error) {
    console.error(`❌ Error al conectar WhatsApp para academia ${academiaId}:`, error.message);
    throw error;
  }
};

const enviarMensaje = async (academiaId, numero, mensaje) => {
  if (!EVOLUTION_URL) {
    throw new Error('EVOLUTION_API_URL no está configurada');
  }

  const instanceName = `academia_${academiaId}`;

  try {
    const response = await fetch(`${EVOLUTION_URL}/message/sendText/${instanceName}`, {
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
    console.error(`❌ Error enviando mensaje (Academia ${academiaId}):`, error.message);
    throw error;
  }
};

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

    console.log(`🔐 Webhooks seguros sincronizados para ${(academias || []).length} academia(s) activa(s).`);
  } catch (error) {
    console.error('❌ No fue posible sincronizar los webhooks seguros al iniciar:', error.message);
  }
};

setImmediate(() => {
  void sincronizarWebhooksActivos();
});

module.exports = {
  conectarAcademia,
  enviarMensaje,
  configurarWebhook
};
