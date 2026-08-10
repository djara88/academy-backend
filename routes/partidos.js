// routes/partidos.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarMensaje } = require('../services/whatsappService');

// 1. CREAR PARTIDO (Torneo o Amistoso)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { 
      torneo_id, 
      categoria_id,
      es_amistoso, 
      rival, 
      fecha, 
      hora, 
      ubicacion, 
      link_maps, 
      color_uniforme,
      condicion, // 👈 Local o Visita
      cobra_arbitraje,
      monto_arbitraje_jugador
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

// 2. OBTENER PARTIDOS CON CATEGORÍAS
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

// 3. EDITAR UN PARTIDO EXISTENTE
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { 
      torneo_id, 
      categoria_id, 
      es_amistoso, 
      rival, 
      fecha, 
      hora, 
      ubicacion, 
      link_maps, 
      color_uniforme,
      condicion,
      cobra_arbitraje,
      monto_arbitraje_jugador,
      estado
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

// 4. ELIMINAR UN PARTIDO
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

// 5. DISPARAR CITACIÓN POR WHATSAPP A LA CATEGORÍA
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
        console.log(`✅ Citación de partido enviada a ${j.nombre} (${numLimpio})`);
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

// 6. OBTENER ESTADO DE CITACIONES DE UN PARTIDO
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

module.exports = router;
