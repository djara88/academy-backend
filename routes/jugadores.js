const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

// 1. OBTENER JUGADORES DE LA ACADEMIA
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { data, error } = await supabase
      .from('jugadores')
      .select('*')
      .eq('academia_id', academia_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al obtener jugadores:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. CREAR JUGADOR + TUTOR
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { 
      tutor, nombre, rut, tipo_alumno, certificado_medico, sexo, fecha_nacimiento, posicion_cancha, 
      talla_uniforme, talla_apoderado, numero_camiseta, nombre_camiseta, 
      monto_matricula, abono_matricula, monto_mensualidad, foto_base64 
    } = req.body;

    // A) Crear o Buscar al Tutor por RUT
    let tutorId = null;
    if (tutor && tutor.rut) {
      const { data: existingTutor } = await supabase
        .from('tutores')
        .select('id')
        .eq('rut', tutor.rut)
        .eq('academia_id', academia_id)
        .maybeSingle();

      if (existingTutor) {
        tutorId = existingTutor.id;
        await supabase.from('tutores').update({
          nombre_completo: tutor.nombre_completo,
          telefono: tutor.telefono,
          email: tutor.email
        }).eq('id', tutorId);
      } else {
        const { data: newTutor, error: errTutor } = await supabase
          .from('tutores')
          .insert([{
            academia_id,
            nombre_completo: tutor.nombre_completo,
            rut: tutor.rut,
            telefono: tutor.telefono,
            email: tutor.email
          }])
          .select()
          .single();

        if (errTutor) throw errTutor;
        tutorId = newTutor.id;
      }
    }

    // B) Crear el registro del Jugador vinculado al Tutor
    const { data: newJugador, error: errJugador } = await supabase
      .from('jugadores')
      .insert([{
        academia_id,
        tutor_id: tutorId,
        nombre: nombre,
        rut: rut || null,
        tipo_alumno: tipo_alumno || 'Nuevo',
        certificado_medico: certificado_medico || 'Pendiente',
        sexo,
        fecha_nacimiento,
        posicion_cancha,
        talla_uniforme,
        talla_apoderado,
        numero_camiseta: numero_camiseta ? parseInt(numero_camiseta) : null,
        nombre_camiseta,
        monto_matricula,
        abono_matricula,
        monto_mensualidad,
        foto_base64,
        estado_uniforme: 'Pendiente'
      }])
      .select()
      .single();

    if (errJugador) throw errJugador;

    // C) Retornamos los IDs requeridos por la ruta de matrículas
    res.status(201).json({
      success: true,
      jugador_id: newJugador.id,
      tutor_id: tutorId,
      data: newJugador
    });

  } catch (error) {
    console.error('❌ Error en POST /api/jugadores:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
