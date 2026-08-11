// routes/torneos.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarMensaje } = require('../services/whatsappService');

// 1. CREAR TORNEO + EGRESO ORGANIZACIÓN (SI APLICA)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { 
      nombre, fecha_inicio, fecha_fin, costo_inscripcion, permite_cuotas, max_cuotas,
      costo_organizacion // Opcional: gasto que paga la academia por participar
    } = req.body;

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

    // 🔥 GENERAR EGRESO SI LA ACADEMIA PAGA POR PARTICIPAR EN EL TORNEO
    if (Number(costo_organizacion) > 0) {
      await supabase.from('egresos').insert([{
        academia_id,
        torneo_id: data.id,
        concepto: `Inscripción Equipo Torneo: ${nombre}`,
        categoria_gasto: 'Arbitraje',
        centro_costo: 'Fútbol',
        monto: Number(costo_organizacion),
        fecha_gasto: fecha_inicio || new Date().toISOString().split('T')[0]
      }]);
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al crear torneo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. OBTENER TODOS LOS TORNEOS
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

// 3. OBTENER UN TORNEO
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

// 4. OBTENER PARTICIPANTES
router.get('/:id/participantes', authMiddleware, async (req, res) => {
  try {
    const torneo_id = req.params.id;
    const { categoria_id } = req.query;

    const { data, error } = await supabase
      .from('torneo_participantes')
      .select(`
        *,
        jugadores (
          id,
          nombre,
          foto_base64,
          jugador_categoria (
            categoria_id,
            categorias ( id, nombre )
          )
        )
      `)
      .eq('torneo_id', torneo_id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    let participantesFormateados = data.map(p => {
      const cats = p.jugadores?.jugador_categoria
        ? p.jugadores.jugador_categoria.map(jc => jc.categorias).filter(Boolean)
        : [];

      return {
        ...p,
        jugadores: {
          ...p.jugadores,
          categorias: cats
        }
      };
    });

    if (categoria_id) {
      participantesFormateados = participantesFormateados.filter(p =>
        p.jugadores?.categorias?.some(c => c.id === categoria_id)
      );
    }

    res.json({ success: true, data: participantesFormateados });
  } catch (error) {
    console.error('❌ Error al obtener participantes:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. ENVIAR CONVOCATORIA MASIVA (+ COBROS Y WHATSAPP) 🔥
router.post('/:id/convocar', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const torneo_id = req.params.id;
    const { jugadoresIds } = req.body;

    if (!jugadoresIds || jugadoresIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No hay jugadores para convocar.' });
    }

    const { data: torneo, error: errTorneo } = await supabase
      .from('torneos')
      .select('*')
      .eq('id', torneo_id)
      .single();

    if (errTorneo || !torneo) throw new Error('No se encontró la información del torneo.');

    const { data: jugadores, error: errJugadores } = await supabase
      .from('jugadores')
      .select('*')
      .in('id', jugadoresIds);

    if (errJugadores) throw errJugadores;

    const tutorIds = jugadores
      .map(j => j.tutor_id || j.apoderado_id || j.tutor_principal_id)
      .filter(Boolean);

    let tutoresMap = {};
    if (tutorIds.length > 0) {
      const { data: tutores } = await supabase
        .from('tutores')
        .select('*')
        .in('id', tutorIds);

      if (tutores) {
        tutores.forEach(t => { tutoresMap[t.id] = t; });
      }
    }

    const convocatorias = jugadores.map(j => {
      const idTutor = j.tutor_id || j.apoderado_id || j.tutor_principal_id;
      const tutor = tutoresMap[idTutor];
      const telefono = tutor?.telefono || j.telefono || '';

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

    // 🔥 VÍNCULO AUTOMÁTICO CON FINANZAS: REGISTRAR COBROS DE TORNEO EN CUENTAS CORRIENTES
    const precioTorneo = Number(torneo.costo_inscripcion) || 0;
    if (precioTorneo > 0) {
      const cobrosTorneo = jugadores.map(j => ({
        academia_id,
        jugador_id: j.id,
        torneo_id,
        concepto: `Inscripción Torneo: ${torneo.nombre}`,
        tipo_concepto: 'Torneo',
        monto: precioTorneo,
        monto_pagado: 0,
        estado: 'Pendiente',
        fecha_vencimiento: torneo.fecha_inicio || new Date().toISOString().split('T')[0]
      }));

      try {
        await supabase.from('cobros').insert(cobrosTorneo);
        await supabase.from('jugadores').update({ estado_financiero: 'Moroso' }).in('id', jugadoresIds);
      } catch (errFin) {
        console.error('⚠️ Detalle creando cobros de torneo:', errFin.message);
      }
    }

    const costoFormateado = torneo.costo_inscripcion > 0 
      ? `$${Number(torneo.costo_inscripcion).toLocaleString('es-CL')}` 
      : 'Gratuito';

    // Disparar WhatsApp
    for (const jugador of jugadores) {
      const idTutor = jugador.tutor_id || jugador.apoderado_id || jugador.tutor_principal_id;
      const tutor = tutoresMap[idTutor];
      const telefono = tutor?.telefono || jugador.telefono;
      
      if (!telefono) continue;

      let numLimpio = telefono.replace(/\D/g, '');
      if (!numLimpio.startsWith('56') && numLimpio.length === 9) {
        numLimpio = '56' + numLimpio;
      }

      const mensajeTexto = `🏆 *CONVOCATORIA A TORNEO*\n\n` +
        `Hola! Nos comunicamos de la academia.\n` +
        `*${jugador.nombre}* ha sido convocado/a para participar en:\n` +
        `⚽ *${torneo.nombre}*\n\n` +
        `💰 *Valor inscripción:* ${costoFormateado}\n` +
        (torneo.permite_cuotas ? `💳 *Opción de pago:* Hasta ${torneo.max_cuotas} cuotas.\n\n` : `\n`) +
        `Por favor responde a este mensaje:\n` +
        `1️⃣ Para *CONFIRMAR* asistencia.\n` +
        `2️⃣ Para *RECHAZAR* la invitación.`;

      try {
        await enviarMensaje(academia_id, numLimpio, mensajeTexto);
      } catch (errWs) {
        console.error(`❌ Error al enviar WhatsApp a ${jugador.nombre}:`, errWs.message);
      }
    }

    res.json({ success: true, message: 'Convocatorias guardadas e invitaciones enviadas.' });
  } catch (error) {
    console.error('❌ Error al convocar:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
