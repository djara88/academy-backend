// routes/partidos.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

// ==========================================
// 1. CREAR UN PARTIDO (Torneo u Oficial / Amistoso)
// ==========================================
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { 
      torneo_id, 
      es_amistoso, 
      rival, 
      fecha, 
      hora, 
      ubicacion, 
      link_maps, 
      color_uniforme,
      cobra_arbitraje,
      monto_arbitraje_jugador
    } = req.body;

    const { data, error } = await supabase
      .from('partidos')
      .insert([{
        academia_id,
        torneo_id: es_amistoso ? null : (torneo_id || null),
        es_amistoso: es_amistoso || false,
        rival,
        fecha,
        hora: hora || '00:00',
        ubicacion: ubicacion || '',
        link_maps: link_maps || '',
        color_uniforme: color_uniforme || 'Titular',
        cobra_arbitraje: cobra_arbitraje || false,
        monto_arbitraje_jugador: cobra_arbitraje ? (monto_arbitraje_jugador || 0) : 0,
        estado: 'Programado'
      }])
      .select('*, torneos(nombre)')
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al crear partido:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 2. OBTENER LISTA GENERAL DE PARTIDOS (Con Filtros)
// ==========================================
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { torneo_id, tipo } = req.query;

    let query = supabase
      .from('partidos')
      .select('*, torneos(nombre)')
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

// ==========================================
// 3. RUTA DE COMPATIBILIDAD POR TORNEO ESPECÍFICO
// ==========================================
router.get('/torneo/:torneoId', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { torneoId } = req.params;

    const { data, error } = await supabase
      .from('partidos')
      .select('*, torneos(nombre)')
      .eq('academia_id', academia_id)
      .eq('torneo_id', torneoId)
      .order('fecha', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al obtener partidos del torneo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 4. ACTUALIZAR MARCADOR Y RESULTADO
// ==========================================
router.put('/:id/resultado', authMiddleware, async (req, res) => {
  try {
    const { goles_favor, goles_contra, estado } = req.body;

    const { data, error } = await supabase
      .from('partidos')
      .update({
        goles_favor: goles_favor || 0,
        goles_contra: goles_contra || 0,
        estado: estado || 'Finalizado'
      })
      .eq('id', req.params.id)
      .select('*, torneos(nombre)')
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al actualizar resultado:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
