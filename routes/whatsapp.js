// routes/whatsapp.js
const express = require('express');
const router = express.Router();
const { conectarAcademia, enviarMensaje } = require('../services/whatsappService');
const supabase = require('../config/supabase'); // 🔥 NECESARIO PARA LEER LA BASE DE DATOS

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
// 🤖 EL CEREBRO DEL BOT: ESCUCHA Y RESPONDE EN TIEMPO REAL
// ========================================================
router.post('/webhook/:academiaId', async (req, res) => {
  // 1. Respondemos 200 OK inmediatamente para que WhatsApp sepa que recibimos el mensaje y no lo reintente
  res.status(200).send('OK');

  try {
    const { academiaId } = req.params;
    const body = req.body;

    // 2. Validaciones: Que sea un mensaje real y NO enviado por nosotros mismos (el bot)
    if (!body.data || !body.data.key || body.data.key.fromMe) return;
    
    const remoteJid = body.data.key.remoteJid;
    if (!remoteJid || remoteJid.includes('@g.us')) return; // Ignoramos mensajes de grupos

    const messageData = body.data.message;
    if (!messageData) return;
    
    // Extraemos el texto que escribió la persona
    let text = messageData.conversation || messageData.extendedTextMessage?.text || '';
    text = text.trim();
    if (!text) return;

    // Limpiamos el número de teléfono (Evolution API manda "56912345678@s.whatsapp.net")
    const telefono = remoteJid.split('@')[0]; 

    // 3. Buscar en Supabase si este número está siendo invitado a un torneo activo
    const { data: participacion, error } = await supabase
      .from('torneo_participantes')
      .select('*, torneos(*)')
      .like('telefono_apoderado', `%${telefono.substring(2)}%`) // Busca coincidencia ignorando el 56 inicial
      .neq('paso_bot', 'FINALIZADO')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !participacion) return; // Si escribió alguien no convocado, el bot lo ignora.

    const torneo = participacion.torneos;
    let respuesta = '';
    let nuevoPaso = participacion.paso_bot;
    let updateData = {};

    // =========================================================
    // 🧠 MÁQUINA DE ESTADOS: ¿Qué hacemos con lo que respondió?
    // =========================================================
    
    // PASO 1: Le preguntamos si quería ir (Espera 1 o 2)
    if (participacion.paso_bot === 'ESPERANDO_PARTICIPACION') {
      if (text === '1') {
        updateData.respuesta_participacion = 'Si';
        
        if (torneo.permite_cuotas && torneo.costo_inscripcion > 0) {
          nuevoPaso = 'ESPERANDO_CUOTAS';
          respuesta = `¡Excelente! 🎉 Has confirmado asistencia.\n\nEl valor del torneo es de $${torneo.costo_inscripcion}.\n\n¿En cuántas cuotas deseas pagarlo?\nResponde con un número del *1* al *${torneo.max_cuotas}*.`;
        } else if (torneo.costo_inscripcion > 0) {
          nuevoPaso = 'FINALIZADO'; // Después podemos poner ESPERANDO_PAGO
          respuesta = `¡Excelente! 🎉 Has confirmado asistencia.\n\nEl valor de inscripción es de $${torneo.costo_inscripcion}.\nPronto la academia te enviará los datos bancarios.`;
        } else {
          nuevoPaso = 'FINALIZADO';
          respuesta = `¡Excelente! 🎉 Has confirmado asistencia.\n\nEl torneo es gratuito. ¡Nos vemos en la cancha! ⚽`;
        }
      } else if (text === '2') {
        updateData.respuesta_participacion = 'No';
        nuevoPaso = 'FINALIZADO';
        respuesta = 'Entendido. 😔 Gracias por avisarnos. ¡Nos vemos en el próximo torneo!';
      } else {
        respuesta = '⚠️ *Respuesta no válida*.\nPor favor, responde *1* para Confirmar o *2* para Rechazar la invitación.';
      }
    } 
    
    // PASO 2: Le preguntamos cuántas cuotas quiere (Espera un número)
    else if (participacion.paso_bot === 'ESPERANDO_CUOTAS') {
      const cuotas = parseInt(text);
      if (isNaN(cuotas) || cuotas < 1 || cuotas > torneo.max_cuotas) {
        respuesta = `⚠️ Por favor, ingresa un número válido (entre 1 y ${torneo.max_cuotas}).`;
      } else {
        updateData.pago_en_cuotas = cuotas > 1;
        updateData.numero_cuotas = cuotas;
        nuevoPaso = 'FINALIZADO'; // Después podemos conectarlo con ESPERANDO_PAGO
        respuesta = `¡Perfecto! Has elegido pagar en *${cuotas} cuota(s)*. 💳\nPronto te enviaremos la información de recaudación de la academia. ¡Gracias!`;
      }
    }

    // 4. Guardamos la actualización en la Base de Datos
    updateData.paso_bot = nuevoPaso;
    await supabase
      .from('torneo_participantes')
      .update(updateData)
      .eq('id', participacion.id);

    // 5. Enviamos la respuesta de vuelta al apoderado
    if (respuesta) {
      await enviarMensaje(academiaId, telefono, respuesta);
    }

  } catch (err) {
    console.error('❌ Error en el webhook de WhatsApp:', err);
  }
});

module.exports = router;
