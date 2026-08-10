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
    const { categoria_id, fecha, hora, estado, es_recuperacion, motivo_cancelacion, lista_asistencia } = req.body;

    // Crear el entrenamiento
    const { data: ent, error: errEnt } = await supabase
      .from('entrenamientos')
      .insert([{ academia_id, categoria_id, fecha, hora, estado, es_recuperacion, motivo_cancelacion }])
      .select().single();

    if (errEnt) throw errEnt;

    // Si la clase se realizó, guardamos la asistencia de cada niño
    if (estado === 'Realizado' && lista_asistencia && lista_asistencia.length > 0) {
      const records = lista_asistencia.map(a => ({
        entrenamiento_id: ent.id,
        jugador_id: a.jugador_id,
        estado: a.estado // Presente, Ausente, Justificado
      }));

      const { error: errAsist } = await supabase.from('asistencias').insert(records);
      if (errAsist) throw errAsist;
    }

    // SI LA CLASE SE CANCELA, AVISAR POR WHATSAPP AL TIRO (Opcional pero recomendado)
    if (estado === 'Cancelado') {
      const { data: rels } = await supabase.from('jugador_categoria').select('jugador_id').eq('categoria_id', categoria_id);
      if (rels && rels.length > 0) {
        const ids = rels.map(r => r.jugador_id);
        const { data: jugadores } = await supabase.from('jugadores').select('nombre, tutor_id, telefono').in('id', ids);
        
        // (Aquí podrías iterar y enviar un aviso de suspensión. Por brevedad, lo dejamos preparado).
      }
    }

    res.json({ success: true, data: ent });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. OBTENER MÉTRICAS Y GRÁFICOS
router.get('/metricas', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { mes, anio } = req.query; // Ej: 08 y 2026

    // Obtener todos los entrenamientos del mes
    const { data: entrenamientos } = await supabase
      .from('entrenamientos')
      .select('*, categorias(nombre)')
      .eq('academia_id', academia_id)
      .like('fecha', `${anio}-${mes}-%`);

    const { data: asistencias } = await supabase
      .from('asistencias')
      .select('*, entrenamientos!inner(academia_id, fecha)')
      .eq('entrenamientos.academia_id', academia_id)
      .like('entrenamientos.fecha', `${anio}-${mes}-%`);

    // Cálculos globales
    const totalClases = entrenamientos.length;
    const canceladas = entrenamientos.filter(e => e.estado === 'Cancelado').length;
    const recuperativas = entrenamientos.filter(e => e.es_recuperacion).length;
    
    const totalPresentes = asistencias.filter(a => a.estado === 'Presente').length;
    const totalAusentes = asistencias.filter(a => a.estado === 'Ausente').length;
    const totalJustificados = asistencias.filter(a => a.estado === 'Justificado').length;

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
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. ENVIAR REPORTE MENSUAL A APODERADOS POR WHATSAPP
router.post('/reporte-mensual', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { categoria_id, mes, anio } = req.body;

    // 1. Obtener entrenamientos del mes para esa categoría
    const { data: entrenamientos } = await supabase
      .from('entrenamientos')
      .select('id')
      .eq('categoria_id', categoria_id)
      .eq('estado', 'Realizado')
      .like('fecha', `${anio}-${mes}-%`);

    const entIds = entrenamientos.map(e => e.id);
    if (entIds.length === 0) return res.status(400).json({ success: false, error: 'No hay clases realizadas este mes.' });

    // 2. Obtener asistencias
    const { data: asistencias } = await supabase
      .from('asistencias')
      .select('jugador_id, estado, jugadores(nombre, tutor_id, telefono)')
      .in('entrenamiento_id', entIds);

    // 3. Agrupar por jugador
    const reportePorJugador = {};
    asistencias.forEach(a => {
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
    const mesNombre = mesesTexto[parseInt(mes) - 1];

    // 4. Enviar WhatsApp
    let enviados = 0;
    for (const jId in reportePorJugador) {
      const data = reportePorJugador[jId];
      const total = data.presentes + data.ausentes + data.justificados;
      const porcentaje = Math.round((data.presentes / total) * 100);
      
      let mensajeExtra = porcentaje >= 80 ? '🌟 ¡Excelente compromiso!' : '💪 ¡Vamos por más asistencia el próximo mes!';

      const { data: tutor } = await supabase.from('tutores').select('telefono, nombre_completo').eq('id', data.tutor_id).single();
      const telefono = tutor?.telefono || data.telefono;

      if (telefono) {
        let numLimpio = telefono.replace(/\D/g, '');
        if (!numLimpio.startsWith('56') && numLimpio.length === 9) numLimpio = '56' + numLimpio;

        const mensaje = `📊 *REPORTE DE ASISTENCIA MENSUAL*\n\n` +
          `Hola ${tutor?.nombre_completo || 'apoderado'},\n` +
          `Te enviamos el resumen de *${data.nombre}* correspondiente a *${mesNombre} ${anio}*:\n\n` +
          `✔️ *Presente:* ${data.presentes} clases\n` +
          `❌ *Ausente:* ${data.ausentes} clases\n` +
          `📝 *Justificado:* ${data.justificados} clases\n\n` +
          `📈 *Asistencia Total: ${porcentaje}%*\n` +
          `${mensajeExtra}\n\n` +
          `Gracias por confiar en nuestra academia. ⚽`;

        await enviarMensaje(academia_id, numLimpio, mensaje);
        enviados++;
      }
    }

    res.json({ success: true, message: `Reportes enviados a ${enviados} apoderados.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
