// routes/whatsapp.js
const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsappService');
const supabase = require('../config/supabase');

// Destructuración segura desde el objeto importado para evitar dependencias circulares
const { conectarAcademia, enviarMensaje } = whatsappService;

// ========================================================
// 1. CONSULTAR ESTADO / OBTENER QR
// ========================================================
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

// ========================================================
// 2. ENVIAR MENSAJE INDIVIDUAL
// ========================================================
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
// 🤖 3. EL CEREBRO DEL BOT: ESCUCHA Y RESPONDE EN TIEMPO REAL
// ========================================================
router.post('/webhook/:academiaId', async (req, res) => {
  // Respondemos 200 OK de inmediato a WhatsApp
  res.status(200).send('OK');

  try {
    const { academiaId } = req.params;
    const body = req.body;

    console.log(`📩 [WEBHOOK RECIBIDO] Academia: ${academiaId}`);

    // Tolerancia a múltiples formatos de payload de Evolution API (v1 y v2)
    const payload = body.data || body;
    if (!payload || !payload.key) {
      console.log('ℹ️ Evento ignorado: No contiene estructura de clave (key).');
      return;
    }

    if (payload.key.fromMe) {
      console.log('ℹ️ Evento ignorado: Mensaje saliente enviado por la propia academia.');
      return;
    }

    const remoteJid = payload.key.remoteJid || '';
    if (!remoteJid || remoteJid.includes('@g.us')) {
      console.log('ℹ️ Evento ignorado: Mensaje proveniente de un grupo.');
      return;
    }

    const messageData = payload.message;
    if (!messageData) return;

    // Extracción multiformato del mensaje enviado por el usuario
    let text = messageData.conversation || 
               messageData.extendedTextMessage?.text || 
               messageData.buttonsResponseMessage?.selectedButtonId ||
               messageData.listResponseMessage?.singleSelectReply?.selectedRowId || '';
    
    text = text.trim();
    if (!text) {
      console.log('ℹ️ Mensaje sin contenido de texto procesable.');
      return;
    }

    // Extraemos los números limpios para la coincidencia en BD
    const telefonoLimpio = remoteJid.split('@')[0].replace(/\D/g, '');
    const ultimos8Digitos = telefonoLimpio.slice(-8);

    console.log(`💬 Mensaje de ${telefonoLimpio}: "${text}" (Buscando coincidencia con %${ultimos8Digitos})`);

    // Consulta flexible en Supabase (Array de resultados para evitar caídas por .single())
    const { data: participaciones, error } = await supabase
      .from('torneo_participantes')
      .select('*, torneos(*)')
      .like('telefono_apoderado', `%${ultimos8Digitos}%`)
      .neq('paso_bot', 'FINALIZADO')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('❌ Error consultando convocatorias en BD:', error);
      return;
    }

    if (!participaciones || participaciones.length === 0) {
      console.log(`⚠️ No hay convocatorias pendientes para el número finalizado en %${ultimos8Digitos}`);
      return;
    }

    const participacion = participaciones[0];
    const torneo = participacion.torneos;
    let respuesta = '';
    let nuevoPaso = participacion.paso_bot;
    let updateData = {};

    console.log(`🎯 Convocatoria hallada (ID: ${participacion.id}) | Torneo: "${torneo?.nombre}" | Paso actual: ${participacion.paso_bot}`);

    // =========================================================
    // 🧠 MÁQUINA DE ESTADOS
    // =========================================================
    if (participacion.paso_bot === 'ESPERANDO_PARTICIPACION') {
      if (text === '1') {
        updateData.respuesta_participacion = 'Si';
        
        if (torneo.permite_cuotas && torneo.costo_inscripcion > 0) {
          nuevoPaso = 'ESPERANDO_CUOTAS';
          const costoStr = Number(torneo.costo_inscripcion).toLocaleString('es-CL');
          respuesta = `¡Excelente! 🎉 Has confirmado asistencia para *${torneo.nombre}*.\n\n` +
                      `💰 Valor inscripción: $${costoStr}\n\n` +
                      `¿En cuántas cuotas deseas pagarlo?\n` +
                      `Responde con un número del *1* al *${torneo.max_cuotas}*.`;
        } else if (torneo.costo_inscripcion > 0) {
          nuevoPaso = 'FINALIZADO';
          const costoStr = Number(torneo.costo_inscripcion).toLocaleString('es-CL');
          respuesta = `¡Excelente! 🎉 Has confirmado asistencia para *${torneo.nombre}*.\n\n` +
                      `💰 Valor inscripción: $${costoStr}\n` +
                      `Pronto la academia te enviará los datos para la transferencia.`;
        } else {
          nuevoPaso = 'FINALIZADO';
          respuesta = `¡Excelente! 🎉 Has confirmed asistencia para *${torneo.nombre}*.\n\n` +
                      `El torneo es gratuito. ¡Nos vemos en la cancha! ⚽`;
        }
      } else if (text === '2') {
        updateData.respuesta_participacion = 'No';
        nuevoPaso = 'FINALIZADO';
        respuesta = 'Entendido. 😔 Gracias por responder. ¡Nos vemos en la próxima oportunidad!';
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
        respuesta = `¡Perfecto! Registramos la participación en *${cuotas} cuota(s)*. 💳\n` +
                    `Pronto la academia te enviará los detalles de cobro. ¡Gracias!`;
      }
    }

    // Actualización de estado en Supabase
    updateData.paso_bot = nuevoPaso;
    const { error: errUpdate } = await supabase
      .from('torneo_participantes')
      .update(updateData)
      .eq('id', participacion.id);

    if (errUpdate) {
      console.error('❌ Error actualizando la convocatoria en BD:', errUpdate);
    } else {
      console.log(`✅ Convocatoria actualizada en BD -> paso_bot: ${nuevoPaso}, respuesta: ${updateData.respuesta_participacion || 'Cuotas seleccionadas'}`);
    }

    // Envío del mensaje de respuesta automática
    if (respuesta) {
      await enviarMensaje(academiaId, telefonoLimpio, respuesta);
      console.log(`💬 Respuesta automática enviada con éxito a ${telefonoLimpio}`);
    }

  } catch (err) {
    console.error('❌ Error crítico procesando webhook:', err);
  }
});

module.exports = router;
