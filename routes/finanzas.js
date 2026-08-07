// routes/finanzas.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

// OBTENER la configuración financiera de la academia
router.get('/configuracion', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    
    // Buscamos si ya tiene configuración
    const { data, error } = await supabase
      .from('configuracion_financiera')
      .select('*')
      .eq('academia_id', academia_id)
      .maybeSingle();

    if (error) throw error;

    // Si no existe, devolvemos un objeto por defecto
    if (!data) {
      return res.json({ success: true, data: { acepta_efectivo: true, acepta_transferencia: false, acepta_pago_online: false } });
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al obtener config financiera:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ACTUALIZAR O CREAR la configuración financiera
router.put('/configuracion', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const body = req.body;

    // Upsert: Si existe la actualiza, si no existe la crea
    const { data, error } = await supabase
      .from('configuracion_financiera')
      .upsert({ 
        academia_id, 
        ...body,
        updated_at: new Date().toISOString()
      }, { onConflict: 'academia_id' })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, message: 'Configuración financiera guardada con éxito', data });
  } catch (error) {
    console.error('❌ Error al guardar config financiera:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
