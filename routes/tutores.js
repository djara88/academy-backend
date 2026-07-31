const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

// Crear un nuevo tutor (o actualizar si ya existe por RUT en la misma academia)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { nombre_completo, rut, telefono, email } = req.body;

    // Verificar si el tutor ya existe por RUT en esta academia
    const { data: existing, error: findError } = await supabase
      .from('tutores')
      .select('*')
      .eq('rut', rut)
      .eq('academia_id', academia_id)
      .maybeSingle();

    if (findError) throw findError;

    let tutor;
    if (existing) {
      // Actualizar datos del tutor existente
      const { data, error } = await supabase
        .from('tutores')
        .update({ 
          nombre_completo, 
          telefono, 
          email 
        })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      tutor = data;
    } else {
      // Insertar nuevo tutor
      const { data, error } = await supabase
        .from('tutores')
        .insert([{ 
          academia_id, 
          nombre_completo, 
          rut, 
          telefono, 
          email 
        }])
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
