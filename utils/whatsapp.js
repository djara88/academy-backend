const supabase = require('../config/supabase');

const enviarWhatsApp = async (academia_id, telefonoDestino, mensaje) => {
  try {
    // 1. Buscar las credenciales de WhatsApp de esta academia en particular
    const { data: academia, error } = await supabase
      .from('academias')
      .select('wa_api_url, wa_api_token')
      .eq('id', academia_id)
      .single();

    if (error || !academia) throw new Error('Academia no encontrada.');

    // 2. Si la academia no ha configurado su WhatsApp, simplemente ignoramos el envío silenciosamente
    if (!academia.wa_api_url || !academia.wa_api_token) {
      console.log('⚠️ WhatsApp no configurado para esta academia. Se omite el envío.');
      return false;
    }

    // 3. Formatear el número (quitar símbolos y asegurar código de país, ej: 569...)
    const telefonoLimpio = telefonoDestino.replace(/\D/g, '');

    // 4. Disparar el mensaje a la API Externa (Ejemplo con estructura estándar)
    const url = `${academia.wa_api_url}/messages/chat`; // Esto variará levemente según el proveedor que elijamos
    const body = new URLSearchParams({
      token: academia.wa_api_token,
      to: telefonoLimpio,
      body: mensaje
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    if (!response.ok) throw new Error('Fallo al conectar con la API de WhatsApp');
    
    console.log(`✅ WhatsApp enviado con éxito al ${telefonoLimpio}`);
    return true;

  } catch (error) {
    console.error('❌ Error enviando WhatsApp:', error.message);
    return false;
  }
};

module.exports = { enviarWhatsApp };
