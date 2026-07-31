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
    console.error('❌ Error al obtener partidos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Crear un nuevo partido
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { torneo_id, rival, fecha_partido, categoria_jugando, direccion } = req.body;

    const { data, error } = await supabase
      .from('partidos')
      .insert([{
        academia_id,
        torneo_id,
        rival,
        fecha_partido,
        categoria_jugando,
        direccion,
        estado: 'Programado'
      }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al crear partido:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Actualizar un partido (incluyendo resultados)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { id } = req.params;
    const { rival, fecha_partido, categoria_jugando, direccion, goles_axf, goles_rival, estado } = req.body;

    const { data, error } = await supabase
      .from('partidos')
      .update({ rival, fecha_partido, categoria_jugando, direccion, goles_axf, goles_rival, estado })
      .eq('id', id)
      .eq('academia_id', academia_id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al actualizar partido:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Eliminar un partido
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { id } = req.params;

    const { error } = await supabase
      .from('partidos')
      .delete()
      .eq('id', id)
      .eq('academia_id', academia_id);

    if (error) throw error;
    res.json({ success: true, message: 'Partido eliminado' });
  } catch (error) {
    console.error('❌ Error al eliminar partido:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
