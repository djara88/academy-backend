const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const {
  ensureMonthlyChargesForAcademy,
  recalculateFinancialStatus,
  summarizeCharges,
  todayInChile,
} = require('../services/monthlyBilling');

const failIfError = (result, context) => {
  if (result.error) throw new Error(`${context}: ${result.error.message}`);
  return result.data ?? null;
};

const rows = (result, context) => failIfError(result, context) || [];
const asMoney = (value) => Number(value || 0);

router.get('/resumen', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const billing = await ensureMonthlyChargesForAcademy(academia_id);
    const [resCobros, resPagos, resEgresos, resJugadores] = await Promise.all([
      supabase.from('cobros').select('jugador_id,monto,monto_pagado,estado,fecha_vencimiento').eq('academia_id', academia_id),
      supabase.from('pagos').select('monto').eq('academia_id', academia_id),
      supabase.from('egresos').select('monto').eq('academia_id', academia_id).is('anulado_at', null),
      supabase.from('jugadores').select('id').eq('academia_id', academia_id)
    ]);

    const cobros = rows(resCobros, 'No se pudieron leer los cobros');
    const pagos = rows(resPagos, 'No se pudieron leer los pagos');
    const egresos = rows(resEgresos, 'No se pudieron leer los egresos');
    const jugadores = rows(resJugadores, 'No se pudieron leer los jugadores');
    const totalIngresosReales = pagos.reduce((total, pago) => total + asMoney(pago.monto), 0);
    const vigentes = cobros.filter((cobro) => !['Pagado', 'Anulado'].includes(cobro.estado));
    const totalPorCobrar = vigentes.reduce((total, cobro) => total + Math.max(asMoney(cobro.monto) - asMoney(cobro.monto_pagado), 0), 0);
    const totalVencido = vigentes.reduce((total, cobro) => {
      if (!cobro.fecha_vencimiento || cobro.fecha_vencimiento >= billing.today) return total;
      return total + Math.max(asMoney(cobro.monto) - asMoney(cobro.monto_pagado), 0);
    }, 0);
    const morosos = new Set(vigentes
      .filter((cobro) => cobro.jugador_id && cobro.fecha_vencimiento && cobro.fecha_vencimiento < billing.today && Math.max(asMoney(cobro.monto) - asMoney(cobro.monto_pagado), 0) > 0)
      .map((cobro) => cobro.jugador_id));
    const totalEgresos = egresos.reduce((total, egreso) => total + asMoney(egreso.monto), 0);
    const alumnosMorosos = morosos.size;

    res.json({
      success: true,
      data: {
        totalIngresosReales,
        totalPorCobrar,
        totalVencido,
        totalPorVencer: Math.max(totalPorCobrar - totalVencido, 0),
        totalEgresos,
        balanceNeto: totalIngresosReales - totalEgresos,
        totalAlumnos: jugadores.length,
        alumnosMorosos,
        tasaMorosidad: jugadores.length
          ? Number(((alumnosMorosos / jugadores.length) * 100).toFixed(1))
          : 0,
        calendarioMensual: billing,
      }
    });
  } catch (error) {
    console.error('Error en GET /api/finanzas/resumen:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/cuentas-corrientes', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const billing = await ensureMonthlyChargesForAcademy(academia_id);
    const [resJugadores, resCobros] = await Promise.all([
      supabase
        .from('jugadores')
        .select('id,nombre,foto_base64,estado_financiero,monto_matricula,abono_matricula,monto_mensualidad,tutor_id,tutores:tutores!jugadores_tutor_id_fkey(nombre_completo,telefono)')
        .eq('academia_id', academia_id)
        .order('nombre', { ascending: true }),
      supabase
        .from('cobros')
        .select('*')
        .eq('academia_id', academia_id)
        .order('fecha_vencimiento', { ascending: false })
    ]);

    const jugadores = rows(resJugadores, 'No se pudieron leer los jugadores');
    let cobros = rows(resCobros, 'No se pudieron leer los cobros');
    const pendientes = [];

    for (const jugador of jugadores) {
      const delJugador = cobros.filter(c => c.jugador_id === jugador.id && c.estado !== 'Anulado');
      const montoMatricula = asMoney(jugador.monto_matricula);

      if (!delJugador.some(c => c.tipo_concepto === 'Matrícula') && montoMatricula > 0) {
        pendientes.push({
          cobro: {
            academia_id,
            jugador_id: jugador.id,
            concepto: 'Matrícula Inicial',
            tipo_concepto: 'Matrícula',
            monto: montoMatricula,
            monto_pagado: 0,
            estado: 'Pendiente',
            fecha_vencimiento: billing.today
          },
          abono: Math.min(asMoney(jugador.abono_matricula), montoMatricula)
        });
      }
    }

    for (const pendiente of pendientes) {
      const insertado = failIfError(
        await supabase.from('cobros').insert([pendiente.cobro]).select().single(),
        'No se pudo sincronizar un cobro base'
      );
      if (pendiente.abono > 0) {
        failIfError(await supabase.rpc('registrar_pago_cobro', {
          p_academia_id: academia_id,
          p_cobro_id: insertado.id,
          p_monto: pendiente.abono,
          p_metodo_pago: 'Sin registrar',
          p_observaciones: 'Abono histórico de matrícula',
          p_idempotency_key: `legacy-player-${insertado.jugador_id}-matricula`,
          p_usuario_id: req.user.id
        }), 'No se pudo migrar el abono inicial');
      }
    }

    if (pendientes.length) {
      await recalculateFinancialStatus(academia_id);
      cobros = rows(await supabase
        .from('cobros')
        .select('*')
        .eq('academia_id', academia_id)
        .order('fecha_vencimiento', { ascending: false }), 'No se pudieron recargar los cobros');
    }

    const cuentas = jugadores.map(jugador => {
      const cobrosJugador = cobros.filter(c => c.jugador_id === jugador.id);
      const vigentes = cobrosJugador.filter(c => c.estado !== 'Anulado');
      const deudaTotal = vigentes.reduce((total, c) => total + asMoney(c.monto), 0);
      const pagadoTotal = vigentes.reduce((total, c) => total + asMoney(c.monto_pagado), 0);
      const resumenCuenta = summarizeCharges(cobrosJugador, { today: billing.today, warningDays: billing.warningDays });
      return {
        ...jugador,
        cobros: cobrosJugador,
        deudaTotal,
        pagadoTotal,
        ...resumenCuenta,
        saldoTotalPendiente: resumenCuenta.saldoPendiente,
        saldoPendiente: resumenCuenta.saldoVencido,
        alDia: resumenCuenta.saldoVencido <= 0,
      };
    });

    res.json({ success: true, data: cuentas });
  } catch (error) {
    console.error('Error en GET /api/finanzas/cuentas-corrientes:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/cobros/:id/pagar', authMiddleware, async (req, res) => {
  try {
    const monto = asMoney(req.body.monto_abono);
    if (!Number.isFinite(monto) || monto <= 0) {
      return res.status(400).json({ success: false, error: 'El monto debe ser mayor que cero.' });
    }

    const data = failIfError(await supabase.rpc('registrar_pago_cobro', {
      p_academia_id: req.user.academia_id,
      p_cobro_id: req.params.id,
      p_monto: monto,
      p_metodo_pago: req.body.metodo_pago || 'Transferencia',
      p_observaciones: req.body.observaciones || null,
      p_idempotency_key: req.body.idempotency_key || null,
      p_usuario_id: req.user.id
    }), 'No se pudo registrar el pago');

    await recalculateFinancialStatus(req.user.academia_id);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en PUT /api/finanzas/cobros/:id/pagar:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

router.get('/pagos', authMiddleware, async (req, res) => {
  try {
    const data = rows(await supabase
      .from('pagos')
      .select('id,cobro_id,jugador_id,monto,metodo_pago,fecha_pago,observaciones,comprobante_ref,cobro:cobros!pagos_cobro_id_fkey(concepto,tipo_concepto),jugador:jugadores!pagos_jugador_id_fkey(nombre)')
      .eq('academia_id', req.user.academia_id)
      .order('fecha_pago', { ascending: false }), 'No se pudieron leer los pagos');
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/cobros', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugador_id, concepto, tipo_concepto, fecha_vencimiento, observaciones } = req.body;
    const monto = asMoney(req.body.monto);
    if (!jugador_id || !concepto?.trim() || monto <= 0) {
      return res.status(400).json({ success: false, error: 'Jugador, concepto y monto son obligatorios.' });
    }

    const jugador = failIfError(await supabase
      .from('jugadores')
      .select('id')
      .eq('id', jugador_id)
      .eq('academia_id', academia_id)
      .maybeSingle(), 'No se pudo validar el jugador');
    if (!jugador) return res.status(404).json({ success: false, error: 'Jugador no encontrado en la academia.' });

    const dueDate = fecha_vencimiento || todayInChile();
    const data = failIfError(await supabase.from('cobros').insert([{
      academia_id,
      jugador_id,
      concepto: concepto.trim(),
      tipo_concepto: tipo_concepto || 'Mensualidad',
      monto,
      monto_pagado: 0,
      estado: 'Pendiente',
      fecha_vencimiento: dueDate,
      observaciones: observaciones || null
    }]).select().single(), 'No se pudo crear el cobro');

    await recalculateFinancialStatus(academia_id);
    res.status(201).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/egresos', authMiddleware, async (req, res) => {
  try {
    const data = rows(await supabase.from('egresos').select('*')
      .eq('academia_id', req.user.academia_id)
      .is('anulado_at', null)
      .order('fecha_gasto', { ascending: false }), 'No se pudieron leer los egresos');
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/egresos', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { concepto, categoria_gasto, centro_costo, metodo_pago, fecha_gasto, observaciones } = req.body;
    const monto = asMoney(req.body.monto);
    if (!concepto?.trim() || monto <= 0) {
      return res.status(400).json({ success: false, error: 'Concepto y monto son obligatorios.' });
    }

    const data = failIfError(await supabase.from('egresos').insert([{
      academia_id,
      concepto: concepto.trim(),
      categoria_gasto: categoria_gasto || 'Otros',
      centro_costo: centro_costo || 'General',
      monto,
      metodo_pago: metodo_pago || 'Transferencia',
      fecha_gasto: fecha_gasto || todayInChile(),
      observaciones: observaciones || null
    }]).select().single(), 'No se pudo crear el egreso');
    res.status(201).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/egresos/:id', authMiddleware, async (req, res) => {
  try {
    const data = failIfError(await supabase.from('egresos').update({
      anulado_at: new Date().toISOString(),
      anulado_por: req.user.id
    })
      .eq('id', req.params.id)
      .eq('academia_id', req.user.academia_id)
      .select('id').maybeSingle(), 'No se pudo eliminar el egreso');
    if (!data) return res.status(404).json({ success: false, error: 'Egreso no encontrado.' });
    res.json({ success: true, message: 'Egreso anulado correctamente.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/flujo-caja', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const [resPagos, resEgresos] = await Promise.all([
      supabase.from('pagos')
        .select('id,monto,fecha_pago,metodo_pago,observaciones,cobro:cobros!pagos_cobro_id_fkey(concepto),jugador:jugadores!pagos_jugador_id_fkey(nombre)')
        .eq('academia_id', academia_id),
      supabase.from('egresos')
        .select('id,concepto,monto,fecha_gasto,metodo_pago,categoria_gasto,centro_costo')
        .eq('academia_id', academia_id)
        .is('anulado_at', null)
    ]);

    const ingresos = rows(resPagos, 'No se pudieron leer los ingresos').map(pago => ({
      id: pago.id,
      tipo: 'Ingreso',
      concepto: `${pago.cobro?.concepto || 'Pago'} - Alumno: ${pago.jugador?.nombre || 'General'}`,
      monto: asMoney(pago.monto),
      fecha: pago.fecha_pago,
      metodo: pago.metodo_pago,
      categoria: 'Recaudación'
    }));
    const egresos = rows(resEgresos, 'No se pudieron leer los egresos').map(egreso => ({
      id: egreso.id,
      tipo: 'Egreso',
      concepto: egreso.concepto,
      monto: asMoney(egreso.monto),
      fecha: egreso.fecha_gasto,
      metodo: egreso.metodo_pago,
      categoria: `${egreso.categoria_gasto} (${egreso.centro_costo})`
    }));
    const flujo = [...ingresos, ...egresos]
      .sort((a, b) => new Date(b.fecha || 0).getTime() - new Date(a.fecha || 0).getTime());
    res.json({ success: true, data: flujo });
  } catch (error) {
    console.error('Error en GET /api/finanzas/flujo-caja:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/configuracion', authMiddleware, async (req, res) => {
  try {
    const data = failIfError(await supabase.from('configuracion_financiera').select('*')
      .eq('academia_id', req.user.academia_id).maybeSingle(), 'No se pudo leer la configuración');
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/configuracion', authMiddleware, async (req, res) => {
  try {
    const permitidos = [
      'acepta_efectivo', 'acepta_transferencia', 'acepta_pago_online',
      'transferencia_banco', 'transferencia_tipo_cuenta', 'transferencia_numero',
      'transferencia_rut', 'transferencia_correo', 'link_pago_online'
    ];
    const cambios = { academia_id: req.user.academia_id, updated_at: new Date().toISOString() };
    for (const campo of permitidos) {
      if (Object.prototype.hasOwnProperty.call(req.body, campo)) cambios[campo] = req.body[campo];
    }

    const data = failIfError(await supabase.from('configuracion_financiera')
      .upsert(cambios, { onConflict: 'academia_id' }).select().single(), 'No se pudo guardar la configuración');
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
