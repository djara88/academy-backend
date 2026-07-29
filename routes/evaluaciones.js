const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

// Obtener evaluaciones de un jugador
router.get('/jugador/:jugadorId', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugadorId } = req.params;

    const { data, error } = await supabase
      .from('evaluaciones')
      .select('*')
      .eq('jugador_id', jugadorId)
      .eq('academia_id', academia_id)
      .order('fecha_evaluacion', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al obtener evaluaciones:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Guardar nueva evaluación
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugador_id, metricas_json } = req.body;

    const { data, error } = await supabase
      .from('evaluaciones')
      .insert([{
        academia_id,
        jugador_id,
        fecha_evaluacion: new Date().toISOString(),
        metricas_json
      }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al guardar evaluación:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
