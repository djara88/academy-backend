// services/whatsappService.js

const EVOLUTION_URL = process.env.EVOLUTION_API_URL;
const API_KEY = process.env.EVOLUTION_API_KEY;

const getHeaders = () => ({
  'Content-Type': 'application/json',
  'apikey': API_KEY
});

// 1. Obtener estado o generar QR para una academia
const conectarAcademia = async (academiaId) => {
  const instanceName = `academia_${academiaId}`;

  try {
    const stateResponse = await fetch(`${EVOLUTION_URL}/instance/connectionState/${instanceName}`, {
      headers: getHeaders()
    });

    if (stateResponse.status === 404) {
      const createResponse = await fetch(`${EVOLUTION_URL}/instance/create`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          instanceName: instanceName,
          qrcode: true
        })
      });
      return await createResponse.json();
    }

    const connectResponse = await fetch(`${EVOLUTION_URL}/instance/connect/${instanceName}`, {
      method: 'GET',
      headers: getHeaders()
    });
    
    return await connectResponse.json();
  } catch (error) {
    console.error(`❌ Error al conectar WhatsApp para academia ${academiaId}:`, error);
    throw new Error('No se pudo comunicar con el servidor de WhatsApp');
  }
};

// 2. Enviar un mensaje
const enviarMensaje = async (academiaId, numero, mensaje) => {
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

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Error al enviar el mensaje');
    }

    return await response.json();
  } catch (error) {
    console.error(`❌ Error enviando mensaje (Academia ${academiaId}):`, error);
    throw error;
  }
};

module.exports = {
  conectarAcademia,
  enviarMensaje
};
