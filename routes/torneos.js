// routes/torneos.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

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

// ENVIAR CONVOCATORIA MASIVA POR CATEGORÍA
router.post('/:id/convocar', authMiddleware, async (req, res) => {
  try {
    const torneo_id = req.params.id;
    const { jugadoresIds } = req.body;

    if (!jugadoresIds || jugadoresIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No hay jugadores para convocar.' });
    }

    const convocatorias = jugadoresIds.map(jugador_id => ({
      torneo_id,
      jugador_id,
      telefono_apoderado: 'Pendiente',
      respuesta_participacion: 'Pendiente',
      estado_pago: 'Pendiente'
    }));

    const { error } = await supabase
      .from('torneo_participantes')
      .upsert(convocatorias, { onConflict: 'torneo_id, jugador_id', ignoreDuplicates: true });

    if (error) throw error;

    console.log(`📢 Disparando WhatsApp a ${jugadoresIds.length} jugadores para el torneo ${torneo_id}`);

    res.json({ success: true, message: 'Convocatorias enviadas con éxito por WhatsApp.' });
  } catch (error) {
    console.error('❌ Error al convocar:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
