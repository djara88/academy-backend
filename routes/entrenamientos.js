// routes/entrenamientos.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarMensaje } = require('../services/whatsappService');

// 1. REGISTRAR UN ENTRENAMIENTO Y SU LISTA DE ASISTENCIA
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { categoria_id, fecha, hora, lugar, estado, es_recuperacion, motivo_cancelacion, clase_recuperada_id, lista_asistencia } = req.body;

    if (!fecha || !categoria_id) {
      return res.status(400).json({ success: false, error: 'Falta la fecha o la categoría.' });
    }

    const { data: ent, error: errEnt } = await supabase
      .from('entrenamientos')
      .insert([{
        academia_id,
        categoria_id,
        fecha,
        hora: hora || '17:00',
        lugar: lugar || '',
        estado: estado || 'Realizado',
        es_recuperacion: es_recuperacion || false,
        motivo_cancelacion: motivo_cancelacion || '',
        clase_recuperada_id: clase_recuperada_id || null
      }])
      .select()
      .single();

    if (errEnt) throw errEnt;

    if (estado === 'Realizado' && lista_asistencia && lista_asistencia.length > 0) {
      const records = lista_asistencia.map(a => ({
        entrenamiento_id: ent.id,
        jugador_id: a.jugador_id,
        estado: a.estado || 'Presente'
      }));

      const { error: errAsist } = await supabase
        .from('asistencias')
        .upsert(records, { onConflict: 'entrenamiento_id, jugador_id' });

      if (errAsist) throw errAsist;
    }

    res.json({ success: true, data: ent });
  } catch (error) {
    console.error('❌ Error en POST /api/entrenamientos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. OBTENER CLASES SUSPENDIDAS PENDIENTES DE RECUPERACIÓN
router.get('/suspendidas', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { data, error } = await supabase
      .from('entrenamientos')
      .select('*, categorias(nombre)')
      .eq('academia_id', academia_id)
      .eq('estado', 'Cancelado')
      .order('fecha', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. REAGENDAR Y NOTIFICAR CLASE DE RECUPERACIÓN POR WHATSAPP 🔥
router.post('/reagendar-notificar', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { categoria_id, fecha, hora, lugar, clase_cancelada_id, motivo_original } = req.body;

    if (!categoria_id || !fecha || !hora) {
      return res.status(400).json({ success: false, error: 'Faltan datos requeridos (categoría, fecha o hora).' });
    }

    // A. Registrar la nueva clase de recuperación
    const { data: entRecuperacion, error: errEnt } = await supabase
      .from('entrenamientos')
      .insert([{
        academia_id,
        categoria_id,
        fecha,
        hora,
        lugar: lugar || '',
        estado: 'Programado',
        es_recuperacion: true,
        clase_recuperada_id: clase_cancelada_id || null
      }])
      .select('*, categorias(nombre)')
      .single();

    if (errEnt) throw errEnt;

    // B. Obtener los apoderados de los jugadores de esta categoría
    const { data: rels } = await supabase
      .from('jugador_categoria')
      .select('jugador_id')
      .eq('categoria_id', categoria_id);

    const jugadorIds = (rels || []).map(r => r.jugador_id);

    let enviados = 0;
    if (jugadorIds.length > 0) {
      const { data: jugadores } = await supabase
        .from('jugadores')
        .select('nombre, tutor_id')
        .in('id', jugadorIds);

      const tutorIds = (jugadores || []).map(j => j.tutor_id).filter(Boolean);

      if (tutorIds.length > 0) {
        const { data: tutores } = await supabase
          .from('tutores')
          .select('telefono, nombre_completo')
          .in('id', tutorIds);

        const fechaFormateada = new Date(fecha + 'T00:00:00').toLocaleDateString('es-CL', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
        });

        for (const tutor of (tutores || [])) {
          if (tutor.telefono) {
            let numLimpio = tutor.telefono.replace(/\D/g, '');
            if (!numLimpio.startsWith('56') && numLimpio.length === 9) numLimpio = '56' + numLimpio;

            const mensaje = `📢 *CITACIÓN A CLASE DE RECUPERACIÓN*\n\n` +
              `Hola ${tutor.nombre_completo || 'Apoderado'},\n` +
              `Te informamos que la clase suspendida (${motivo_original || 'Sustitución'}) de la categoría *${entRecuperacion.categorias?.nombre || ''}* ha sido reagendada:\n\n` +
              `📅 *Fecha:* ${fechaFormateada}\n` +
              `⏰ *Hora:* ${hora} hrs\n` +
              `📍 *Lugar:* ${lugar || 'Cancha Principal'}\n\n` +
              `¡Contamos con la asistencia de tu hijo/a! ⚽💪`;

            try {
              await enviarMensaje(academia_id, numLimpio, mensaje);
              enviados++;
            } catch (errWs) {
              console.error(`Error enviando notificación a ${numLimpio}:`, errWs.message);
            }
          }
        }
      }
    }

    res.json({ success: true, message: `Clase de recuperación programada y notificada a ${enviados} apoderados.`, data: entRecuperacion });
  } catch (error) {
    console.error('❌ Error reagendando clase:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. OBTENER MÉTRICAS Y GRÁFICOS DEL MES
router.get('/metricas', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { mes, anio } = req.query; 

    const mesStr = String(mes || new Date().getMonth() + 1).padStart(2, '0');
    const anioStr = String(anio || new Date().getFullYear());

    const fechaInicio = `${anioStr}-${mesStr}-01`;
    const fechaFin = `${anioStr}-${mesStr}-31`;

    const { data: entrenamientos, error: errEnt } = await supabase
      .from('entrenamientos')
      .select('*, categorias(nombre)')
      .eq('academia_id', academia_id)
      .gte('fecha', fechaInicio)
      .lte('fecha', fechaFin);

    if (errEnt) throw errEnt;

    const listaEntrenamientos = entrenamientos || [];
    const entIds = listaEntrenamientos.map(e => e.id);

    let totalPresentes = 0, totalAusentes = 0, totalJustificados = 0;
    const catStats = {};
    const jugStats = {};

    const entMap = {};
    listaEntrenamientos.forEach(e => {
      entMap[e.id] = { catId: e.categoria_id, catNombre: e.categorias?.nombre || 'General' };
    });

    if (entIds.length > 0) {
      const { data: asistencias, error: errAsist } = await supabase
        .from('asistencias')
        .select('estado, jugador_id, jugadores(nombre), entrenamiento_id')
        .in('entrenamiento_id', entIds);

      if (!errAsist && asistencias) {
        asistencias.forEach(a => {
          if (a.estado === 'Presente') totalPresentes++;
          if (a.estado === 'Ausente') totalAusentes++;
          if (a.estado === 'Justificado') totalJustificados++;

          const cat = entMap[a.entrenamiento_id];
          if (cat) {
            if (!catStats[cat.catId]) catStats[cat.catId] = { nombre: cat.catNombre, presentes: 0, total: 0 };
            catStats[cat.catId].total++;
            if (a.estado === 'Presente') catStats[cat.catId].presentes++;
          }

          if (a.jugadores) {
            if (!jugStats[a.jugador_id]) jugStats[a.jugador_id] = { nombre: a.jugadores.nombre, presentes: 0, total: 0 };
            jugStats[a.jugador_id].total++;
            if (a.estado === 'Presente') jugStats[a.jugador_id].presentes++;
          }
        });
      }
    }

    const totalClases = listaEntrenamientos.length;
    const canceladas = listaEntrenamientos.filter(e => e.estado === 'Cancelado').length;
    const recuperativas = listaEntrenamientos.filter(e => e.es_recuperacion).length;

    const totalRegistros = totalPresentes + totalAusentes + totalJustificados;
    const porcentajeGlobal = totalRegistros > 0 ? Math.round((totalPresentes / totalRegistros) * 100) : 0;

    const categoriasArr = Object.values(catStats).map(c => ({
      nombre: c.nombre,
      porcentaje: c.total > 0 ? Math.round((c.presentes / c.total) * 100) : 0
    })).sort((a, b) => b.porcentaje - a.porcentaje);

    const jugadoresArr = Object.values(jugStats).map(j => ({
      nombre: j.nombre,
      porcentaje: j.total > 0 ? Math.round((j.presentes / j.total) * 100) : 0,
      presentes: j.presentes,
      total: j.total
    })).sort((a, b) => b.porcentaje - a.porcentaje);

    res.json({
      success: true,
      data: {
        global: { totalClases, canceladas, recuperativas, porcentajeGlobal, totalPresentes, totalAusentes, totalJustificados },
        categorias: categoriasArr,
        jugadores: jugadoresArr
      }
    });
  } catch (error) {
    console.error('❌ Error crítico en GET /api/entrenamientos/metricas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. ENVIAR REPORTE MENSUAL A APODERADOS POR WHATSAPP
router.post('/reporte-mensual', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { categoria_id, mes, anio } = req.body;

    const mesStr = String(mes || '01').padStart(2, '0');
    const anioStr = String(anio || '2026');

    const fechaInicio = `${anioStr}-${mesStr}-01`;
    const fechaFin = `${anioStr}-${mesStr}-31`;

    const { data: entrenamientos, error: errEnt } = await supabase
      .from('entrenamientos')
      .select('id')
      .eq('categoria_id', categoria_id)
      .eq('estado', 'Realizado')
      .gte('fecha', fechaInicio)
      .lte('fecha', fechaFin);

    if (errEnt) throw errEnt;

    const entIds = (entrenamientos || []).map(e => e.id);
    if (entIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No hay clases realizadas este mes para esta categoría.' });
    }

    const { data: asistencias, error: errAsist } = await supabase
      .from('asistencias')
      .select('jugador_id, estado, jugadores(nombre, tutor_id)')
      .in('entrenamiento_id', entIds);

    if (errAsist) throw errAsist;

    const reportePorJugador = {};
    (asistencias || []).forEach(a => {
      if (!a.jugadores) return;
      if (!reportePorJugador[a.jugador_id]) {
        reportePorJugador[a.jugador_id] = { 
          nombre: a.jugadores.nombre, 
          tutor_id: a.jugadores.tutor_id, 
          presentes: 0, ausentes: 0, justificados: 0 
        };
      }
      if (a.estado === 'Presente') reportePorJugador[a.jugador_id].presentes++;
      if (a.estado === 'Ausente') reportePorJugador[a.jugador_id].ausentes++;
      if (a.estado === 'Justificado') reportePorJugador[a.jugador_id].justificados++;
    });

    const mesesTexto = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
    const mesNombre = mesesTexto[parseInt(mesStr, 10) - 1] || 'Mes';

    let enviados = 0;
    for (const jId in reportePorJugador) {
      const data = reportePorJugador[jId];
      const total = data.presentes + data.ausentes + data.justificados;
      const porcentaje = total > 0 ? Math.round((data.presentes / total) * 100) : 0;
      
      let mensajeExtra = porcentaje >= 80 ? '🌟 ¡Excelente compromiso!' : '💪 ¡Vamos por más asistencia el próximo mes!';

      let telefonoFinal = null;
      let nombreTutor = 'Apoderado';

      if (data.tutor_id) {
        const { data: tutor } = await supabase.from('tutores').select('telefono, nombre_completo').eq('id', data.tutor_id).single();
        if (tutor) {
          if (tutor.telefono) telefonoFinal = tutor.telefono;
          if (tutor.nombre_completo) nombreTutor = tutor.nombre_completo;
        }
      }

      if (telefonoFinal) {
        let numLimpio = telefonoFinal.replace(/\D/g, '');
        if (!numLimpio.startsWith('56') && numLimpio.length === 9) numLimpio = '56' + numLimpio;

        const mensaje = `📊 *REPORTE DE ASISTENCIA MENSUAL*\n\n` +
          `Hola ${nombreTutor},\n` +
          `Te enviamos el resumen de *${data.nombre}* correspondiente a *${mesNombre} ${anioStr}*:\n\n` +
          `✔️ *Presente:* ${data.presentes} clases\n` +
          `❌ *Ausente:* ${data.ausentes} clases\n` +
          `📝 *Justificado:* ${data.justificados} clases\n\n` +
          `📈 *Asistencia Total: ${porcentaje}%*\n` +
          `${mensajeExtra}\n\n` +
          `¡Gracias por confiar en nuestra academia! ⚽`;

        try {
          await enviarMensaje(academia_id, numLimpio, mensaje);
          enviados++;
        } catch (errWs) {
          console.error(`❌ Error enviando reporte a ${numLimpio}:`, errWs.message);
        }
      }
    }

    res.json({ success: true, message: `Reportes enviados a ${enviados} apoderados.` });
  } catch (error) {
    console.error('❌ Error en POST /api/entrenamientos/reporte-mensual:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
