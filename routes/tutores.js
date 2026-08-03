const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

// 1. OBTENER TODOS LOS TUTORES DE LA ACADEMIA (Para directorio o listas)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { data, error } = await supabase
      .from('tutores')
      .select('*')
      .eq('academia_id', academia_id)
      .order('nombre_completo', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al obtener tutores:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. CREAR O ACTUALIZAR TUTOR (POR RUT)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { nombre_completo, rut, telefono, email } = req.body;

    // Buscar por academia_id + rut (índice único)
    const { data: existing, error: findError } = await supabase
      .from('tutores')
      .select('id')
      .eq('rut', rut)
      .eq('academia_id', academia_id)
      .maybeSingle();

    if (findError) throw findError;

    let tutor;
    if (existing) {
      const { data, error } = await supabase
        .from('tutores')
        .update({ nombre_completo, telefono, email })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      tutor = data;
    } else {
      const { data, error } = await supabase
        .from('tutores')
        .insert([{ academia_id, nombre_completo, rut, telefono, email }])
        .select()
        .single();
      if (error) throw error;
      tutor = data;
    }

    res.status(201).json({ success: true, data: tutor });
  } catch (error) {
    console.error('❌ Error en POST /api/tutores:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
