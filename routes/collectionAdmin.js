const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { recalculateFinancialStatus, todayInChile } = require('../services/monthlyBilling');
const { sendStatementsForAcademy } = require('../services/collectionService');

const router = express.Router();
router.use(authMiddleware, requireDirector);

const safe = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const money = (value) => Math.max(0, Number(value) || 0);
const CONFIG_SELECT = 'academia_id,cobranza_automatica,cobranza_auto_email,cobranza_auto_whatsapp,cobranza_recordar_antes,cobranza_recordar_vencido,cobranza_dias_mora,cobranza_hora_local,acepta_efectivo,acepta_transferencia,acepta_pago_online';

const ensureConfig = async (academyId) => {
  let { data, error } = await supabase.from('configuracion_financiera')
    .select(CONFIG_SELECT)
    .eq('academia_id', academyId)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;
  const created = await supabase.from('configuracion_financiera')
    .insert({ academia_id: academyId })
    .select(CONFIG_SELECT)
    .single();
  if (created.error) throw created.error;
  return created.data;
};

router.get('/cuentas', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const branchId = safe(req.query?.rama_id, 80);
    const search = safe(req.query?.q, 120).toLowerCase();
    const status = safe(req.query?.estado, 30).toLowerCase() || 'todos';
    const page = Math.max(1, Number.parseInt(req.query?.page, 10) || 1);
    const pageSize = Math.max(10, Math.min(100, Number.parseInt(req.query?.page_size, 10) || 25));

    let playerIds = null;
    if (branchId) {
      const { data: branch, error: branchError } = await supabase.from('ramas')
        .select('id').eq('id', branchId).eq('academia_id', academyId).maybeSingle();
      if (branchError) throw branchError;
      if (!branch) return res.status(404).json({ error: 'La rama no pertenece a la academia.' });
      const { data: enrollments, error: enrollmentError } = await supabase.from('inscripciones_deportivas')
        .select('jugador_id').eq('academia_id', academyId).eq('rama_id', branchId).eq('estado', 'Activa');
      if (enrollmentError) throw enrollmentError;
      playerIds = [...new Set((enrollments || []).map((row) => row.jugador_id).filter(Boolean))];
      if (!playerIds.length) return res.json({ success: true, data: [], meta: { page, page_size: pageSize, total: 0, pages: 0 } });
    }

    let playersQuery = supabase.from('jugadores')
      .select('id,nombre,foto_base64,foto_url,avatar_url,tutor_id,tutores:tutores!jugadores_tutor_id_fkey(id,nombre,nombre_completo,email,telefono)')
      .eq('academia_id', academyId)
      .order('nombre');
    if (playerIds) playersQuery = playersQuery.in('id', playerIds);

    let chargesQuery = supabase.from('cobros')
      .select('id,jugador_id,inscripcion_id,rama_id,concepto,tipo_concepto,monto,monto_pagado,estado,fecha_vencimiento,observaciones')
      .eq('academia_id', academyId)
      .neq('estado', 'Anulado')
      .order('fecha_vencimiento', { ascending: true });
    if (branchId) chargesQuery = chargesQuery.eq('rama_id', branchId);

    const [playersResult, chargesResult] = await Promise.all([playersQuery, chargesQuery]);
    if (playersResult.error) throw playersResult.error;
    if (chargesResult.error) throw chargesResult.error;
    const players = playersResult.data || [];
    const charges = chargesResult.data || [];
    const chargeIds = charges.map((row) => row.id);
    const { data: quotas, error: quotaError } = chargeIds.length
      ? await supabase.from('cobro_cuotas')
        .select('id,cobro_id,numero,total_cuotas,monto,monto_pagado,fecha_vencimiento,estado')
        .eq('academia_id', academyId)
        .in('cobro_id', chargeIds)
        .neq('estado', 'Anulada')
        .order('numero')
      : { data: [], error: null };
    if (quotaError) throw quotaError;

    const quotasByCharge = new Map();
    for (const quota of quotas || []) {
      const key = String(quota.cobro_id);
      const list = quotasByCharge.get(key) || [];
      list.push({
        ...quota,
        saldo: Math.max(money(quota.monto) - money(quota.monto_pagado), 0),
      });
      quotasByCharge.set(key, list);
    }
    const chargesByPlayer = new Map();
    for (const charge of charges) {
      const key = String(charge.jugador_id || '');
      if (!key) continue;
      const cuotas = quotasByCharge.get(String(charge.id)) || [];
      const row = {
        ...charge,
        saldo: Math.max(money(charge.monto) - money(charge.monto_pagado), 0),
        cuotas,
      };
      const list = chargesByPlayer.get(key) || [];
      list.push(row);
      chargesByPlayer.set(key, list);
    }

    const today = todayInChile();
    let accounts = players.map((player) => {
      const playerCharges = chargesByPlayer.get(String(player.id)) || [];
      let pending = 0;
      let overdue = 0;
      const dueDates = [];
      for (const charge of playerCharges) {
        pending += charge.saldo;
        if (charge.cuotas?.length) {
          for (const quota of charge.cuotas) {
            if (quota.saldo <= 0) continue;
            if (quota.fecha_vencimiento) dueDates.push(quota.fecha_vencimiento);
            if (quota.fecha_vencimiento && quota.fecha_vencimiento < today) overdue += quota.saldo;
          }
        } else {
          if (charge.saldo > 0 && charge.fecha_vencimiento) dueDates.push(charge.fecha_vencimiento);
          if (charge.saldo > 0 && charge.fecha_vencimiento && charge.fecha_vencimiento < today) overdue += charge.saldo;
        }
      }
      const tutor = player.tutores || null;
      const normalizedStatus = overdue > 0 ? 'vencido' : pending > 0 ? 'pendiente' : 'al_dia';
      return {
        id: player.id,
        nombre: player.nombre,
        foto_base64: player.foto_base64,
        foto_url: player.foto_url,
        avatar_url: player.avatar_url,
        tutor_id: tutor?.id || player.tutor_id || null,
        tutor: tutor ? {
          id: tutor.id,
          nombre: tutor.nombre_completo || tutor.nombre || 'Apoderado',
          email: tutor.email || null,
          telefono: tutor.telefono || null,
        } : null,
        saldo_total: pending,
        saldo_vencido: overdue,
        proximo_vencimiento: dueDates.sort()[0] || null,
        estado_cuenta: normalizedStatus,
        cobros: playerCharges,
      };
    });

    if (search) {
      accounts = accounts.filter((row) => [row.nombre, row.tutor?.nombre, row.tutor?.email, row.tutor?.telefono]
        .filter(Boolean).some((value) => String(value).toLowerCase().includes(search)));
    }
    if (status !== 'todos') accounts = accounts.filter((row) => row.estado_cuenta === status);
    accounts.sort((a, b) => {
      if (a.estado_cuenta !== b.estado_cuenta) {
        const rank = { vencido: 0, pendiente: 1, al_dia: 2 };
        return (rank[a.estado_cuenta] ?? 9) - (rank[b.estado_cuenta] ?? 9);
      }
      return String(a.nombre).localeCompare(String(b.nombre), 'es');
    });

    const total = accounts.length;
    const pages = total ? Math.ceil(total / pageSize) : 0;
    const start = (page - 1) * pageSize;
    const data = accounts.slice(start, start + pageSize);
    return res.json({ success: true, data, meta: { page, page_size: pageSize, total, pages } });
  } catch (error) {
    console.error('Error cargando cuentas de cobranza:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible cargar las cuentas corrientes.' });
  }
});

router.get('/configuracion', async (req, res) => {
  try {
    const data = await ensureConfig(req.user.academia_id);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error cargando configuración de cobranza:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible cargar la configuración de cobranza.' });
  }
});

router.patch('/configuracion', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    await ensureConfig(academyId);
    const rawDays = Array.isArray(req.body?.cobranza_dias_mora) ? req.body.cobranza_dias_mora : [1, 5, 10, 15];
    const days = [...new Set(rawDays.map(Number).filter((value) => Number.isInteger(value) && value >= 1 && value <= 60))].sort((a, b) => a - b).slice(0, 10);
    const hour = Math.max(0, Math.min(23, Math.round(Number(req.body?.cobranza_hora_local ?? 9))));
    const changes = {
      cobranza_automatica: req.body?.cobranza_automatica === true,
      cobranza_auto_email: req.body?.cobranza_auto_email !== false,
      cobranza_auto_whatsapp: req.body?.cobranza_auto_whatsapp !== false,
      cobranza_recordar_antes: req.body?.cobranza_recordar_antes !== false,
      cobranza_recordar_vencido: req.body?.cobranza_recordar_vencido !== false,
      cobranza_dias_mora: days.length ? days : [1, 5, 10, 15],
      cobranza_hora_local: hour,
      updated_at: new Date().toISOString(),
    };
    if (changes.cobranza_automatica && !changes.cobranza_auto_email && !changes.cobranza_auto_whatsapp) {
      return res.status(400).json({ error: 'Activa al menos un canal para usar la cobranza automática.' });
    }
    const { data, error } = await supabase.from('configuracion_financiera')
      .update(changes)
      .eq('academia_id', academyId)
      .select(CONFIG_SELECT)
      .single();
    if (error) throw error;
    return res.json({ success: true, data, message: changes.cobranza_automatica ? 'Cobranza automática configurada.' : 'Cobranza automática desactivada.' });
  } catch (error) {
    console.error('Error guardando configuración de cobranza:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible guardar la configuración de cobranza.' });
  }
});

router.get('/pagos-informados', async (req, res) => {
  try {
    const state = safe(req.query?.estado, 30) || 'Pendiente';
    let query = supabase.from('pagos_informados')
      .select('id,cobro_id,cuota_id,jugador_id,tutor_id,monto,metodo_pago,fecha_pago_informada,comprobante_ref,observaciones,estado,canal,created_at,revisado_at,revisado_por,motivo_rechazo,jugadores(id,nombre),tutores(id,nombre,nombre_completo,email,telefono),cobros(id,concepto,tipo_concepto,monto,monto_pagado,estado,fecha_vencimiento),cobro_cuotas(id,numero,total_cuotas,monto,monto_pagado,fecha_vencimiento,estado)')
      .eq('academia_id', req.user.academia_id)
      .order('created_at', { ascending: false })
      .limit(500);
    if (state !== 'Todos') query = query.eq('estado', state);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (error) {
    console.error('Error cargando pagos informados:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible cargar los pagos por validar.' });
  }
});

router.patch('/pagos-informados/:id/validar', async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('validar_pago_informado', {
      p_academia_id: req.user.academia_id,
      p_pago_informado_id: req.params.id,
      p_usuario_id: req.user.id,
    });
    if (error) throw error;
    await recalculateFinancialStatus(req.user.academia_id);
    return res.json({ success: true, data, message: 'Pago validado y aplicado al estado de cuenta.' });
  } catch (error) {
    console.error('Error validando pago informado:', error?.message || error);
    return res.status(400).json({ error: error?.message || 'No fue posible validar el pago.' });
  }
});

router.patch('/pagos-informados/:id/rechazar', async (req, res) => {
  try {
    const reason = safe(req.body?.motivo, 1000);
    if (!reason) return res.status(400).json({ error: 'Indica el motivo del rechazo.' });
    const { data, error } = await supabase.from('pagos_informados').update({
      estado: 'Rechazado',
      revisado_at: new Date().toISOString(),
      revisado_por: req.user.id,
      motivo_rechazo: reason,
    }).eq('id', req.params.id)
      .eq('academia_id', req.user.academia_id)
      .eq('estado', 'Pendiente')
      .select('id,estado,motivo_rechazo')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'El pago informado ya fue revisado o no existe.' });
    return res.json({ success: true, data, message: 'Pago informado rechazado. La deuda no fue modificada.' });
  } catch (error) {
    console.error('Error rechazando pago informado:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible rechazar el pago informado.' });
  }
});

router.get('/notificaciones', async (req, res) => {
  try {
    const { data, error } = await supabase.from('cobranza_notificaciones')
      .select('id,tutor_id,canal,tipo,estado,enviado_at,metadata,created_at,tutores(id,nombre,nombre_completo,email,telefono)')
      .eq('academia_id', req.user.academia_id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (error) {
    return res.status(500).json({ error: 'No fue posible cargar el historial de cobranza.' });
  }
});

router.post('/recordatorios', async (req, res) => {
  try {
    const channels = Array.isArray(req.body?.canales) && req.body.canales.length
      ? req.body.canales.filter((item) => ['email', 'whatsapp'].includes(item))
      : ['email', 'whatsapp'];
    if (!channels.length) return res.status(400).json({ error: 'Selecciona al menos un canal.' });
    const data = await sendStatementsForAcademy({
      academyId: req.user.academia_id,
      tutorIds: Array.isArray(req.body?.tutor_ids) ? req.body.tutor_ids : [],
      onlyOverdue: req.body?.solo_vencidos === true,
      channels,
      userId: req.user.id,
      via: 'recordatorio_direccion',
      notificationType: req.body?.solo_vencidos === true ? 'vencimiento' : 'estado_cuenta',
    });
    return res.json({ success: true, data, message: `Cobranza procesada: ${data.emails} correo(s), ${data.whatsapps} WhatsApp(s).` });
  } catch (error) {
    console.error('Error enviando recordatorios de cobranza:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible enviar los estados de cuenta.' });
  }
});

module.exports = router;
