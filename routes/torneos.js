// routes/torneos.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const axios = require('axios'); // Para conectar con la API de WhatsApp

// CREAR un nuevo torneo
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { nombre, fecha_inicio, fecha_fin, costo_inscripcion, permite_cuotas, max_cuotas } = req.body;

    const { data, error } = await supabase
      .from('torneos')
      .insert([{
        academia_id,
        nombre,
        fecha_inicio,
        fecha_fin,
        costo_inscripcion: costo_inscripcion || 0,
        permite_cuotas: permite_cuotas || false,
        max_cuotas: permite_cuotas ? (max_cuotas || 2) : 1
      }])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al crear torneo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// OBTENER todos los torneos de la academia
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { data, error } = await supabase
      .from('torneos')
      .select('*')
      .eq('academia_id', academia_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al obtener torneos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// OBTENER un torneo específico por su ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('torneos')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al obtener el torneo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// OBTENER los participantes ya convocados a un torneo
router.get('/:id/participantes', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('torneo_participantes')
      .select('*, jugadores(nombre, foto_base64)')
      .eq('torneo_id', req.params.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al obtener participantes:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🔥 ENVIAR CONVOCATORIA MASIVA POR CATEGORÍA CON DISPARO REAL DE WHATSAPP
router.post('/:id/convocar', authMiddleware, async (req, res) => {
  try {
    const torneo_id = req.params.id;
    const { jugadoresIds } = req.body;

    if (!jugadoresIds || jugadoresIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No hay jugadores para convocar.' });
    }

    // 1. Obtener detalles del Torneo
    const { data: torneo, error: errTorneo } = await supabase
      .from('torneos')
      .select('*')
      .eq('id', torneo_id)
      .single();

    if (errTorneo || !torneo) throw new Error('No se encontró la información del torneo.');

    // 2. Obtener datos de los jugadores y sus tutores
    const { data: jugadores, error: errJugadores } = await supabase
      .from('jugadores')
      .select('*, tutores(*)')
      .in('id', jugadoresIds);

    if (errJugadores) throw errJugadores;

    // 3. Registrar en la base de datos los convocados
    const convocatorias = jugadores.map(j => {
      // Obtenemos el teléfono del tutor o del jugador
      const telefono = j.tutores?.telefono || j.telefono || '';
      return {
        torneo_id,
        jugador_id: j.id,
        telefono_apoderado: telefono,
        respuesta_participacion: 'Pendiente',
        paso_bot: 'ESPERANDO_PARTICIPACION',
        estado_pago: 'Pendiente'
      };
    });

    const { error: errUpsert } = await supabase
      .from('torneo_participantes')
      .upsert(convocatorias, { onConflict: 'torneo_id, jugador_id', ignoreDuplicates: true });

    if (errUpsert) throw errUpsert;

    // 4. 🔥 DISPARAR MENSAJES DE WHATSAPP REALES
    const costoFormateado = torneo.costo_inscripcion > 0 
      ? `$${Number(torneo.costo_inscripcion).toLocaleString('es-CL')}` 
      : 'Gratuito';

    for (const jugador of jugadores) {
      const telefono = jugador.tutores?.telefono || jugador.telefono;
      
      if (!telefono) {
        console.warn(`⚠️ Jugador ${jugador.nombre} no tiene teléfono registrado.`);
        continue;
      }

      // Limpiamos el número para asegurar formato internacional (+56)
      let numLimpio = telefono.replace(/\D/g, '');
      if (!numLimpio.startsWith('56') && numLimpio.length === 9) {
        numLimpio = '56' + numLimpio;
      }

      // Mensaje estructurado para el Bot
      const mensajeTexto = `🏆 *CONVOCATORIA A TORNEO*\n\n` +
        `Hola! Nos comunicamos de la academia.\n` +
        `*${jugador.nombre}* ha sido convocado/a para participar en:\n` +
        `⚽ *${torneo.nombre}*\n\n` +
        `💰 *Valor inscripción:* ${costoFormateado}\n` +
        (torneo.permite_cuotas ? `💳 *Opción de pago:* Hasta ${torneo.max_cuotas} cuotas.\n\n` : `\n`) +
        `Por favor responde a este mensaje:\n` +
        `1️⃣ Para *CONFIRMAR* asistencia.\n` +
        `2️⃣ Para *RECHAZAR* la invitación.`;

      // Envío a través de la ruta de WhatsApp interna
      try {
        await axios.post(`http://localhost:${process.env.PORT || 8080}/api/whatsapp/enviar`, {
          number: numLimpio,
          message: mensajeTexto
        });
        console.log(`✅ WhatsApp de convocatoria enviado a ${jugador.nombre} (${numLimpio})`);
      } catch (errApi) {
        console.error(`❌ Error al enviar WhatsApp a ${jugador.nombre}:`, errApi.message);
      }
    }

    res.json({ success: true, message: 'Convocatorias guardadas y mensajes enviados por WhatsApp.' });
  } catch (error) {
    console.error('❌ Error al convocar:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
