// routes/torneos.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { enviarMensaje } = require('../services/whatsappService');
const { academyMessage, getAcademyName } = require('../services/academyIdentity');
const { updateTournamentParticipation, updateCitation } = require('../services/sportsResponseService');

// CENTRO DE RESPUESTAS DEPORTIVAS PARA DIRECCIÓN
router.get('/respuestas/centro', authMiddleware, requireDirector, async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const tournamentId = String(req.query?.torneo_id || '').trim();
    let participationQuery = supabase.from('torneo_participantes')
      .select('id,torneo_id,jugador_id,categoria_id,respuesta_participacion,pago_en_cuotas,numero_cuotas,paso_bot,estado_pago,canal_respuesta,canal_cuotas,created_at,jugadores(id,nombre,foto_url,foto_base64),torneos!inner(id,nombre,academia_id,fecha_inicio,fecha_fin,costo_inscripcion,permite_cuotas,max_cuotas,estado),categorias(id,nombre)')
      .eq('academia_id', academyId).eq('torneos.academia_id', academyId)
      .order('created_at', { ascending: false }).limit(500);
    if (tournamentId) participationQuery = participationQuery.eq('torneo_id', tournamentId);

    let citationQuery = supabase.from('partido_citaciones')
      .select('id,partido_id,jugador_id,respuesta,motivo_ausencia,paso_bot,canal_respuesta,respuesta_actualizada_at,created_at,jugadores(id,nombre,foto_url,foto_base64),partidos!inner(id,academia_id,torneo_id,rival,fecha,hora,hora_citacion,ubicacion,categoria_id,categorias(nombre))')
      .eq('partidos.academia_id', academyId)
      .order('created_at', { ascending: false }).limit(500);
    if (tournamentId) citationQuery = citationQuery.eq('partidos.torneo_id', tournamentId);

    const [participationResult, citationResult] = await Promise.all([participationQuery, citationQuery]);
    if (participationResult.error) throw participationResult.error;
    if (citationResult.error) throw citationResult.error;

    const groups = new Map();
    for (const row of participationResult.data || []) {
      const key = `${row.torneo_id}:${row.jugador_id}`;
      const current = groups.get(key) || {
        torneo_id: row.torneo_id,
        jugador_id: row.jugador_id,
        jugador: row.jugadores || null,
        torneo: row.torneos,
        categorias: [],
        respuesta_participacion: row.respuesta_participacion || 'Pendiente',
        pago_en_cuotas: Boolean(row.pago_en_cuotas),
        numero_cuotas: Math.max(1, Number(row.numero_cuotas) || 1),
        paso_bot: row.paso_bot || 'FINALIZADO',
        estado_pago: row.estado_pago || 'Pendiente',
        canal_respuesta: row.canal_respuesta || null,
        canal_cuotas: row.canal_cuotas || null,
      };
      if (row.categorias && !current.categorias.some((item) => String(item.id) === String(row.categorias.id))) current.categorias.push(row.categorias);
      if (row.respuesta_participacion === 'Si') current.respuesta_participacion = 'Si';
      else if (row.respuesta_participacion === 'No' && current.respuesta_participacion !== 'Si') current.respuesta_participacion = 'No';
      if (row.paso_bot === 'ESPERANDO_CUOTAS') current.paso_bot = 'ESPERANDO_CUOTAS';
      groups.set(key, current);
    }

    const today = new Date().toISOString().slice(0, 10);
    const citations = (citationResult.data || []).filter((row) => String(row.partidos?.fecha || '') >= today)
      .map((row) => ({ ...row, jugador: row.jugadores || null, partido: row.partidos }));

    return res.json({ success: true, data: { participaciones: [...groups.values()], citaciones: citations } });
  } catch (error) {
    console.error('Error cargando centro de respuestas:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible cargar las confirmaciones deportivas.' });
  }
});

router.patch('/respuestas/participacion/:torneoId/:jugadorId', authMiddleware, requireDirector, async (req, res) => {
  try {
    const data = await updateTournamentParticipation({
      academyId: req.user.academia_id,
      tournamentId: req.params.torneoId,
      playerId: req.params.jugadorId,
      response: req.body?.respuesta,
      installments: req.body?.cuotas,
      channel: 'director',
      actorUserId: req.user.id,
    });
    return res.json({ success: true, data, message: data.pending_installments ? 'Participación confirmada. Falta definir las cuotas.' : 'Respuesta registrada por dirección.' });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible registrar la participación.' });
  }
});

router.patch('/respuestas/citacion/:partidoId/:jugadorId', authMiddleware, requireDirector, async (req, res) => {
  try {
    const data = await updateCitation({
      academyId: req.user.academia_id,
      matchId: req.params.partidoId,
      playerId: req.params.jugadorId,
      response: req.body?.respuesta,
      reason: req.body?.motivo,
      channel: 'director',
      actorUserId: req.user.id,
    });
    return res.json({ success: true, data, message: data.respuesta === 'Si' ? 'Asistencia confirmada por dirección.' : 'Inasistencia registrada por dirección.' });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible responder la citación.' });
  }
});

// 1. CREAR TORNEO + EGRESO ORGANIZACIÓN (SI APLICA)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { 
      nombre, fecha_inicio, fecha_fin, costo_inscripcion, permite_cuotas, max_cuotas,
      costo_organizacion
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
    const { academia_id } = req.user;
    const { data, error } = await supabase
      .from('torneos')
      .select('*')
      .eq('id', req.params.id)
      .eq('academia_id', academia_id)
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
    const { academia_id } = req.user;
    const torneo_id = req.params.id;
    const { categoria_id } = req.query;

    const { data: torneo } = await supabase.from('torneos').select('id')
      .eq('id', torneo_id).eq('academia_id', academia_id).maybeSingle();
    if (!torneo) return res.status(404).json({ success: false, error: 'Torneo no encontrado.' });

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

// 5. ENVIAR CONVOCATORIA MASIVA (+ COBROS Y WHATSAPP)
router.post('/:id/convocar', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const academyName = await getAcademyName(academia_id);
    const torneo_id = req.params.id;
    const { jugadoresIds } = req.body;

    if (!jugadoresIds || jugadoresIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No hay jugadores para convocar.' });
    }

    const { data: torneo, error: errTorneo } = await supabase
      .from('torneos')
      .select('*')
      .eq('id', torneo_id)
      .eq('academia_id', academia_id)
      .single();

    if (errTorneo || !torneo) throw new Error('No se encontró la información del torneo.');

    const { data: jugadores, error: errJugadores } = await supabase
      .from('jugadores')
      .select('*')
      .eq('academia_id', academia_id)
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
        .eq('academia_id', academia_id)
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
        const { error: errCobros } = await supabase
          .from('cobros')
          .upsert(cobrosTorneo, {
            onConflict: 'academia_id,jugador_id,torneo_id',
            ignoreDuplicates: true
          });
        if (errCobros) throw errCobros;
        await supabase.from('jugadores')
          .update({ estado_financiero: 'Moroso' })
          .eq('academia_id', academia_id)
          .in('id', jugadoresIds);
      } catch (errFin) {
        console.error('⚠️ Detalle creando cobros de torneo:', errFin.message);
      }
    }

    const costoFormateado = torneo.costo_inscripcion > 0 
      ? `$${Number(torneo.costo_inscripcion).toLocaleString('es-CL')}` 
      : 'Gratuito';

    for (const jugador of jugadores) {
      const idTutor = jugador.tutor_id || jugador.apoderado_id || jugador.tutor_principal_id;
      const tutor = tutoresMap[idTutor];
      const telefono = tutor?.telefono || jugador.telefono;
      
      if (!telefono) continue;

      let numLimpio = telefono.replace(/\D/g, '');
      if (!numLimpio.startsWith('56') && numLimpio.length === 9) {
        numLimpio = '56' + numLimpio;
      }

      const mensajeTexto = academyMessage(academyName, `🏆 *CONVOCATORIA A TORNEO*\n\n` +
        `Hola, te escribimos de *${academyName}*.\n` +
        `*${jugador.nombre}* ha sido convocado/a para participar en:\n` +
        `⚽ *${torneo.nombre}*\n\n` +
        `💰 *Valor inscripción:* ${costoFormateado}\n` +
        (torneo.permite_cuotas ? `💳 *Opción de pago:* Hasta ${torneo.max_cuotas} cuotas.\n\n` : `\n`) +
        `Por favor responde a este mensaje:\n` +
        `1️⃣ Para *CONFIRMAR* asistencia.\n` +
        `2️⃣ Para *RECHAZAR* la invitación.`);

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
