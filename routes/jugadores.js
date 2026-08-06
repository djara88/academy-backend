const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

// 1. OBTENER JUGADORES (CON SUS CATEGORÍAS)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { data, error } = await supabase
      .from('jugadores')
      .select(`*, jugador_categoria ( categorias ( id, nombre ) )`)
      .eq('academia_id', academia_id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const jugadoresFormateados = data.map(jugador => ({
      ...jugador,
      categorias: jugador.jugador_categoria.map(jc => jc.categorias)
    }));

    res.json({ success: true, data: jugadoresFormateados });
  } catch (error) {
    console.error('❌ Error al obtener jugadores:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. CREAR JUGADOR + TUTOR + EVALUACIÓN INICIAL
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { 
      tutor, nombre, rut, tipo_alumno, certificado_medico, sexo, fecha_nacimiento, posicion_cancha, 
      talla_uniforme, talla_apoderado, numero_camiseta, nombre_camiseta, 
      monto_matricula, abono_matricula, monto_mensualidad, foto_base64, evaluacion 
    } = req.body;

    // A) Tutor
    let tutorId = null;
    if (tutor && tutor.rut) {
      const { data: existingTutor } = await supabase.from('tutores').select('id').eq('rut', tutor.rut).eq('academia_id', academia_id).maybeSingle();
      if (existingTutor) {
        tutorId = existingTutor.id;
        await supabase.from('tutores').update({ nombre_completo: tutor.nombre_completo, telefono: tutor.telefono, email: tutor.email }).eq('id', tutorId);
      } else {
        const { data: newTutor, error: errTutor } = await supabase.from('tutores').insert([{ academia_id, nombre_completo: tutor.nombre_completo, rut: tutor.rut, telefono: tutor.telefono, email: tutor.email }]).select().single();
        if (errTutor) throw errTutor;
        tutorId = newTutor.id;
      }
    }

    // B) Jugador
    const { data: newJugador, error: errJugador } = await supabase.from('jugadores').insert([{
      academia_id, tutor_id: tutorId, nombre, rut: rut || null, tipo_alumno: tipo_alumno || 'Nuevo',
      certificado_medico: certificado_medico || 'Pendiente', sexo, fecha_nacimiento, posicion_cancha,
      talla_uniforme, talla_apoderado, numero_camiseta: numero_camiseta ? parseInt(numero_camiseta) : null,
      nombre_camiseta, monto_matricula, abono_matricula, monto_mensualidad, foto_base64, estado_uniforme: 'Pendiente'
    }]).select().single();

    if (errJugador) throw errJugador;

    // C) 🔥 GUARDAR EVALUACIÓN INICIAL DE LA MATRÍCULA
    if (evaluacion && Object.keys(evaluacion).length > 0) {
      await supabase.from('evaluaciones').insert([{
        jugador_id: newJugador.id,
        academia_id,
        datos_radar: evaluacion,
        comentarios_profesor: 'Evaluación inicial generada durante la matrícula.'
      }]);
    }

    res.status(201).json({ success: true, jugador_id: newJugador.id, tutor_id: tutorId, data: newJugador });
  } catch (error) {
    console.error('❌ Error en POST /api/jugadores:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. OBTENER CATEGORÍAS
router.get('/categorias', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { data, error } = await supabase.from('categorias').select('*').eq('academia_id', academia_id).order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. CREAR CATEGORÍA
router.post('/categorias', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { nombre, descripcion } = req.body;
    const { data, error } = await supabase.from('categorias').insert([{ academia_id, nombre, descripcion }]).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. ASIGNAR CATEGORÍA
router.post('/:jugador_id/categorias', authMiddleware, async (req, res) => {
  try {
    const { jugador_id } = req.params;
    const { categoria_id } = req.body;
    const { data, error } = await supabase.from('jugador_categoria').insert([{ jugador_id, categoria_id }]).select();
    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. OBTENER EVALUACIONES (🔥 CORRECCIÓN DEL ERROR DE FECHA)
router.get('/:jugador_id/evaluaciones', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugador_id } = req.params;
    // Usamos created_at en lugar de fecha para evitar el error 42703
    const { data, error } = await supabase
      .from('evaluaciones')
      .select('*')
      .eq('jugador_id', jugador_id)
      .eq('academia_id', academia_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al obtener evaluaciones:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. NUEVA EVALUACIÓN
router.post('/:jugador_id/evaluaciones', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugador_id } = req.params;
    const { datos_radar, comentarios_profesor } = req.body;
    const { data, error } = await supabase.from('evaluaciones').insert([{ jugador_id, academia_id, datos_radar, comentarios_profesor }]).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
