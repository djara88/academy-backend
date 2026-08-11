// routes/partidos.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarMensaje } = require('../services/whatsappService');

// 1. CREAR PARTIDO
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { 
      torneo_id, categoria_id, es_amistoso, rival, fecha, hora, 
      ubicacion, link_maps, color_uniforme, condicion, cobra_arbitraje, monto_arbitraje_jugador 
    } = req.body;

    const { data, error } = await supabase
      .from('partidos')
      .insert([{
        academia_id,
        torneo_id: es_amistoso ? null : (torneo_id || null),
        categoria_id: categoria_id || null,
        es_amistoso: es_amistoso || false,
        rival,
        fecha,
        hora: hora || '00:00',
        ubicacion: ubicacion || '',
        link_maps: link_maps || '',
        color_uniforme: color_uniforme || 'Titular',
        condicion: condicion || 'Local',
        cobra_arbitraje: cobra_arbitraje || false,
        monto_arbitraje_jugador: cobra_arbitraje ? (monto_arbitraje_jugador || 0) : 0,
        estado: 'Programado'
      }])
      .select('*, torneos(nombre), categorias(nombre)')
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al crear partido:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. OBTENER PARTIDOS
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { torneo_id, tipo } = req.query;

    let query = supabase
      .from('partidos')
      .select('*, torneos(nombre), categorias(nombre)')
      .eq('academia_id', academia_id)
      .order('fecha', { ascending: false });

    if (torneo_id) {
      query = query.eq('torneo_id', torneo_id);
    } else if (tipo === 'amistosos') {
      query = query.eq('es_amistoso', true);
    } else if (tipo === 'torneo') {
      query = query.eq('es_amistoso', false);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al obtener partidos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. EDITAR PARTIDO
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { 
      torneo_id, categoria_id, es_amistoso, rival, fecha, hora, 
      ubicacion, link_maps, color_uniforme, condicion, cobra_arbitraje, 
      monto_arbitraje_jugador, estado
    } = req.body;

    const { data, error } = await supabase
      .from('partidos')
      .update({
        torneo_id: es_amistoso ? null : (torneo_id || null),
        categoria_id: categoria_id || null,
        es_amistoso: es_amistoso || false,
        rival,
        fecha,
        hora: hora || '00:00',
        ubicacion: ubicacion || '',
        link_maps: link_maps || '',
        color_uniforme: color_uniforme || 'Titular',
        condicion: condicion || 'Local',
        cobra_arbitraje: cobra_arbitraje || false,
        monto_arbitraje_jugador: cobra_arbitraje ? (monto_arbitraje_jugador || 0) : 0,
        ...(estado && { estado })
      })
      .eq('id', req.params.id)
      .select('*, torneos(nombre), categorias(nombre)')
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al editar partido:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. ELIMINAR PARTIDO
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('partidos')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true, message: 'Partido eliminado correctamente.' });
  } catch (error) {
    console.error('❌ Error al eliminar partido:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. DISPARAR CITACIÓN POR WHATSAPP
router.post('/:id/citacion', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const partido_id = req.params.id;

    const { data: partido, error: errPartido } = await supabase
      .from('partidos')
      .select('*, torneos(nombre), categorias(nombre)')
      .eq('id', partido_id)
      .single();

    if (errPartido || !partido) throw new Error('No se encontró el partido.');
    if (!partido.categoria_id) throw new Error('Este partido no tiene una categoría asignada.');

    const { data: rels } = await supabase
      .from('jugador_categoria')
      .select('jugador_id')
      .eq('categoria_id', partido.categoria_id);

    const jugadorIds = rels ? rels.map(r => r.jugador_id) : [];
    if (jugadorIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No hay jugadores registrados en esta categoría.' });
    }

    const { data: jugadores } = await supabase
      .from('jugadores')
      .select('*')
      .in('id', jugadorIds);

    const tutorIds = jugadores.map(j => j.tutor_id || j.apoderado_id || j.tutor_principal_id).filter(Boolean);
    let tutoresMap = {};
    if (tutorIds.length > 0) {
      const { data: tutores } = await supabase.from('tutores').select('*').in('id', tutorIds);
      if (tutores) tutores.forEach(t => { tutoresMap[t.id] = t; });
    }

    const citaciones = jugadores.map(j => {
      const idTutor = j.tutor_id || j.apoderado_id || j.tutor_principal_id;
      const tutor = tutoresMap[idTutor];
      const telefono = tutor?.telefono || j.telefono || '';

      return {
        partido_id,
        jugador_id: j.id,
        telefono_apoderado: telefono,
        respuesta: 'Pendiente',
        paso_bot: 'ESPERANDO_CITACION'
      };
    });

    await supabase
      .from('partido_citaciones')
      .upsert(citaciones, { onConflict: 'partido_id, jugador_id', ignoreDuplicates: true });

    const tipoTexto = partido.es_amistoso ? '🤝 *PARTIDO AMISTOSO*' : `🏆 *TORNEO: ${partido.torneos?.nombre || ''}*`;
    const condicionTag = partido.condicion === 'Visita' ? '✈️ *Condición:* Visita' : '🏠 *Condición:* Local';
    const arbitrajeTexto = partido.cobra_arbitraje 
      ? `\n⚖️ *Arbitraje (en cancha):* $${Number(partido.monto_arbitraje_jugador).toLocaleString('es-CL')} por jugador` 
      : '';
    const mapsTexto = partido.link_maps ? `\n📍 *Ubicación:* ${partido.link_maps}` : '';

    for (const j of jugadores) {
      const idTutor = j.tutor_id || j.apoderado_id || j.tutor_principal_id;
      const tutor = tutoresMap[idTutor];
      const telefono = tutor?.telefono || j.telefono;

      if (!telefono) continue;

      let numLimpio = telefono.replace(/\D/g, '');
      if (!numLimpio.startsWith('56') && numLimpio.length === 9) numLimpio = '56' + numLimpio;

      const mensaje = `📋 *CITACIÓN A PARTIDO*\n\n` +
        `Hola! Nos comunicamos de la academia.\n` +
        `*${j.nombre}* ha sido citado/a para el próximo encuentro:\n\n` +
        `${tipoTexto}\n` +
        `⚽ *Rival:* vs ${partido.rival}\n` +
        `🏷️ *Categoría:* ${partido.categorias?.nombre || 'General'}\n` +
        `${condicionTag}\n` +
        `📅 *Fecha:* ${partido.fecha}\n` +
        `⏰ *Hora:* ${partido.hora} hrs\n` +
        `🏟️ *Lugar:* ${partido.ubicacion || 'Por confirmar'}` +
        `${mapsTexto}\n` +
        `👕 *Uniforme:* ${partido.color_uniforme}` +
        `${arbitrajeTexto}\n\n` +
        `Por favor responde a este mensaje:\n` +
        `1️⃣ Para *CONFIRMAR* asistencia.\n` +
        `2️⃣ Si *NO PODRÁ ASISTIR*.`;

      try {
        await enviarMensaje(academia_id, numLimpio, mensaje);
      } catch (err) {
        console.error(`❌ Error enviando citación a ${j.nombre}:`, err.message);
      }
    }

    res.json({ success: true, message: 'Citaciones enviadas con éxito.' });
  } catch (error) {
    console.error('❌ Error al enviar citaciones:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. OBTENER CITACIONES
router.get('/:id/citaciones', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('partido_citaciones')
      .select('*, jugadores(nombre, foto_base64)')
      .eq('partido_id', req.params.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. OBTENER ESTADÍSTICAS DEL PARTIDO PARA EL FORMULARIO
router.get('/:id/estadisticas', authMiddleware, async (req, res) => {
  try {
    const partido_id = req.params.id;

    const { data: citaciones, error: errCit } = await supabase
      .from('partido_citaciones')
      .select('jugador_id, jugadores(id, nombre, foto_base64)')
      .eq('partido_id', partido_id)
      .eq('respuesta', 'Si');

    if (errCit) throw errCit;

    const { data: stats } = await supabase
      .from('partido_estadisticas')
      .select('*')
      .eq('partido_id', partido_id);

    const statsMap = {};
    if (stats) {
      stats.forEach(s => { statsMap[s.jugador_id] = s; });
    }

    const jugadoresConStats = (citaciones || []).map(c => {
      const st = statsMap[c.jugador_id] || {};
      return {
        jugador_id: c.jugadores.id,
        nombre: c.jugadores.nombre,
        foto_base64: c.jugadores.foto_base64,
        goles: st.goles || 0,
        asistencias: st.asistencias || 0,
        tarjetas_amarillas: st.tarjetas_amarillas || 0,
        tarjetas_rojas: st.tarjetas_rojas || 0,
        es_mvp: st.es_mvp || false
      };
    });

    res.json({ success: true, data: jugadoresConStats });
  } catch (error) {
    console.error('❌ Error al obtener estadísticas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 8. GUARDAR RESULTADO, ESTADÍSTICAS E INFORME PERSONALIZADO POR ALUMNO CON MENSAJE FORMATIVO 🔥
router.post('/:id/guardar-resultado', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const partido_id = req.params.id;
    const { goles_favor, goles_contra, estadisticas, enviarWhatsapp } = req.body;

    const numGolesFavor = Number(goles_favor) || 0;
    const numGolesContra = Number(goles_contra) || 0;

    // 1. Actualizar el marcador y estado del partido
    const { data: partido, error: errP } = await supabase
      .from('partidos')
      .update({
        goles_favor: numGolesFavor,
        goles_contra: numGolesContra,
        estado: 'Jugado'
      })
      .eq('id', partido_id)
      .select('*, torneos(nombre), categorias(nombre)')
      .single();

    if (errP) throw errP;

    // 2. Guardar / Actualizar las estadísticas individuales
    if (estadisticas && estadisticas.length > 0) {
      const statsToUpsert = estadisticas.map(st => ({
        partido_id,
        jugador_id: st.jugador_id,
        goles: Number(st.goles) || 0,
        asistencias: Number(st.asistencias) || 0,
        tarjetas_amarillas: Number(st.tarjetas_amarillas) || 0,
        tarjetas_rojas: Number(st.tarjetas_rojas) || 0,
        es_mvp: Boolean(st.es_mvp)
      }));

      const { error: errUpsert } = await supabase
        .from('partido_estadisticas')
        .upsert(statsToUpsert, { onConflict: 'partido_id, jugador_id' });

      if (errUpsert) throw errUpsert;
    }

    // 3. Enviar informe individualizado con reflexiones formativas por WhatsApp
    if (enviarWhatsapp && estadisticas && estadisticas.length > 0) {
      const jugadorIds = estadisticas.map(st => st.jugador_id);

      const { data: jugadores } = await supabase
        .from('jugadores')
        .select('id, nombre, tutor_id')
        .in('id', jugadorIds);

      const tutorIds = (jugadores || []).map(j => j.tutor_id).filter(Boolean);
      const { data: tutores } = await supabase
        .from('tutores')
        .select('id, telefono, nombre_completo')
        .in('id', tutorIds);

      const tutorMap = {};
      (tutores || []).forEach(t => { tutorMap[t.id] = t; });

      const jugMap = {};
      (jugadores || []).forEach(j => { jugMap[j.id] = j; });

      // DEFINICIÓN DEL MENSAJE FORMATIVO SEGÚN EL RESULTADO DE LA CATEGORÍA
      let resultadoEmoji = '';
      let mensajeFormativo = '';

      if (numGolesFavor > numGolesContra) {
        resultadoEmoji = '🎉 ¡VICTORIA!';
        mensajeFormativo = 'Recordemos que cada victoria es fruto del trabajo en equipo, la humildad y la constancia. ¡A seguir entrenando con la misma pasión!';
      } else if (numGolesFavor === numGolesContra) {
        resultadoEmoji = '🤝 EMPATE';
        mensajeFormativo = 'El trabajo duro y el compañerismo nos enseñan que cada partido es una oportunidad para crecer juntos. ¡Gran esfuerzo del plantel!';
      } else {
        resultadoEmoji = '💪 ¡A SEGUIR MEJORANDO!';
        mensajeFormativo = 'En nuestra escuela, los resultados no definen nuestro valor, sino nuestro esfuerzo y resiliencia. De cada tropiezo aprendemos y nos levantamos más fuertes.';
      }

      for (const st of estadisticas) {
        const jug = jugMap[st.jugador_id];
        if (!jug) continue;

        const tutor = tutorMap[jug.tutor_id];
        if (tutor && tutor.telefono) {
          let numLimpio = tutor.telefono.replace(/\D/g, '');
          if (!numLimpio.startsWith('56') && numLimpio.length === 9) numLimpio = '56' + numLimpio;

          // CONSTRUCCIÓN DEL REPORTE INDIVIDUAL DEL ALUMNO
          const golesTxt = st.goles > 0 ? `⚽ *Goles convertidos:* ${st.goles}\n` : '';
          const asistenciasTxt = st.asistencias > 0 ? `🎯 *Asistencias:* ${st.asistencias}\n` : '';
          const amarillasTxt = st.tarjetas_amarillas > 0 ? `🟨 *Tarjetas amarillas:* ${st.tarjetas_amarillas}\n` : '';
          const rojasTxt = st.tarjetas_rojas > 0 ? `🟥 *Tarjeta roja*\n` : '';
          const mvpTxt = st.es_mvp ? `🌟 *¡Elegido/a Jugador/a Destacado/a del Partido (MVP)!*\n` : '';

          const sinEventos = (!golesTxt && !asistenciasTxt && !amarillasTxt && !rojasTxt && !mvpTxt) 
            ? '✔️ Destacada participación, compromiso y entrega en cancha.\n' 
            : '';

          const mensajePersonalizado = `📊 *REPORTE OFICIAL DEL ENCUENTRO*\n\n` +
            `Hola ${tutor.nombre_completo || 'Apoderado'},\n` +
            `Compartimos el resumen del partido de la categoría *${partido.categorias?.nombre || ''}*:\n\n` +
            `⚽ *Marcador Final:* Nuestra Academia ${numGolesFavor} - ${numGolesContra} ${partido.rival}\n` +
            `${resultadoEmoji}\n\n` +
            `🏃‍♂️ *Desempeño Individual de ${jug.nombre}:*\n` +
            `${golesTxt}${asistenciasTxt}${amarillasTxt}${rojasTxt}${mvpTxt}${sinEventos}\n` +
            `🌱 *Reflexión Formativa:*\n` +
            `_${mensajeFormativo}_\n\n` +
            `¡Gracias por acompañar y apoyar siempre su desarrollo deportivo! ⚽👏`;

          try {
            await enviarMensaje(academia_id, numLimpio, mensajePersonalizado);
          } catch (errWs) {
            console.error(`❌ Error enviando resumen individual a ${numLimpio}:`, errWs.message);
          }
        }
      }
    }

    res.json({ success: true, message: 'Resultado guardado e informes individuales enviados por WhatsApp.' });
  } catch (error) {
    console.error('❌ Error al guardar resultado:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
