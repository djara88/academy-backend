// routes/entrenamientos.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarMensaje } = require('../services/whatsappService');

// ====================================================================
// 1. REGISTRAR UN ENTRENAMIENTO Y SU LISTA DE ASISTENCIA
// ====================================================================
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { categoria_id, fecha, hora, estado, es_recuperacion, motivo_cancelacion, lista_asistencia } = req.body;

    if (!fecha || !categoria_id) {
      return res.status(400).json({ success: false, error: 'Falta la fecha o la categoría.' });
    }

    // Insertar entrenamiento
    const { data: ent, error: errEnt } = await supabase
      .from('entrenamientos')
      .insert([{
        academia_id,
        categoria_id,
        fecha,
        hora: hora || '17:00',
        estado: estado || 'Realizado',
        es_recuperacion: es_recuperacion || false,
        motivo_cancelacion: motivo_cancelacion || ''
      }])
      .select()
      .single();

    if (errEnt) {
      console.error('❌ Error insertando entrenamiento:', errEnt);
      throw errEnt;
    }

    // Si la clase se realizó, guardamos la asistencia individual
    if (estado === 'Realizado' && lista_asistencia && lista_asistencia.length > 0) {
      const records = lista_asistencia.map(a => ({
        entrenamiento_id: ent.id,
        jugador_id: a.jugador_id,
        estado: a.estado || 'Presente'
      }));

      const { error: errAsist } = await supabase
        .from('asistencias')
        .upsert(records, { onConflict: 'entrenamiento_id, jugador_id' });

      if (errAsist) {
        console.error('❌ Error guardando asistencias:', errAsist);
        throw errAsist;
      }
    }

    res.json({ success: true, data: ent });
  } catch (error) {
    console.error('❌ Error en POST /api/entrenamientos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 2. OBTENER MÉTRICAS Y GRÁFICOS DEL MES (CORREGIDO PARA DATE)
// ====================================================================
router.get('/metricas', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { mes, anio } = req.query; // Ej: mes=08, anio=2026

    const mesStr = String(mes || '01').padStart(2, '0');
    const anioStr = String(anio || '2026');

    // Rango de fechas para consulta SQL segura en columna DATE
    const fechaInicio = `${anioStr}-${mesStr}-01`;
    const fechaFin = `${anioStr}-${mesStr}-31`;

    // 1. Obtener entrenamientos del mes
    const { data: entrenamientos, error: errEnt } = await supabase
      .from('entrenamientos')
      .select('*, categorias(nombre)')
      .eq('academia_id', academia_id)
      .gte('fecha', fechaInicio)
      .lte('fecha', fechaFin);

    if (errEnt) {
      console.error('❌ Error consultando entrenamientos en métricas:', errEnt);
      throw errEnt;
    }

    const listaEntrenamientos = entrenamientos || [];
    const entIds = listaEntrenamientos.map(e => e.id);

    let totalPresentes = 0;
    let totalAusentes = 0;
    let totalJustificados = 0;

    if (entIds.length > 0) {
      const { data: asistencias, error: errAsist } = await supabase
        .from('asistencias')
        .select('estado')
        .in('entrenamiento_id', entIds);

      if (!errAsist && asistencias) {
        totalPresentes = asistencias.filter(a => a.estado === 'Presente').length;
        totalAusentes = asistencias.filter(a => a.estado === 'Ausente').length;
        totalJustificados = asistencias.filter(a => a.estado === 'Justificado').length;
      }
    }

    const totalClases = listaEntrenamientos.length;
    const canceladas = listaEntrenamientos.filter(e => e.estado === 'Cancelado').length;
    const recuperativas = listaEntrenamientos.filter(e => e.es_recuperacion).length;

    const totalRegistros = totalPresentes + totalAusentes + totalJustificados;
    const porcentajeGlobal = totalRegistros > 0 ? Math.round((totalPresentes / totalRegistros) * 100) : 0;

    res.json({
      success: true,
      data: {
        resumen: { totalClases, canceladas, recuperativas, porcentajeGlobal },
        desglose: { presentes: totalPresentes, ausentes: totalAusentes, justificados: totalJustificados }
      }
    });
  } catch (error) {
    console.error('❌ Error crítico en GET /api/entrenamientos/metricas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 3. ENVIAR REPORTE MENSUAL A APODERADOS POR WHATSAPP
// ====================================================================
router.post('/reporte-mensual', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { categoria_id, mes, anio } = req.body;

    const mesStr = String(mes || '01').padStart(2, '0');
    const anioStr = String(anio || '2026');

    const fechaInicio = `${anioStr}-${mesStr}-01`;
    const fechaFin = `${anioStr}-${mesStr}-31`;

    // 1. Obtener clases del mes
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

    // 2. Obtener asistencias
    const { data: asistencias, error: errAsist } = await supabase
      .from('asistencias')
      .select('jugador_id, estado, jugadores(nombre, tutor_id, telefono)')
      .in('entrenamiento_id', entIds);

    if (errAsist) throw errAsist;

    // 3. Agrupar conteo por alumno
    const reportePorJugador = {};
    (asistencias || []).forEach(a => {
      if (!a.jugadores) return;
      if (!reportePorJugador[a.jugador_id]) {
        reportePorJugador[a.jugador_id] = { 
          nombre: a.jugadores.nombre, 
          tutor_id: a.jugadores.tutor_id, 
          telefono: a.jugadores.telefono,
          presentes: 0, ausentes: 0, justificados: 0 
        };
      }
      if (a.estado === 'Presente') reportePorJugador[a.jugador_id].presentes++;
      if (a.estado === 'Ausente') reportePorJugador[a.jugador_id].ausentes++;
      if (a.estado === 'Justificado') reportePorJugador[a.jugador_id].justificados++;
    });

    const mesesTexto = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
    const mesNombre = mesesTexto[parseInt(mesStr, 10) - 1] || 'Mes';

    // 4. Enviar notificaciones
    let enviados = 0;
    for (const jId in reportePorJugador) {
      const data = reportePorJugador[jId];
      const total = data.presentes + data.ausentes + data.justificados;
      const porcentaje = total > 0 ? Math.round((data.presentes / total) * 100) : 0;
      
      let mensajeExtra = porcentaje >= 80 ? '🌟 ¡Excelente compromiso!' : '💪 ¡Vamos por más asistencia el próximo mes!';

      let telefonoFinal = data.telefono;
      let nombreTutor = 'apoderado';

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
