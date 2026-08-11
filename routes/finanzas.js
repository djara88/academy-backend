// routes/finanzas.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

// ====================================================================
// 1. OBTENER RESUMEN EJECUTIVO / KPIS GENERALES
// ====================================================================
router.get('/resumen', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;

    const [resCobros, resEgresos, resJugadores] = await Promise.all([
      supabase.from('cobros').select('*').eq('academia_id', academia_id),
      supabase.from('egresos').select('*').eq('academia_id', academia_id),
      supabase.from('jugadores').select('id, nombre, estado_financiero').eq('academia_id', academia_id)
    ]);

    const cobros = resCobros.data || [];
    const egresos = resEgresos.data || [];
    const jugadores = resJugadores.data || [];

    let totalIngresosReales = 0;
    let totalPorCobrar = 0;
    let totalEgresos = 0;

    cobros.forEach(c => {
      totalIngresosReales += Number(c.monto_pagado || 0);
      if (c.estado !== 'Pagado' && c.estado !== 'Anulado') {
        totalPorCobrar += (Number(c.monto || 0) - Number(c.monto_pagado || 0));
      }
    });

    egresos.forEach(e => {
      totalEgresos += Number(e.monto || 0);
    });

    const balanceNeto = totalIngresosReales - totalEgresos;
    const morosos = jugadores.filter(j => j.estado_financiero === 'Moroso').length;
    const tasaMorosidad = jugadores.length > 0 ? ((morosos / jugadores.length) * 100).toFixed(1) : 0;

    res.json({
      success: true,
      data: {
        totalIngresosReales,
        totalPorCobrar,
        totalEgresos,
        balanceNeto,
        totalAlumnos: jugadores.length,
        alumnosMorosos: morosos,
        tasaMorosidad: Number(tasaMorosidad)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 2. CUENTAS CORRIENTES (AUTO-SINCRONIZACIÓN INDIVIDUAL DE ALUMNOS) 🔥
// ====================================================================
router.get('/cuentas-corrientes', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;

    const [resJugadores, resCobros] = await Promise.all([
      supabase.from('jugadores').select('id, nombre, foto_base64, estado_financiero, monto_matricula, abono_matricula, monto_mensualidad, tutor_id, tutores(nombre_completo, telefono)').eq('academia_id', academia_id).order('nombre', { ascending: true }),
      supabase.from('cobros').select('*').eq('academia_id', academia_id).order('fecha_vencimiento', { ascending: false })
    ]);

    const jugadores = resJugadores.data || [];
    let cobros = resCobros.data || [];

    // AUTO-SINCRONIZACIÓN ESPECÍFICA POR CONCEPTO
    const cobrosFaltantes = [];
    for (const jug of jugadores) {
      const susCobros = cobros.filter(c => c.jugador_id === jug.id);
      
      const tieneMatricula = susCobros.some(c => c.tipo_concepto === 'Matrícula' || (c.concepto && c.concepto.toLowerCase().includes('matrícula')));
      const tieneMensualidad = susCobros.some(c => c.tipo_concepto === 'Mensualidad' || (c.concepto && c.concepto.toLowerCase().includes('mensualidad')));

      const valMatricula = Number(jug.monto_matricula) || 0;
      const abonoMatricula = Number(jug.abono_matricula) || 0;
      const valMensualidad = Number(jug.monto_mensualidad) || 0;

      // Si no tiene el cobro de Matrícula y en su perfil hay monto registrado
      if (!tieneMatricula && valMatricula > 0) {
        cobrosFaltantes.push({
          academia_id,
          jugador_id: jug.id,
          concepto: 'Matrícula Inicial',
          tipo_concepto: 'Matrícula',
          monto: valMatricula,
          monto_pagado: abonoMatricula,
          estado: abonoMatricula >= valMatricula ? 'Pagado' : abonoMatricula > 0 ? 'Parcial' : 'Pendiente',
          fecha_vencimiento: new Date().toISOString().split('T')[0]
        });
      }

      // Si no tiene el cobro de Mensualidad y en su perfil hay monto registrado
      if (!tieneMensualidad && valMensualidad > 0) {
        cobrosFaltantes.push({
          academia_id,
          jugador_id: jug.id,
          concepto: 'Mensualidad Inicial',
          tipo_concepto: 'Mensualidad',
          monto: valMensualidad,
          monto_pagado: 0,
          estado: 'Pendiente',
          fecha_vencimiento: new Date().toISOString().split('T')[0]
        });
      }
    }

    if (cobrosFaltantes.length > 0) {
      await supabase.from('cobros').insert(cobrosFaltantes);
      const { data: cobrosRecargados } = await supabase.from('cobros').select('*').eq('academia_id', academia_id).order('fecha_vencimiento', { ascending: false });
      if (cobrosRecargados) cobros = cobrosRecargados;
    }

    const cuentas = jugadores.map(j => {
      const misCobros = cobros.filter(c => c.jugador_id === j.id);
      let deudaTotal = 0;
      let pagadoTotal = 0;

      misCobros.forEach(c => {
        if (c.estado !== 'Anulado') {
          deudaTotal += Number(c.monto || 0);
          pagadoTotal += Number(c.monto_pagado || 0);
        }
      });

      const saldoPendiente = deudaTotal - pagadoTotal;

      return {
        ...j,
        cobros: misCobros,
        deudaTotal,
        pagadoTotal,
        saldoPendiente,
        alDia: saldoPendiente <= 0
      };
    });

    res.json({ success: true, data: cuentas });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 3. REGISTRAR O ABONAR PAGO DE UN COBRO
// ====================================================================
router.put('/cobros/:id/pagar', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { monto_abono, metodo_pago, observaciones } = req.body;

    const { data: cobroActual, error: errFetch } = await supabase.from('cobros').select('*').eq('id', id).single();
    if (errFetch || !cobroActual) throw new Error('Cobro no encontrado.');

    const nuevoMontoPagado = Number(cobroActual.monto_pagado || 0) + Number(monto_abono || 0);
    const montoTotal = Number(cobroActual.monto || 0);

    let nuevoEstado = 'Parcial';
    if (nuevoMontoPagado >= montoTotal) {
      nuevoEstado = 'Pagado';
    }

    const { data: cobroActualizado, error: errUpd } = await supabase
      .from('cobros')
      .update({
        monto_pagado: nuevoMontoPagado,
        estado: nuevoEstado,
        metodo_pago: metodo_pago || cobroActual.metodo_pago,
        fecha_pago: new Date().toISOString(),
        observaciones: observaciones ? `${cobroActual.observaciones || ''} | Abono: ${observaciones}` : cobroActual.observaciones
      })
      .eq('id', id)
      .select()
      .single();

    if (errUpd) throw errUpd;

    if (cobroActual.jugador_id) {
      const { data: pend } = await supabase
        .from('cobros')
        .select('monto, monto_pagado')
        .eq('jugador_id', cobroActual.jugador_id)
        .in('estado', ['Pendiente', 'Parcial']);

      const tieneDeudaVencida = (pend || []).some(c => (Number(c.monto) - Number(c.monto_pagado)) > 0);
      await supabase
        .from('jugadores')
        .update({ estado_financiero: tieneDeudaVencida ? 'Moroso' : 'Al Día' })
        .eq('id', cobroActual.jugador_id);
    }

    res.json({ success: true, data: cobroActualizado });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 4. CREAR COBRO MANUAL A ALUMNO
// ====================================================================
router.post('/cobros', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugador_id, concepto, tipo_concepto, monto, fecha_vencimiento, observaciones } = req.body;

    const { data, error } = await supabase
      .from('cobros')
      .insert([{
        academia_id,
        jugador_id,
        concepto,
        tipo_concepto: tipo_concepto || 'Mensualidad',
        monto: Number(monto) || 0,
        monto_pagado: 0,
        estado: 'Pendiente',
        fecha_vencimiento: fecha_vencimiento || new Date().toISOString().split('T')[0],
        observaciones
      }])
      .select()
      .single();

    if (error) throw error;

    if (jugador_id) {
      await supabase.from('jugadores').update({ estado_financiero: 'Moroso' }).eq('id', jugador_id);
    }

    res.status(201).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 5. REGISTRAR Y OBTENER EGRESOS
// ====================================================================
router.get('/egresos', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { data, error } = await supabase
      .from('egresos')
      .select('*')
      .eq('academia_id', academia_id)
      .order('fecha_gasto', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/egresos', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { concepto, categoria_gasto, centro_costo, monto, metodo_pago, fecha_gasto, observaciones } = req.body;

    const { data, error } = await supabase
      .from('egresos')
      .insert([{
        academia_id,
        concepto,
        categoria_gasto: categoria_gasto || 'Otros',
        centro_costo: centro_costo || 'General',
        monto: Number(monto) || 0,
        metodo_pago: metodo_pago || 'Transferencia',
        fecha_gasto: fecha_gasto || new Date().toISOString().split('T')[0],
        observaciones
      }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/egresos/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('egresos').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true, message: 'Egreso eliminado correctamente.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 6. FLUJO DE CAJA UNIFICADO
// ====================================================================
router.get('/flujo-caja', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;

    const [resCobros, resEgresos] = await Promise.all([
      supabase.from('cobros').select('id, concepto, monto_pagado, fecha_pago, metodo_pago, jugadores(nombre)').eq('academia_id', academia_id).gt('monto_pagado', 0),
      supabase.from('egresos').select('id, concepto, monto, fecha_gasto, metodo_pago, categoria_gasto, centro_costo').eq('academia_id', academia_id)
    ]);

    const ingresos = (resCobros.data || []).map(c => ({
      id: c.id,
      tipo: 'Ingreso',
      concepto: `${c.concepto} - Alumno: ${c.jugadores?.nombre || 'General'}`,
      monto: Number(c.monto_pagado),
      fecha: c.fecha_pago,
      metodo: c.metodo_pago,
      categoria: 'Recaudación'
    }));

    const egresos = (resEgresos.data || []).map(e => ({
      id: e.id,
      tipo: 'Egreso',
      concepto: e.concepto,
      monto: Number(e.monto),
      fecha: e.fecha_gasto,
      metodo: e.metodo_pago,
      categoria: `${e.categoria_gasto} (${e.centro_costo})`
    }));

    const flujo = [...ingresos, ...egresos].sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());

    res.json({ success: true, data: flujo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
