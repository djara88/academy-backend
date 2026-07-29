const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

// Obtener ficha médica de un jugador
router.get('/jugador/:jugadorId', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugadorId } = req.params;

    const { data, error } = await supabase
      .from('ficha_medica')
      .select('*')
      .eq('jugador_id', jugadorId)
      .eq('academia_id', academia_id)
      .maybeSingle();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al obtener ficha médica:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
