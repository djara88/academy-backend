const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

// GET: Listar jugadores
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
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error al obtener jugadores:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST: Crear un nuevo jugador (MATRÍCULA)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const {
      tutor: tutorData,
      nombre, sexo, fecha_nacimiento, posicion_cancha,
      talla_uniforme, talla_apoderado, numero_camiseta, nombre_camiseta,
      foto_base64,
      evaluacion,
      ficha_medica,
      monto_matricula, abono_matricula, monto_mensualidad
    } = req.body;

    // 1. Crear o actualizar el tutor (Permite varios alumnos por RUT)
    let tutor;
    
    // Verificamos si el tutor ya está registrado en esta academia
    const { data: existingTutor, error: findError } = await supabase
      .from('tutores')
      .select('*')
      .eq('rut', tutorData.rut)
      .eq('academia_id', academia_id)
      .maybeSingle();

    if (findError) throw findError;

    if (existingTutor) {
      // Si el tutor existe (ej. está matriculando a un segundo hijo), actualizamos sus datos de contacto
      const { data: updatedTutor, error: updateError } = await supabase
        .from('tutores')
        .update({
          nombre_completo: tutorData.nombre_completo,
          telefono: tutorData.telefono,
          email: tutorData.email
        })
        .eq('id', existingTutor.id)
        .select()
        .single();

      if (updateError) throw updateError;
      tutor = updatedTutor;
    } else {
      // Si no existe, lo insertamos como uno nuevo
      const { data: newTutor, error: insertError } = await supabase
        .from('tutores')
        .insert([{
          academia_id,
          nombre_completo: tutorData.nombre_completo,
          rut: tutorData.rut,
          telefono: tutorData.telefono,
          email: tutorData.email
        }])
        .select()
        .single();

      if (insertError) throw insertError;
      tutor = newTutor;
    }

    // 2. Subir foto a Supabase Storage
    let foto_url = null;
    if (foto_base64) {
      const base64Data = foto_base64.split(';base64,').pop();
      const fileName = `alumno_${Date.now()}.jpg`;
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('fotos_alumnos')
        .upload(fileName, Buffer.from(base64Data, 'base64'), { contentType: 'image/jpeg' });
      if (uploadError) throw uploadError;
      const { data: publicUrl } = supabase.storage.from('fotos_alumnos').getPublicUrl(fileName);
      foto_url = publicUrl.publicUrl;
    }

    // 3. Calcular categoría
    const edad = new Date().getFullYear() - new Date(fecha_nacimiento).getFullYear();
    const { data: categorias, error: catError } = await supabase
      .from('config_categorias')
      .select('nombre, edad_maxima')
      .eq('academia_id', academia_id)
      .order('edad_maxima', { ascending: true });
    if (catError) throw catError;

    let categoria = 'Sin Categoría';
    for (const cat of categorias) {
      if (edad <= cat.edad_maxima) {
        categoria = cat.nombre;
        break;
      }
    }
    if (categoria === 'Sin Categoría' && categorias.length > 0) {
      categoria = categorias[categorias.length - 1].nombre;
    }

    // 4. Crear jugador (Usamos el tutor.id reciclado o nuevo)
    const estado_matricula = (abono_matricula >= monto_matricula) ? 'Pagada' : 'Pendiente';
    const { data: jugador, error: jugError } = await supabase
      .from('jugadores')
      .insert([{
        academia_id,
        tutor_id: tutor.id,
        nombre,
        sexo,
        fecha_nacimiento,
        posicion_cancha,
        talla_uniforme,
        talla_apoderado,
        numero_camiseta,
        nombre_camiseta: nombre_camiseta?.toUpperCase() || '',
        foto_ruta: foto_url,
        estado_matricula,
        monto_matricula,
        monto_pagado_matricula: abono_matricula,
        monto_mensualidad,
        tipo_alumno: 'Nuevo',
        estado_uniforme: 'Pendiente',
        estado_uniforme_apoderado: (talla_apoderado && talla_apoderado !== 'No desea') ? 'Pendiente' : 'No Aplica',
        fecha_ingreso: new Date().toISOString().split('T')[0]
      }])
      .select()
      .single();

    if (jugError) throw jugError;

    // 5. Evaluación
    if (evaluacion && Object.keys(evaluacion).length > 0) {
      const { error: evalError } = await supabase
        .from('evaluaciones')
        .insert([{
          academia_id,
          jugador_id: jugador.id,
          fecha_evaluacion: new Date().toISOString(),
          metricas_json: evaluacion
        }]);
      if (evalError) throw evalError;
    }

    // 6. Ficha médica
    if (ficha_medica) {
      const { error: medError } = await supabase
        .from('ficha_medica')
        .insert([{
          academia_id,
          jugador_id: jugador.id,
          tipo_sangre: ficha_medica.tipo_sangre || null,
          alergias: ficha_medica.alergias || null,
          enfermedades_cronicas: ficha_medica.enfermedades_cronicas || null,
          contacto_em_nombre: ficha_medica.contacto_em_nombre || null,
          contacto_em_telefono: ficha_medica.contacto_em_telefono || null,
          compromiso_certificado: ficha_medica.compromiso_certificado || false
        }]);
      if (medError) throw medError;
    }

    // 7. Finanzas
    if (abono_matricula > 0) {
      const { error: finError } = await supabase
        .from('finanzas')
        .insert([{
          academia_id,
          jugador_id: jugador.id,
          flujo: 'Ingreso',
          tipo_pago: 'Matrícula',
          monto: abono_matricula,
          fecha_pago: new Date().toISOString().split('T')[0],
          concepto: `Matrícula - ${nombre}`,
          metodo_pago: 'Efectivo/Transferencia',
          mes_correspondiente: '-- No Aplica --'
        }]);
      if (finError) throw finError;
    }

    res.status(201).json({
      success: true,
      data: jugador,
      categoria_asignada: categoria
    });

  } catch (error) {
    console.error('❌ Error en POST /api/jugadores:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
