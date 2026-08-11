// routes/jugadores.js
require('dotenv').config();
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarMensaje } = require('../services/whatsappService');

// ====================================================================
// 1. OBTENER JUGADORES (CON ESTADÍSTICAS Y CATEGORÍAS)
// ====================================================================
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    
    // 1. Consultar jugadores con categorías y estadísticas de partidos
    const { data: jugadores, error: errJugadores } = await supabase
      .from('jugadores')
      .select(`
        *,
        jugador_categoria ( categorias ( id, nombre ) ),
        partido_estadisticas ( goles, asistencias, tarjetas_amarillas, tarjetas_rojas, es_mvp )
      `)
      .eq('academia_id', academia_id)
      .order('created_at', { ascending: false });

    if (errJugadores) throw errJugadores;

    const jugadorIds = (jugadores || []).map(j => j.id);

    // 2. Consultar asistencias a entrenamientos
    let asistenciasMap = {};
    if (jugadorIds.length > 0) {
      const { data: asistenciasData, error: errAsist } = await supabase
        .from('asistencias')
        .select('jugador_id, estado')
        .in('jugador_id', jugadorIds);

      if (!errAsist && asistenciasData) {
        asistenciasData.forEach(a => {
          if (!asistenciasMap[a.jugador_id]) asistenciasMap[a.jugador_id] = [];
          asistenciasMap[a.jugador_id].push(a.estado);
        });
      }
    }

    // 3. Formatear los resultados acumulados
    const jugadoresFormateados = (jugadores || []).map(jugador => {
      const statsPartidos = jugador.partido_estadisticas || [];
      const estadosAsistencia = asistenciasMap[jugador.id] || [];
      
      const totalGoles = statsPartidos.reduce((acc, curr) => acc + (curr.goles || 0), 0);
      const totalAsistencias = statsPartidos.reduce((acc, curr) => acc + (curr.asistencias || 0), 0);
      const totalAmarillas = statsPartidos.reduce((acc, curr) => acc + (curr.tarjetas_amarillas || 0), 0);
      const totalRojas = statsPartidos.reduce((acc, curr) => acc + (curr.tarjetas_rojas || 0), 0);
      const totalMvp = statsPartidos.filter(s => s.es_mvp).length;
      const partidosJugados = statsPartidos.length;

      const clasesAusente = estadosAsistencia.filter(e => e === 'Ausente').length;
      const clasesPresente = estadosAsistencia.filter(e => e === 'Presente').length;
      const clasesJustificadas = estadosAsistencia.filter(e => e === 'Justificado').length;

      return {
        ...jugador,
        categorias: jugador.jugador_categoria ? jugador.jugador_categoria.map(jc => jc.categorias).filter(Boolean) : [],
        insignias: jugador.insignias || [],
        
        estadisticas_acumuladas: {
          partidos_jugados: partidosJugados,
          goles: totalGoles,
          asistencias: totalAsistencias,
          mvp: totalMvp,
          tarjetas_amarillas: totalAmarillas,
          tarjetas_rojas: totalRojas,
          clases_ausente: clasesAusente,
          clases_presente: clasesPresente,
          clases_justificadas: clasesJustificadas
        }
      };
    });

    res.json({ success: true, data: jugadoresFormateados });
  } catch (error) {
    console.error('❌ Error al obtener jugadores:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 2. CREAR JUGADORES + TUTOR + EVALUACIÓN INICIAL + VÍNCULO DE UNIFORME
// ====================================================================
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { 
      tutor, nombre, rut, tipo_alumno, certificado_medico, sexo, fecha_nacimiento, posicion_cancha, 
      talla_uniforme, talla_apoderado, numero_camiseta, nombre_camiseta, 
      monto_matricula, abono_matricula, monto_mensualidad, foto_base64, evaluacion,
      prenda_id, prenda_nombre, prenda_monto, prenda_estado_pago, generar_cobro_prenda
    } = req.body;

    // A. Gestión / Creación de Tutor
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

    // B. Creación de Jugador
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

    // C. Evaluación Inicial (si aplica)
    if (evaluacion && Object.keys(evaluacion).length > 0) {
      await supabase.from('evaluaciones').insert([{
        jugador_id: newJugador.id,
        academia_id,
        datos_radar: evaluacion,
        comentarios_profesor: 'Evaluación inicial generada durante la matrícula.'
      }]);
    }

    // D. REGISTRO AUTOMÁTICO DE UNIFORME / PEDIDO
    
    // 1. Pedido del Alumno
    if (prenda_nombre || prenda_id || talla_uniforme) {
      try {
        const nombrePrendaFinal = prenda_nombre || 'Kit de Matrícula (Alumno)';
        const estadoPagoFinal = prenda_estado_pago || 'Incluido en Matrícula';
        const precioPrenda = Number(prenda_monto) || 0;
        let cobroId = null;

        if (estadoPagoFinal === 'Pendiente de Pago' && precioPrenda > 0 && generar_cobro_prenda) {
          const { data: cobroCreado } = await supabase.from('cobros').insert([{
              academia_id, jugador_id: newJugador.id, concepto: `Indumentaria: ${nombrePrendaFinal} (Talla ${talla_uniforme || 'S/T'})`,
              tipo_concepto: 'Indumentaria', monto: precioPrenda, monto_pagado: 0, estado: 'Pendiente', fecha_vencimiento: new Date().toISOString().split('T')[0]
            }]).select().single();
          if (cobroCreado) cobroId = cobroCreado.id;
        }

        await supabase.from('pedidos_indumentaria').insert([{
          academia_id, jugador_id: newJugador.id, prenda_id: prenda_id || null, prenda_nombre: nombrePrendaFinal,
          talla: talla_uniforme || 'S/T', numero_estampado: numero_camiseta ? parseInt(numero_camiseta) : null,
          nombre_estampado: nombre_camiseta || '', monto: precioPrenda, cobro_id: cobroId,
          estado_pago: estadoPagoFinal, estado_entrega: 'Pendiente'
        }]);

        if (prenda_id) {
          const { data: prendaData } = await supabase.from('prendas_catalogo').select('tipo_operacion, stock_disponible').eq('id', prenda_id).single();
          if (prendaData && prendaData.tipo_operacion === 'Stock' && prendaData.stock_disponible > 0) {
            await supabase.from('prendas_catalogo').update({ stock_disponible: prendaData.stock_disponible - 1 }).eq('id', prenda_id);
          }
        }
      } catch (errUniforme) {
        console.error('⚠️ Detalle registrando la indumentaria del alumno:', errUniforme.message);
      }
    }

    // 2. Pedido del Apoderado (Camiseta Apoderado)
    if (talla_apoderado) {
      try {
        await supabase.from('pedidos_indumentaria').insert([{
          academia_id, 
          jugador_id: newJugador.id,
          prenda_id: null,
          prenda_nombre: 'Camiseta Apoderado',
          talla: talla_apoderado,
          numero_estampado: null,
          nombre_estampado: '',
          monto: 0,
          cobro_id: null,
          estado_pago: 'Incluido en Matrícula',
          estado_entrega: 'Pendiente'
        }]);
      } catch (errApoderado) {
        console.error('⚠️ Detalle registrando indumentaria del apoderado:', errApoderado.message);
      }
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
// 9. OBTENER PROMEDIO DE UNA CATEGORÍA
// ====================================================================
router.get('/categorias/:categoria_id/promedio', authMiddleware, async (req, res) => {
  try {
    const { categoria_id } = req.params;
    
    const { data: rels } = await supabase.from('jugador_categoria').select('jugador_id').eq('categoria_id', categoria_id);
    const jugadorIds = rels.map(r => r.jugador_id);

    if (jugadorIds.length === 0) return res.json({ success: true, data: {} });

    const { data: evals } = await supabase.from('evaluaciones').select('jugador_id, datos_radar').in('jugador_id', jugadorIds).order('created_at', { ascending: false });

    const latestEvals = {};
    evals.forEach(ev => { if (!latestEvals[ev.jugador_id]) latestEvals[ev.jugador_id] = ev.datos_radar; });

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
// 10. ACTUALIZACIÓN RÁPIDA (SEMÁFOROS E INSIGNIAS CON WHATSAPP AUTOMÁTICO)
// ====================================================================
router.put('/:jugador_id/datos-rapidos', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugador_id } = req.params;
    const { estado_financiero, alerta_medica, insignias } = req.body;
    
    const updateData = {};
    if (estado_financiero !== undefined) updateData.estado_financiero = estado_financiero;
    if (alerta_medica !== undefined) updateData.alerta_medica = alerta_medica;
    
    let nuevaInsigniaDetectada = null;
    if (insignias !== undefined) {
      updateData.insignias = insignias;
      
      const { data: jugadorAntiguo } = await supabase.from('jugadores').select('insignias').eq('id', jugador_id).single();
      
      const cantidadAntes = jugadorAntiguo?.insignias ? jugadorAntiguo.insignias.length : 0;
      if (insignias.length > cantidadAntes) {
        nuevaInsigniaDetectada = insignias[0]; 
      }
    }

    const { data, error } = await supabase.from('jugadores').update(updateData).eq('id', jugador_id).select().single();
    if (error) throw error;

    if (nuevaInsigniaDetectada && data?.tutor_id) {
      supabase.from('tutores').select('telefono, nombre_completo').eq('id', data.tutor_id).single()
        .then(({ data: tutor }) => {
          if (tutor && tutor.telefono) {
            const telefonoLimpio = tutor.telefono.replace(/\D/g, '');
            const nombreInsignia = nuevaInsigniaDetectada.nombre || nuevaInsigniaDetectada;
            
            const mensaje = `🏆 *¡Noticia desde la Academia!*\n\nHola ${tutor.nombre_completo},\nNos llena de orgullo informarte que hoy el cuerpo técnico le ha otorgado a *${data.nombre}* el siguiente reconocimiento:\n\n🌟 *${nombreInsignia}*\n\n¡Sigan apoyando su crecimiento deportivo! ⚽💪`;
            
            enviarMensaje(academia_id, telefonoLimpio, mensaje)
              .then(() => console.log(`✅ WhatsApp de reconocimiento enviado al apoderado de ${data.nombre}`))
              .catch(err => console.error('❌ Error al enviar mensaje de WhatsApp:', err.message));
          }
        })
        .catch(err => console.error('❌ Error al buscar tutor para WhatsApp:', err.message));
    }
    
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
