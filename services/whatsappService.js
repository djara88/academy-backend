// routes/whatsapp.js
const express = require('express');
const router = express.Router();
const { conectarAcademia, enviarMensaje } = require('../services/whatsappService');
const supabase = require('../config/supabase');

// Ruta para consultar estado / obtener QR
router.get('/estado/:academiaId', async (req, res) => {
  const { academiaId } = req.params;

  try {
    const data = await conectarAcademia(academiaId);
    
    if (data?.instance?.state === 'open' || data?.state === 'open') {
      return res.json({ conectado: true, mensaje: 'WhatsApp ya está conectado' });
    }

    if (data?.qrcode?.base64 || data?.base64) {
      return res.json({ 
        conectado: false, 
        qrCode: data.qrcode?.base64 || data.base64 
      });
    }

    res.json({ conectado: false, estado: 'Iniciando...', data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ruta para enviar mensaje
router.post('/enviar/:academiaId', async (req, res) => {
  const { academiaId } = req.params;
  const { numero, mensaje } = req.body;

  if (!numero || !mensaje) {
    return res.status(400).json({ error: 'Faltan el número o el mensaje' });
  }

  try {
    const resultado = await enviarMensaje(academiaId, numero, mensaje);
    res.json({ success: true, resultado });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================================
// 🤖 EL CEREBRO DEL BOT (ROBUSTO Y CON LOGS DIAGNÓSTICOS)
// ========================================================
router.post('/webhook/:academiaId', async (req, res) => {
  // Respondemos 200 OK inmediatamente a WhatsApp
  res.status(200).send('OK');

  try {
    const { academiaId } = req.params;
    const body = req.body;

    console.log(`📩 [WEBHOOK RECIBIDO] Academia: ${academiaId}`);

    // Extraemos la información sin importar si viene en body.data o body
    const payload = body.data || body;
    if (!payload || !payload.key) {
      console.log('ℹ️ Ignorado: El evento no contiene llave de mensaje (key).');
      return;
    }

    if (payload.key.fromMe) {
      console.log('ℹ️ Ignorado: Es un mensaje enviado por la propia academia.');
      return;
    }

    const remoteJid = payload.key.remoteJid || '';
    if (!remoteJid || remoteJid.includes('@g.us')) {
      console.log('ℹ️ Ignorado: Es un mensaje de grupo.');
      return;
    }

    const messageData = payload.message;
    if (!messageData) return;

    let text = messageData.conversation || 
               messageData.extendedTextMessage?.text || 
               messageData.buttonsResponseMessage?.selectedButtonId || '';
    
    text = text.trim();
    if (!text) return;

    // Limpieza de número de teléfono: "56940054804@s.whatsapp.net" -> "56940054804"
    const telefonoCompleto = remoteJid.split('@')[0].replace(/\D/g, '');
    const ultimos8Digitos = telefonoCompleto.slice(-8); // Búsqueda flexible por los últimos 8 dígitos

    console.log(`💬 Mensaje recibido de ${telefonoCompleto}: "${text}" (Buscando coincidencia: %${ultimos8Digitos})`);

    // Buscar en Supabase
    const { data: participaciones, error } = await supabase
      .from('torneo_participantes')
      .select('*, torneos(*)')
      .like('telefono_apoderado', `%${ultimos8Digitos}%`)
      .neq('paso_bot', 'FINALIZADO')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('❌ Error buscando convocatoria en DB:', error);
      return;
    }

    if (!participaciones || participaciones.length === 0) {
      console.log(`⚠️ No hay convocatorias pendientes en DB para el número con final %${ultimos8Digitos}`);
      return;
    }

    const participacion = participaciones[0];
    const torneo = participacion.torneos;
    let respuesta = '';
    let nuevoPaso = participacion.paso_bot;
    let updateData = {};

    console.log(`🎯 Convocatoria encontrada ID: ${participacion.id} | Torneo: "${torneo?.nombre}" | Paso: ${participacion.paso_bot}`);

    // -------------------------------------------------------------
    // MÁQUINA DE ESTADOS DEL BOT
    // -------------------------------------------------------------
    if (participacion.paso_bot === 'ESPERANDO_PARTICIPACION') {
      if (text === '1') {
        updateData.respuesta_participacion = 'Si';
        
        if (torneo.permite_cuotas && torneo.costo_inscripcion > 0) {
          nuevoPaso = 'ESPERANDO_CUOTAS';
          const costo = Number(torneo.costo_inscripcion).toLocaleString('es-CL');
          respuesta = `¡Excelente! 🎉 Has confirmado asistencia para *${torneo.nombre}*.\n\n` +
                      `💰 Valor inscripción: $${costo}\n\n` +
                      `¿En cuántas cuotas deseas pagarlo?\n` +
                      `Responde con un número del *1* al *${torneo.max_cuotas}*.`;
        } else if (torneo.costo_inscripcion > 0) {
          nuevoPaso = 'FINALIZADO';
          const costo = Number(torneo.costo_inscripcion).toLocaleString('es-CL');
          respuesta = `¡Excelente! 🎉 Has confirmado asistencia para *${torneo.nombre}*.\n\n` +
                      `💰 Valor inscripción: $${costo}\n` +
                      `Pronto la academia te compartirá los datos para el pago.`;
        } else {
          nuevoPaso = 'FINALIZADO';
          respuesta = `¡Excelente! 🎉 Has confirmado asistencia para *${torneo.nombre}*.\n\n` +
                      `El torneo es gratuito. ¡Nos vemos en la cancha! ⚽`;
        }
      } else if (text === '2') {
        updateData.respuesta_participacion = 'No';
        nuevoPaso = 'FINALIZADO';
        respuesta = 'Entendido. 😔 Gracias por responder. ¡Nos vemos en el próximo torneo!';
      } else {
        respuesta = '⚠️ *Respuesta no válida*.\nPor favor responde *1* para Confirmar o *2* para Rechazar la invitación.';
      }
    } 
    else if (participacion.paso_bot === 'ESPERANDO_CUOTAS') {
      const cuotas = parseInt(text, 10);
      if (isNaN(cuotas) || cuotas < 1 || cuotas > torneo.max_cuotas) {
        respuesta = `⚠️ Por favor ingresa un número válido de cuotas (entre 1 y ${torneo.max_cuotas}).`;
      } else {
        updateData.pago_en_cuotas = cuotas > 1;
        updateData.numero_cuotas = cuotas;
        nuevoPaso = 'FINALIZADO';
        respuesta = `¡Perfecto! Has registrado la participación en *${cuotas} cuota(s)*. 💳\n` +
                    `Pronto la academia te enviará los detalles de pago. ¡Gracias!`;
      }
    }

    // Actualizar Base de Datos
    updateData.paso_bot = nuevoPaso;
    const { error: errUpdate } = await supabase
      .from('torneo_participantes')
      .update(updateData)
      .eq('id', participacion.id);

    if (errUpdate) {
      console.error('❌ Error al actualizar respuesta en DB:', errUpdate);
    } else {
      console.log(`✅ Registro actualizado con éxito: paso_bot=${nuevoPaso}, respuesta=${updateData.respuesta_participacion || 'Cuotas'}`);
    }

    // Responder por WhatsApp
    if (respuesta) {
      await enviarMensaje(academiaId, telefonoCompleto, respuesta);
      console.log(`💬 Respuesta automática enviada a ${telefonoCompleto}`);
    }

  } catch (err) {
    console.error('❌ Error crítico en Webhook:', err);
  }
});

module.exports = router;
