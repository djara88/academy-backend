require('dotenv').config();
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarWhatsApp } = require('../utils/whatsapp'); // Importamos el motor de WhatsApp

// ====================================================================
// 1. OBTENER JUGADORES (CON SUS CATEGORÍAS E INSIGNIAS)
// ====================================================================
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
      categorias: jugador.jugador_categoria.map(jc => jc.categorias),
      insignias: jugador.insignias || []
    }));

    res.json({ success: true, data: jugadoresFormateados });
  } catch (error) {
    console.error('❌ Error al obtener jugadores:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 2. CREAR JUGADOR + TUTOR + EVALUACIÓN INICIAL
// ====================================================================
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { 
      tutor, nombre, rut, tipo_alumno, certificado_medico, sexo, fecha_nacimiento, posicion_cancha, 
      talla_uniforme, talla_apoderado, numero_camiseta, nombre_camiseta, 
      monto_matricula, abono_matricula, monto_mensualidad, foto_base64, evaluacion 
    } = req.body;

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

    const { data: newJugador, error: errJugador } = await supabase.from('jugadores').insert([{
      academia_id, tutor_id: tutorId, nombre, rut: rut || null, tipo_alumno: tipo_alumno || 'Nuevo',
      certificado_medico: certificado_medico || 'Pendiente', sexo, fecha_nacimiento, posicion_cancha,
      talla_uniforme, talla_apoderado, numero_camiseta: numero_camiseta ? parseInt(numero_camiseta) : null,
      nombre_camiseta, monto_matricula, abono_matricula, monto_mensualidad, foto_base64, estado_uniforme: 'Pendiente',
      estado_financiero: 'Al Día',
      alerta_medica: '',
      insignias: []
    }]).select().single();

    if (errJugador) throw errJugador;

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

// ====================================================================
// 3. OBTENER CATEGORÍAS
// ====================================================================
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

// ====================================================================
// 4. CREAR CATEGORÍA
// ====================================================================
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

// ====================================================================
// 5. ASIGNAR CATEGORÍA A JUGADOR
// ====================================================================
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

// ====================================================================
// 6. OBTENER EVALUACIONES DEL JUGADOR
// ====================================================================
router.get('/:jugador_id/evaluaciones', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugador_id } = req.params;
    const { data, error } = await supabase
      .from('evaluaciones')
      .select('*')
      .eq('jugador_id', jugador_id)
      .eq('academia_id', academia_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 7. NUEVA EVALUACIÓN
// ====================================================================
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

// ====================================================================
// 8. ENVIAR INFORME PDF POR CORREO (BREVO)
// ====================================================================
router.post('/:jugador_id/enviar-informe', authMiddleware, async (req, res) => {
  try {
    const { jugador_id } = req.params;
    const { pdf_base64, comentarios } = req.body;

    const { data: jugador, error: errJugador } = await supabase.from('jugadores').select('nombre, tutor_id').eq('id', jugador_id).single();
    if (errJugador || !jugador.tutor_id) throw new Error('Jugador o tutor no encontrado.');

    const { data: tutor, error: errTutor } = await supabase.from('tutores').select('email, nombre_completo').eq('id', jugador.tutor_id).single();
    if (errTutor || !tutor.email) throw new Error('El apoderado no tiene un correo registrado.');

    const base64Content = pdf_base64.split('base64,')[1];
    const brevoApiKey = process.env.BREVO_API_KEY;
    const brevoSenderEmail = process.env.BREVO_SENDER_EMAIL;

    if (!brevoApiKey || !brevoSenderEmail) throw new Error('Credenciales de correo no configuradas.');

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'api-key': brevoApiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: "AcademiaPro Deportes", email: brevoSenderEmail },
        to: [{ email: tutor.email, name: tutor.nombre_completo }],
        subject: `Informe de Evolución Deportiva - ${jugador.nombre} ⚽`,
        htmlContent: `
          <div style="font-family: sans-serif; color: #333;">
            <h2>Hola ${tutor.nombre_completo},</h2>
            <p>Adjuntamos el informe de evolución deportiva más reciente de <strong>${jugador.nombre}</strong>.</p>
            ${comentarios ? `<div style="background-color: #f4f4f4; padding: 15px; border-radius: 8px; margin: 20px 0;"><p><strong>Comentarios del profesor:</strong><br/>${comentarios}</p></div>` : ''}
            <p>Un saludo afectuoso,<br/>El equipo de la Academia</p>
          </div>
        `,
        attachment: [{ name: `Informe_${jugador.nombre.replace(/\s+/g, '_')}.pdf`, content: base64Content }]
      })
    });

    if (!response.ok) throw new Error('Error al enviar el correo a través de Brevo.');
    res.json({ success: true, message: 'Informe enviado.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 🔥 9. OBTENER PROMEDIO DE UNA CATEGORÍA
// ====================================================================
router.get('/categorias/:categoria_id/promedio', authMiddleware, async (req, res) => {
  try {
    const { categoria_id } = req.params;
    
    // Buscar todos los jugadores de esa categoría
    const { data: rels } = await supabase.from('jugador_categoria').select('jugador_id').eq('categoria_id', categoria_id);
    const jugadorIds = rels.map(r => r.jugador_id);

    if (jugadorIds.length === 0) return res.json({ success: true, data: {} });

    // Buscar la última evaluación de esos jugadores
    const { data: evals } = await supabase.from('evaluaciones').select('jugador_id, datos_radar').in('jugador_id', jugadorIds).order('created_at', { ascending: false });

    const latestEvals = {};
    evals.forEach(ev => { if (!latestEvals[ev.jugador_id]) latestEvals[ev.jugador_id] = ev.datos_radar; });

    // Calcular promedios
    const totals = {};
    const counts = {};
    Object.values(latestEvals).forEach(radar => {
      Object.entries(radar).forEach(([skill, val]) => {
        totals[skill] = (totals[skill] || 0) + val;
        counts[skill] = (counts[skill] || 0) + 1;
      });
    });

    const promedio = {};
    Object.keys(totals).forEach(skill => { promedio[skill] = Math.round(totals[skill] / counts[skill]); });

    res.json({ success: true, data: promedio });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 🔥 10. ACTUALIZACIÓN RÁPIDA (SEMÁFOROS E INSIGNIAS CON WHATSAPP)
// ====================================================================
router.put('/:jugador_id/datos-rapidos', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugador_id } = req.params;
    const { estado_financiero, alerta_medica, insignias } = req.body;
    
    const updateData = {};
    if (estado_financiero !== undefined) updateData.estado_financiero = estado_financiero;
    if (alerta_medica !== undefined) updateData.alerta_medica = alerta_medica;
    
    // Si vienen insignias, verificamos si es una NUEVA insignia para avisar por WhatsApp
    let nuevaInsigniaDetectada = null;
    if (insignias !== undefined) {
      updateData.insignias = insignias;
      
      // Obtenemos el jugador actual para ver si se sumó una insignia
      const { data: jugadorAntiguo } = await supabase.from('jugadores').select('insignias, nombre, tutor_id').eq('id', jugador_id).single();
      
      const cantidadAntes = jugadorAntiguo.insignias ? jugadorAntiguo.insignias.length : 0;
      if (insignias.length > cantidadAntes) {
        // La primera de la lista es la más reciente (según el frontend)
        nuevaInsigniaDetectada = insignias[0]; 
      }
    }

    // Actualizamos la base de datos
    const { data, error } = await supabase.from('jugadores').update(updateData).eq('id', jugador_id).select().single();
    if (error) throw error;

    // Si hubo una nueva insignia, buscamos al tutor y disparamos el WhatsApp de forma asíncrona
    if (nuevaInsigniaDetectada) {
      supabase.from('tutores').select('telefono, nombre_completo').eq('id', data.tutor_id).single()
        .then(({ data: tutor }) => {
          if (tutor && tutor.telefono) {
            const mensaje = `🏆 *¡Noticia desde la Academia!*\n\nHola ${tutor.nombre_completo},\nNos llena de orgullo informarte que hoy el cuerpo técnico le ha otorgado a *${data.nombre}* el siguiente reconocimiento:\n\n🌟 *${nuevaInsigniaDetectada.nombre}*\n\n¡Sigan apoyando su crecimiento deportivo! ⚽💪`;
            
            enviarWhatsApp(academia_id, tutor.telefono, mensaje);
          }
        })
        .catch(err => console.error('Error buscando tutor para WS:', err));
    }
    
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
