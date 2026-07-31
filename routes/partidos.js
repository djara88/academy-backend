const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

// Obtener partidos de un torneo
router.get('/torneo/:torneoId', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { torneoId } = req.params;

    const { data, error } = await supabase
      .from('partidos')
      .select('*')
      .eq('torneo_id', torneoId)
      .eq('academia_id', academia_id)
      .order('fecha_partido', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error al obtener partidos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
