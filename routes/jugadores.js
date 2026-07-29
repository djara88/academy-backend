const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

// --- GET: Listar jugadores de la academia ---
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
    console.error('Error al listar jugadores:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- POST: Crear un nuevo jugador con todos sus datos ---
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id, rol } = req.user;

    // Verificar si la academia tiene permisos (suscripción activa y límite de alumnos)
    // Esto lo haremos después en un middleware específico

    // Extraer todos los datos del body
    const {
      // Datos del tutor
      tutor_nombre,
      tutor_rut,
      tutor_telefono,
      tutor_email,
      
      // Datos del jugador
      nombre,
      sexo,
      fecha_nacimiento,
      posicion_cancha,
      talla_uniforme,
      talla_apoderado,
      numero_camiseta,
      nombre_camiseta,
      foto_ruta, // URL de la foto subida a Supabase Storage
      monto_matricula,
      monto_pagado_matricula,
      monto_mensualidad,
      tipo_alumno,
      
      // Ficha médica
      tipo_sangre,
      alergias,
      enfermedades_cronicas,
      contacto_em_nombre,
      contacto_em_telefono,
      compromiso_certificado,
      
      // Evaluación inicial (objeto con las métricas)
      evaluacion_metricas
    } = req.body;

    // 1. Validar datos obligatorios
    if (!nombre || !tutor_nombre || !tutor_rut) {
      return res.status(400).json({ 
        success: false, 
        error: 'El nombre del jugador, nombre y RUT del tutor son obligatorios' 
      });
    }

    // 2. Buscar o crear el tutor
    let tutor_id;
    const { data: tutorExistente, error: errorTutor } = await supabase
      .from('tutores')
      .select('id')
      .eq('rut', tutor_rut)
      .eq('academia_id', academia_id)
      .maybeSingle();

    if (errorTutor) throw errorTutor;

    if (tutorExistente) {
      tutor_id = tutorExistente.id;
      // Actualizar datos del tutor
      const { error: updateError } = await supabase
        .from('tutores')
        .update({
          nombre_completo: tutor_nombre,
          telefono: tutor_telefono,
          email: tutor_email,
          updated_at: new Date(),
        })
        .eq('id', tutor_id);

      if (updateError) throw updateError;
    } else {
      // Crear nuevo tutor
      const { data: nuevoTutor, error: createError } = await supabase
        .from('tutores')
        .insert([{
          academia_id,
          nombre_completo: tutor_nombre,
          rut: tutor_rut,
          telefono: tutor_telefono,
          email: tutor_email,
        }])
        .select();

      if (createError) throw createError;
      tutor_id = nuevoTutor[0].id;
    }

    // 3. Crear el jugador
    const jugadorData = {
      academia_id,
      tutor_id,
      nombre,
      sexo,
      fecha_nacimiento,
      posicion_cancha,
      talla_uniforme,
      talla_apoderado,
      numero_camiseta,
      nombre_camiseta,
      foto_ruta,
      monto_matricula: parseFloat(monto_matricula) || 0,
      monto_pagado_matricula: parseFloat(monto_pagado_matricula) || 0,
      monto_mensualidad: parseFloat(monto_mensualidad) || 0,
      tipo_alumno: tipo_alumno || 'Nuevo',
      estado_matricula: (parseFloat(monto_pagado_matricula) || 0) >= (parseFloat(monto_matricula) || 0) ? 'Pagada' : 'Pendiente',
      fecha_ingreso: new Date().toISOString().split('T')[0],
    };

    const { data: nuevoJugador, error: errorJugador } = await supabase
      .from('jugadores')
      .insert([jugadorData])
      .select();

    if (errorJugador) throw errorJugador;

    const jugador_id = nuevoJugador[0].id;

    // 4. Crear ficha médica
    if (tipo_sangre || alergias || enfermedades_cronicas || contacto_em_nombre || contacto_em_telefono) {
      const fichaData = {
        academia_id,
        jugador_id,
        tipo_sangre: tipo_sangre || null,
        alergias: alergias || null,
        enfermedades_cronicas: enfermedades_cronicas || null,
        contacto_em_nombre: contacto_em_nombre || null,
        contacto_em_telefono: contacto_em_telefono || null,
        compromiso_certificado: compromiso_certificado || false,
      };

      const { error: errorFicha } = await supabase
        .from('ficha_medica')
        .insert([fichaData]);

      if (errorFicha) throw errorFicha;
    }

    // 5. Crear evaluación inicial (si se enviaron métricas)
    if (evaluacion_metricas && typeof evaluacion_metricas === 'object') {
      const evalData = {
        academia_id,
        jugador_id,
        fecha_evaluacion: new Date().toISOString(),
        metricas_json: evaluacion_metricas,
      };

      const { error: errorEval } = await supabase
        .from('evaluaciones')
        .insert([evalData]);

      if (errorEval) throw errorEval;
    }

    // 6. Si se pagó la matrícula, registrar en finanzas
    const montoPagado = parseFloat(monto_pagado_matricula) || 0;
    if (montoPagado > 0) {
      const finanzaData = {
        academia_id,
        jugador_id,
        flujo: 'Ingreso',
        tipo_pago: 'Matrícula',
        monto: montoPagado,
        fecha_pago: new Date().toISOString().split('T')[0],
        concepto: `Pago de matrícula - ${nombre}`,
        metodo_pago: 'Efectivo/Transferencia',
        mes_correspondiente: '-- No Aplica --',
      };

      const { error: errorFinanza } = await supabase
        .from('finanzas')
        .insert([finanzaData]);

      if (errorFinanza) throw errorFinanza;
    }

    // 7. Responder con el jugador creado
    res.status(201).json({
      success: true,
      data: nuevoJugador[0],
      message: 'Jugador registrado exitosamente',
    });

  } catch (error) {
    console.error('Error al crear jugador:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;