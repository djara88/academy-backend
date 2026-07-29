const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

// Obtener todos los jugadores de la academia del usuario autenticado
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;

    const { data, error } = await supabase
      .from('jugadores')
      .select(`
        *,
        tutor:tutores(nombre_completo, telefono, email),
        ficha_medica(*)
      `)
      .eq('academia_id', academia_id);

    if (error) throw error;

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('❌ Error al obtener jugadores:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
