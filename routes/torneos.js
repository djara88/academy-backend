const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

// Obtener todos los torneos de la academia
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
    console.error('Error al obtener torneos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Crear un nuevo torneo
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { nombre_torneo, temporada } = req.body;

    const { data, error } = await supabase
      .from('torneos')
      .insert([{ academia_id, nombre_torneo, temporada, estado: 'Activo' }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('Error al crear torneo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
