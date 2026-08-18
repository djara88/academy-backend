// routes/whatsapp.js
const express = require('express');
const router = express.Router();
const whatsappService = require('../services/whatsappService');
const supabase = require('../config/supabase');
const { academyMessage, getAcademyName } = require('../services/academyIdentity');
const authMiddleware = require('../middleware/auth');
const { requireAcademyParamAccess } = require('../middleware/academyAccess');
const { requireWebhookSecret } = require('../middleware/webhookAuth');

// Destructuración segura desde el objeto importado para evitar dependencias circulares
const { conectarAcademia, enviarMensaje } = whatsappService;

const requireAcademyAccess = requireAcademyParamAccess('academiaId');

// ========================================================
// 1. CONSULTAR ESTADO / OBTENER QR
// ========================================================
router.get('/estado/:academiaId', authMiddleware, requireAcademyAccess, async (req, res) => {
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
router.post('/enviar/:academiaId', authMiddleware, requireAcademyAccess, async (req, res) => {
  const { academiaId } = req.params;
  const { numero, mensaje } = req.body;

  if (!numero || !mensaje) {
    return res.status(400).json({ error: 'Faltan el número o el mensaje' });
  }

  try {
    const academyName = await getAcademyName(academiaId);
    const resultado = await enviarMensaje(academiaId, numero, academyMessage(academyName, mensaje));
    res.json({ success: true, resultado });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================================
// 🤖 3. EL CEREBRO DEL BOT: ESCUCHA Y RESPONDE EN TIEMPO REAL
// ========================================================
router.post('/webhook/:academiaId', requireWebhookSecret, async (req, res) => {
  // Solo respondemos 200 después de autenticar el webhook.
  res.status(200).send('OK');

  try {
    const { academiaId } = req.params;
    const academyName = await getAcademyName(academiaId);
    const body = req.body;

    console.log('📩 Webhook de WhatsApp autenticado.');

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

    console.log('💬 Mensaje de WhatsApp recibido y validado.');

    // =========================================================
    // ⚽ BLOQUE A: COMPROBAR CITACIONES DE PARTIDOS PRIMERO
    // =========================================================
    const { data: citaciones, error: errCitacion } = await supabase
      .from('partido_citaciones')
      .select('*, partidos!inner(*)')
      .eq('partidos.academia_id', academiaId)
      .like('telefono_apoderado', `%${ultimos8Digitos}%`)
      .neq('paso_bot', 'FINALIZADO')
      .order('created_at', { ascending: false });

    if (!errCitacion && citaciones && citaciones.length > 0) {
      const citacion = citaciones[0];
      const partido = citacion.partidos;

      if (String(partido?.academia_id || '') !== String(academiaId)) {
        console.warn('Webhook bloqueado: la citación no pertenece a la academia indicada.');
        return;
      }

      let respuestaPart = '';
      let nuevoPasoPart = citacion.paso_bot;
      let updateDataPart = {};

      console.log('🎯 Citación de partido encontrada dentro de la academia autorizada.');

      if (citacion.paso_bot === 'ESPERANDO_CITACION') {
        if (text === '1') {
          updateDataPart.respuesta = 'Si';
          nuevoPasoPart = 'FINALIZADO';
          
          const arbitrajeStr = partido?.cobra_arbitraje 
            ? `\n⚖️ Recuerda llevar $${Number(partido.monto_arbitraje_jugador).toLocaleString('es-CL')} para la cuota de arbitraje en cancha.` 
            : '';

          respuestaPart = `¡Excelente! 🎉 Has confirmado asistencia para el partido vs *${partido?.rival || 'el rival'}*.${arbitrajeStr}\n\n¡Nos vemos en la cancha! ⚽`;
        } else if (text === '2') {
          updateDataPart.respuesta = 'No';
          nuevoPasoPart = 'ESPERANDO_MOTIVO';
          
          respuestaPart = `Entendido. 😔 Por favor indica el número del motivo de la ausencia para informar al cuerpo técnico:\n\n` +
                          `1️⃣ Enfermedad / Lesión 🏥\n` +
                          `2️⃣ Compromisos familiares 👨‍👩‍👧\n` +
                          `3️⃣ Estudios / Colegio 📚\n` +
                          `4️⃣ Otro motivo ⚽`;
        } else {
          respuestaPart = '⚠️ *Respuesta no válida*.\nPor favor responde *1* para Confirmar o *2* para Informar Ausencia.';
        }
      } 
      else if (citacion.paso_bot === 'ESPERANDO_MOTIVO') {
        const mapaMotivos = {
          '1': 'Enfermedad / Lesión 🏥',
          '2': 'Compromisos familiares 👨‍👩‍👧',
          '3': 'Estudios / Colegio 📚',
          '4': 'Otro motivo ⚽'
        };

        if (mapaMotivos[text]) {
          updateDataPart.motivo_ausencia = mapaMotivos[text];
          nuevoPasoPart = 'FINALIZADO';
          respuestaPart = `Gracias por avisarnos. Registramos el motivo: *${mapaMotivos[text]}*.\n¡Que todo salga bien y nos vemos en la próxima fecha!`;
        } else {
          respuestaPart = '⚠️ Por favor responde con un número del 1 al 4 para registrar el motivo de la inasistencia.';
        }
      }

      updateDataPart.paso_bot = nuevoPasoPart;
      const { error: errUpdateCit } = await supabase
        .from('partido_citaciones')
        .update(updateDataPart)
        .eq('id', citacion.id)
        .eq('partido_id', citacion.partido_id);

      if (errUpdateCit) {
        console.error('❌ Error actualizando la citación en BD:', errUpdateCit);
      } else {
        console.log(`✅ Citación actualizada en BD -> paso_bot: ${nuevoPasoPart}`);
      }

      if (respuestaPart) {
        await enviarMensaje(academiaId, telefonoLimpio, academyMessage(academyName, respuestaPart));
        console.log('💬 Respuesta de citación enviada.');
      }

      return; // Finalizamos aquí para no entrar al flujo de Torneos
    }

    // =========================================================
    // 🏆 BLOQUE B: CONVOCATORIAS DE TORNEOS
    // =========================================================
    const { data: participaciones, error } = await supabase
      .from('torneo_participantes')
      .select('*, torneos!inner(*)')
      .eq('torneos.academia_id', academiaId)
      .like('telefono_apoderado', `%${ultimos8Digitos}%`)
      .in('paso_bot', ['ESPERANDO_PARTICIPACION', 'ESPERANDO_CUOTAS'])
      .order('created_at', { ascending: false });

    if (error) {
      console.error('❌ Error consultando convocatorias en BD:', error);
      return;
    }

    if (!participaciones || participaciones.length === 0) {
      console.log('ℹ️ No hay convocatorias ni citaciones pendientes para el mensaje recibido.');
      return;
    }

    const participacion = participaciones[0];
    const torneo = participacion.torneos;

    if (String(torneo?.academia_id || '') !== String(academiaId)) {
      console.warn('Webhook bloqueado: la convocatoria no pertenece a la academia indicada.');
      return;
    }

    let respuesta = '';
    let nuevoPaso = participacion.paso_bot;
    let updateData = {};

    console.log('🎯 Convocatoria encontrada dentro de la academia autorizada.');

    // MÁQUINA DE ESTADOS TORNEOS
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
                      `Pronto ${academyName} te enviará los datos para la transferencia.`;
        } else {
          nuevoPaso = 'FINALIZADO';
          respuesta = `¡Excelente! 🎉 Has confirmado asistencia para *${torneo.nombre}*.\n\n` +
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
                    `Pronto ${academyName} te enviará los detalles de cobro. ¡Gracias!`;
      }
    }

    // La decisión y las cuotas pertenecen al jugador dentro del torneo, no a una categoría aislada.
    // Sincronizamos todas sus categorías y dejamos, como máximo, una fila interactiva pendiente.
    const changed = Object.keys(updateData).length > 0 || nuevoPaso !== participacion.paso_bot;
    let errUpdate = null;
    if (changed) {
      if (nuevoPaso === 'ESPERANDO_CUOTAS') {
        const { error: groupError } = await supabase
          .from('torneo_participantes')
          .update({ ...updateData, paso_bot: 'FINALIZADO' })
          .eq('torneo_id', participacion.torneo_id)
          .eq('jugador_id', participacion.jugador_id);
        errUpdate = groupError;
        if (!errUpdate) {
          const { error: primaryError } = await supabase
            .from('torneo_participantes')
            .update({ ...updateData, paso_bot: 'ESPERANDO_CUOTAS' })
            .eq('id', participacion.id)
            .eq('torneo_id', participacion.torneo_id);
          errUpdate = primaryError;
        }
      } else {
        const { error: groupError } = await supabase
          .from('torneo_participantes')
          .update({ ...updateData, paso_bot: nuevoPaso })
          .eq('torneo_id', participacion.torneo_id)
          .eq('jugador_id', participacion.jugador_id);
        errUpdate = groupError;
      }
    }

    if (errUpdate) {
      console.error('❌ Error actualizando la convocatoria en BD:', errUpdate);
    } else if (changed) {
      console.log(`✅ Convocatoria sincronizada para todas las categorías -> paso_bot: ${nuevoPaso}`);
    }

    // Envío del mensaje de respuesta automática
    if (respuesta) {
      await enviarMensaje(academiaId, telefonoLimpio, academyMessage(academyName, respuesta));
      console.log('💬 Respuesta automática de WhatsApp enviada con éxito.');
    }

  } catch (err) {
    console.error('❌ Error procesando webhook de WhatsApp:', err?.message || 'Error desconocido');
  }
});

module.exports = router;
