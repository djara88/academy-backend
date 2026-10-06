const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { createTenantRepository } = require('../services/tenantRepository');
const { requireTenantContext } = require('../middleware/tenantContext');
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
const idempotencyKey = (value) => String(value || '').trim().slice(0, 160) || null;
const normalizedText = (value) => String(value || '').trim();

const findIdempotentRow = async (table, academyId, key) => {
  if (!key) return null;
  const { data, error } = await supabase.from(table).select('*')
    .eq('academia_id', academyId).eq('idempotency_key', key).maybeSingle();
  if (error) throw error;
  return data;
};

const sameChargeWrite = (existing, payload) => Boolean(existing)
  && String(existing.jugador_id || '') === String(payload.jugador_id || '')
  && normalizedText(existing.concepto) === normalizedText(payload.concepto)
  && normalizedText(existing.tipo_concepto) === normalizedText(payload.tipo_concepto)
  && asMoney(existing.monto) === asMoney(payload.monto)
  && String(existing.fecha_vencimiento || '') === String(payload.fecha_vencimiento || '')
  && normalizedText(existing.observaciones) === normalizedText(payload.observaciones);

const sameExpenseWrite = (existing, payload) => Boolean(existing)
  && normalizedText(existing.concepto) === normalizedText(payload.concepto)
  && normalizedText(existing.categoria_gasto) === normalizedText(payload.categoria_gasto)
  && normalizedText(existing.centro_costo) === normalizedText(payload.centro_costo)
  && asMoney(existing.monto) === asMoney(payload.monto)
  && normalizedText(existing.metodo_pago) === normalizedText(payload.metodo_pago)
  && String(existing.fecha_gasto || '') === String(payload.fecha_gasto || '')
  && normalizedText(existing.observaciones) === normalizedText(payload.observaciones);

const idempotentConflict = (res) => res.status(409).json({
  success: false,
  code: 'IDEMPOTENCY_KEY_REUSED',
  error: 'Esta operación ya fue utilizada con datos diferentes. Genera una nueva operación antes de intentarlo otra vez.',
});

const BILLING_CACHE_TTL_MS = Math.max(10_000, Number(process.env.FINANCE_BILLING_CACHE_TTL_MS || 60_000));
const billingCache = new Map();

const getBillingSnapshot = async (academyId) => {
  const now = Date.now();
  const cached = billingCache.get(academyId);
  if (cached?.data && cached.expiresAt > now) return cached.data;
  if (cached?.promise) return cached.promise;

  const promise = ensureMonthlyChargesForAcademy(academyId)
    .then((data) => {
      billingCache.set(academyId, { data, expiresAt: Date.now() + BILLING_CACHE_TTL_MS });
      return data;
    })
    .catch((error) => {
      billingCache.delete(academyId);
      throw error;
    });

  billingCache.set(academyId, { promise, expiresAt: now + BILLING_CACHE_TTL_MS });
  return promise;
};

router.get('/resumen', authMiddleware, requireTenantContext, async (req, res) => {
  try {
    const academia_id = req.tenant.academyId;
    const billing = await getBillingSnapshot(academia_id);
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

router.get('/cuentas-corrientes', authMiddleware, requireTenantContext, async (req, res) => {
  try {
    const academia_id = req.tenant.academyId;
    const billing = await getBillingSnapshot(academia_id);
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
    const cobros = rows(resCobros, 'No se pudieron leer los cobros');
    const cobrosPorJugador = new Map();

    for (const cobro of cobros) {
      if (!cobro.jugador_id) continue;
      const current = cobrosPorJugador.get(cobro.jugador_id);
      if (current) current.push(cobro);
      else cobrosPorJugador.set(cobro.jugador_id, [cobro]);
    }

    const cuentas = jugadores.map(jugador => {
      const cobrosJugador = cobrosPorJugador.get(jugador.id) || [];
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

router.put('/cobros/:id/pagar', authMiddleware, requireTenantContext, async (req, res) => {
  try {
    const monto = asMoney(req.body.monto_abono);
    if (!Number.isFinite(monto) || monto <= 0) {
      return res.status(400).json({ success: false, error: 'El monto debe ser mayor que cero.' });
    }

    const data = failIfError(await supabase.rpc('registrar_pago_cobro', {
      p_academia_id: req.tenant.academyId,
      p_cobro_id: req.params.id,
      p_monto: monto,
      p_metodo_pago: req.body.metodo_pago || 'Transferencia',
      p_observaciones: req.body.observaciones || null,
      p_idempotency_key: req.body.idempotency_key || null,
      p_usuario_id: req.user.id
    }), 'No se pudo registrar el pago');

    await recalculateFinancialStatus(req.tenant.academyId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en PUT /api/finanzas/cobros/:id/pagar:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

router.get('/pagos', authMiddleware, requireTenantContext, async (req, res) => {
  try {
    const data = rows(await supabase
      .from('pagos')
      .select('id,cobro_id,jugador_id,monto,metodo_pago,fecha_pago,observaciones,comprobante_ref,cobro:cobros!pagos_cobro_id_fkey(concepto,tipo_concepto),jugador:jugadores!pagos_jugador_id_fkey(nombre)')
      .eq('academia_id', req.tenant.academyId)
      .order('fecha_pago', { ascending: false }), 'No se pudieron leer los pagos');
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/cobros', authMiddleware, requireTenantContext, async (req, res) => {
  try {
    const academia_id = req.tenant.academyId;
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
    const key = idempotencyKey(req.body.idempotency_key);
    const payload = {
      academia_id,
      jugador_id,
      concepto: concepto.trim(),
      tipo_concepto: tipo_concepto || 'Mensualidad',
      monto,
      monto_pagado: 0,
      estado: 'Pendiente',
      fecha_vencimiento: dueDate,
      observaciones: observaciones || null,
      idempotency_key: key,
    };

    const existing = await findIdempotentRow('cobros', academia_id, key);
    if (existing) {
      if (!sameChargeWrite(existing, payload)) return idempotentConflict(res);
      return res.json({ success: true, idempotent: true, data: existing });
    }

    const insertResult = await createTenantRepository({ academyId: academia_id }).table('cobros').insert([payload]).select().single();
    if (insertResult.error) {
      if (insertResult.error.code === '23505' && key) {
        const raced = await findIdempotentRow('cobros', academia_id, key);
        if (raced && sameChargeWrite(raced, payload)) return res.json({ success: true, idempotent: true, data: raced });
        if (raced) return idempotentConflict(res);
      }
      throw insertResult.error;
    }

    await recalculateFinancialStatus(academia_id);
    res.status(201).json({ success: true, idempotent: false, data: insertResult.data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/egresos', authMiddleware, requireTenantContext, async (req, res) => {
  try {
    const data = rows(await supabase.from('egresos').select('*')
      .eq('academia_id', req.tenant.academyId)
      .is('anulado_at', null)
      .order('fecha_gasto', { ascending: false }), 'No se pudieron leer los egresos');
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/egresos', authMiddleware, requireTenantContext, async (req, res) => {
  try {
    const academia_id = req.tenant.academyId;
    const { concepto, categoria_gasto, centro_costo, metodo_pago, fecha_gasto, observaciones } = req.body;
    const monto = asMoney(req.body.monto);
    if (!concepto?.trim() || monto <= 0) {
      return res.status(400).json({ success: false, error: 'Concepto y monto son obligatorios.' });
    }

    const key = idempotencyKey(req.body.idempotency_key);
    const payload = {
      academia_id,
      concepto: concepto.trim(),
      categoria_gasto: categoria_gasto || 'Otros',
      centro_costo: centro_costo || 'General',
      monto,
      metodo_pago: metodo_pago || 'Transferencia',
      fecha_gasto: fecha_gasto || todayInChile(),
      observaciones: observaciones || null,
      idempotency_key: key,
    };

    const existing = await findIdempotentRow('egresos', academia_id, key);
    if (existing) {
      if (!sameExpenseWrite(existing, payload)) return idempotentConflict(res);
      return res.json({ success: true, idempotent: true, data: existing });
    }

    const insertResult = await createTenantRepository({ academyId: academia_id }).table('egresos').insert([payload]).select().single();
    if (insertResult.error) {
      if (insertResult.error.code === '23505' && key) {
        const raced = await findIdempotentRow('egresos', academia_id, key);
        if (raced && sameExpenseWrite(raced, payload)) return res.json({ success: true, idempotent: true, data: raced });
        if (raced) return idempotentConflict(res);
      }
      throw insertResult.error;
    }
    res.status(201).json({ success: true, idempotent: false, data: insertResult.data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/egresos/:id', authMiddleware, requireTenantContext, async (req, res) => {
  try {
    const academyId = req.tenant.academyId;
    const cancellation = await supabase.from('egresos').update({
      anulado_at: new Date().toISOString(),
      anulado_por: req.user.id
    })
      .eq('id', req.params.id)
      .eq('academia_id', academyId)
      .is('anulado_at', null)
      .select('id,anulado_at').maybeSingle();
    if (cancellation.error) throw cancellation.error;
    if (cancellation.data) return res.json({ success: true, idempotent: false, message: 'Egreso anulado correctamente.', data: cancellation.data });

    const existing = await supabase.from('egresos').select('id,anulado_at')
      .eq('id', req.params.id)
      .eq('academia_id', academyId)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) return res.status(404).json({ success: false, error: 'Egreso no encontrado.' });
    if (existing.data.anulado_at) return res.json({ success: true, idempotent: true, message: 'El egreso ya estaba anulado.', data: existing.data });

    return res.status(409).json({ success: false, error: 'El egreso cambió mientras se intentaba anular. Sincroniza y vuelve a intentarlo.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/flujo-caja', authMiddleware, requireTenantContext, async (req, res) => {
  try {
    const academia_id = req.tenant.academyId;
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

router.get('/configuracion', authMiddleware, requireTenantContext, async (req, res) => {
  try {
    const data = failIfError(await supabase.from('configuracion_financiera').select('*')
      .eq('academia_id', req.tenant.academyId).maybeSingle(), 'No se pudo leer la configuración');
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/configuracion', authMiddleware, requireTenantContext, async (req, res) => {
  try {
    const permitidos = [
      'acepta_efectivo', 'acepta_transferencia', 'acepta_pago_online',
      'transferencia_banco', 'transferencia_tipo_cuenta', 'transferencia_numero',
      'transferencia_rut', 'transferencia_correo', 'link_pago_online'
    ];
    const cambios = { academia_id: req.tenant.academyId, updated_at: new Date().toISOString() };
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