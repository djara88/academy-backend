// services/whatsappService.js

const EVOLUTION_URL = process.env.EVOLUTION_API_URL ? process.env.EVOLUTION_API_URL.replace(/\/$/, '') : '';
const API_KEY = process.env.EVOLUTION_API_KEY;

const getHeaders = () => ({
  'Content-Type': 'application/json',
  'apikey': API_KEY
});

const parseResponse = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`❌ Respuesta no válida de Evolution API (HTTP ${response.status}):`, text);
    throw new Error(`Servidor de WhatsApp respondió con error HTTP ${response.status}.`);
  }
};

// 1. Obtener estado o generar QR para una academia
const conectarAcademia = async (academiaId) => {
  if (!EVOLUTION_URL) {
    throw new Error('EVOLUTION_API_URL no está configurada en Render 1');
  }

  const instanceName = `academia_${academiaId}`;

  try {
    const stateResponse = await fetch(`${EVOLUTION_URL}/instance/connectionState/${instanceName}`, {
      headers: getHeaders()
    });

    // Si la instancia no existe (404), la creamos especificando la integración de Baileys
    if (stateResponse.status === 404) {
      const createResponse = await fetch(`${EVOLUTION_URL}/instance/create`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          instanceName: instanceName,
          qrcode: true,
          integration: 'WHATSAPP-BAILEYS' // 👈 OBLIGATORIO PARA EVOLUTION API V2
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

// 2. Enviar un mensaje
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

module.exports = {
  conectarAcademia,
  enviarMensaje
};
