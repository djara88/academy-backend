const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { todayInChile, recalculateFinancialStatus } = require('../services/monthlyBilling');
const { sendCollectionStatementEmail } = require('../services/collectionEmail');
const { createPortalToken, linkedPlayersForTutor, normalizePhone } = require('../services/collectionPortal');
const { enviarMensaje } = require('../services/whatsappService');
const { academyMessage } = require('../services/academyIdentity');

const router = express.Router();
router.use(authMiddleware, requireDirector);
const safe = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const money = (value) => Math.max(0, Number(value) || 0);

router.get('/pagos-informados', async (req, res) => {
  try {
    const state = safe(req.query?.estado, 30) || 'Pendiente';
    let query = supabase.from('pagos_informados')
      .select('id,cobro_id,cuota_id,jugador_id,tutor_id,monto,metodo_pago,fecha_pago_informada,comprobante_ref,observaciones,estado,canal,created_at,revisado_at,revisado_por,motivo_rechazo,jugadores(id,nombre),tutores(id,nombre,nombre_completo,email,telefono),cobros(id,concepto,tipo_concepto,monto,monto_pagado,estado,fecha_vencimiento),cobro_cuotas(id,numero,total_cuotas,monto,monto_pagado,fecha_vencimiento,estado)')
      .eq('academia_id', req.user.academia_id)
      .order('created_at', { ascending: false })
      .limit(250);
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
    }).eq('id', req.params.id).eq('academia_id', req.user.academia_id).eq('estado', 'Pendiente')
      .select('id,estado,motivo_rechazo').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'El pago informado ya fue revisado o no existe.' });
    return res.json({ success: true, data, message: 'Pago informado rechazado. La deuda no fue modificada.' });
  } catch (error) {
    return res.status(500).json({ error: 'No fue posible rechazar el pago informado.' });
  }
});

const accountForTutor = async (academyId, tutorId, onlyOverdue = false) => {
  const players = await linkedPlayersForTutor(academyId, tutorId);
  const playerIds = players.map((player) => player.id);
  if (!playerIds.length) return { players, items: [], total: 0 };
  const { data: charges, error: chargeError } = await supabase.from('cobros')
    .select('id,jugador_id,concepto,monto,monto_pagado,estado,fecha_vencimiento')
    .eq('academia_id', academyId).in('jugador_id', playerIds).neq('estado', 'Anulado').order('fecha_vencimiento');
  if (chargeError) throw chargeError;
  const pendingCharges = (charges || []).filter((row) => money(row.monto) - money(row.monto_pagado) > 0);
  const chargeIds = pendingCharges.map((row) => row.id);
  const { data: installments, error: installmentError } = chargeIds.length
    ? await supabase.from('cobro_cuotas').select('id,cobro_id,numero,total_cuotas,monto,monto_pagado,fecha_vencimiento,estado')
      .eq('academia_id', academyId).in('cobro_id', chargeIds).neq('estado', 'Anulada').order('numero')
    : { data: [], error: null };
  if (installmentError) throw installmentError;
  const byCharge = new Map();
  for (const quota of installments || []) {
    const list = byCharge.get(String(quota.cobro_id)) || [];
    list.push(quota); byCharge.set(String(quota.cobro_id), list);
  }
  const playerMap = new Map(players.map((player) => [String(player.id), player.nombre]));
  const items = [];
  for (const charge of pendingCharges) {
    const quotas = byCharge.get(String(charge.id)) || [];
    if (quotas.length) {
      for (const quota of quotas) {
        const balance = money(quota.monto) - money(quota.monto_pagado);
        if (balance <= 0) continue;
        if (onlyOverdue && (!quota.fecha_vencimiento || quota.fecha_vencimiento >= todayInChile())) continue;
        items.push({
          chargeId: charge.id,
          quotaId: quota.id,
          label: `${charge.concepto} · ${playerMap.get(String(charge.jugador_id)) || 'Alumno'}`,
          amount: balance,
          installment: `Cuota ${quota.numero} de ${quota.total_cuotas}`,
          dueDate: quota.fecha_vencimiento,
        });
      }
    } else {
      const balance = money(charge.monto) - money(charge.monto_pagado);
      if (onlyOverdue && (!charge.fecha_vencimiento || charge.fecha_vencimiento >= todayInChile())) continue;
      items.push({ chargeId: charge.id, quotaId: null, label: `${charge.concepto} · ${playerMap.get(String(charge.jugador_id)) || 'Alumno'}`, amount: balance, installment: null, dueDate: charge.fecha_vencimiento });
    }
  }
  return { players, items, total: items.reduce((sum, item) => sum + item.amount, 0) };
};

router.post('/recordatorios', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const requestedTutorIds = new Set((Array.isArray(req.body?.tutor_ids) ? req.body.tutor_ids : []).map(String));
    const onlyOverdue = req.body?.solo_vencidos === true;
    const requestedChannels = new Set(Array.isArray(req.body?.canales) && req.body.canales.length ? req.body.canales : ['email','whatsapp']);
    const [{ data: academy, error: academyError }, { data: tutors, error: tutorError }] = await Promise.all([
      supabase.from('academias').select('id,nombre').eq('id', academyId).single(),
      supabase.from('tutores').select('id,nombre,nombre_completo,email,telefono').eq('academia_id', academyId).order('nombre_completo'),
    ]);
    if (academyError) throw academyError;
    if (tutorError) throw tutorError;

    const selected = (tutors || []).filter((tutor) => !requestedTutorIds.size || requestedTutorIds.has(String(tutor.id)));
    let emails = 0;
    let whatsapps = 0;
    let skipped = 0;
    let errors = 0;
    const detail = [];

    for (const tutor of selected) {
      try {
        const account = await accountForTutor(academyId, tutor.id, onlyOverdue);
        if (!account.items.length || account.total <= 0) { skipped += 1; continue; }
        const portal = await createPortalToken({ academyId, tutorId: tutor.id, via: 'recordatorio_direccion', userId: req.user.id, ttlMinutes: 14 * 24 * 60 });
        const portalUrl = `${process.env.PUBLIC_APP_URL || 'https://deportivo.lestra.app'}/pagar/${portal.token}`;
        const name = tutor.nombre_completo || tutor.nombre || 'Apoderado';
        const sentChannels = [];

        if (requestedChannels.has('email') && tutor.email && /^\S+@\S+\.\S+$/.test(String(tutor.email))) {
          try {
            const sent = await sendCollectionStatementEmail({ email: tutor.email, name, academyName: academy.nombre, totalPending: account.total, portalUrl, items: account.items });
            if (sent) { emails += 1; sentChannels.push('email'); }
            await supabase.from('cobranza_notificaciones').insert({ academia_id: academyId,tutor_id:tutor.id,token_id:portal.tokenId,canal:'email',tipo:onlyOverdue?'vencimiento':'estado_cuenta',estado:sent?'Enviado':'Error',enviado_at:sent?new Date().toISOString():null,metadata:{ total: account.total, conceptos: account.items.length } });
          } catch (error) {
            errors += 1;
            await supabase.from('cobranza_notificaciones').insert({ academia_id: academyId,tutor_id:tutor.id,token_id:portal.tokenId,canal:'email',tipo:onlyOverdue?'vencimiento':'estado_cuenta',estado:'Error',metadata:{ error: safe(error?.message,300) } });
          }
        }

        const phone = normalizePhone(tutor.telefono);
        if (requestedChannels.has('whatsapp') && phone) {
          try {
            const lines = account.items.slice(0, 8).map((item) => `• ${item.label}${item.installment ? ` · ${item.installment}` : ''}: $${Math.round(item.amount).toLocaleString('es-CL')}`).join('\n');
            await enviarMensaje(academyId, phone, academyMessage(academy.nombre,
              `💳 *ESTADO DE CUENTA*\n\n${lines}\n\n*Total pendiente: $${Math.round(account.total).toLocaleString('es-CL')}*\n\nConsulta el detalle y las opciones de pago aquí:\n${portalUrl}\n\nℹ️ Informar una transferencia no la marca como pagada hasta que la academia la valide.`));
            whatsapps += 1; sentChannels.push('whatsapp');
            await supabase.from('cobranza_notificaciones').insert({ academia_id: academyId,tutor_id:tutor.id,token_id:portal.tokenId,canal:'whatsapp',tipo:onlyOverdue?'vencimiento':'estado_cuenta',estado:'Enviado',enviado_at:new Date().toISOString(),metadata:{ total: account.total, conceptos: account.items.length } });
          } catch (error) {
            errors += 1;
            await supabase.from('cobranza_notificaciones').insert({ academia_id: academyId,tutor_id:tutor.id,token_id:portal.tokenId,canal:'whatsapp',tipo:onlyOverdue?'vencimiento':'estado_cuenta',estado:'Error',metadata:{ error: safe(error?.message,300) } });
          }
        }

        if (!sentChannels.length) skipped += 1;
        detail.push({ tutor_id: tutor.id, nombre: name, total: account.total, canales: sentChannels });
      } catch (error) {
        errors += 1;
        console.error(`No se pudo preparar cobranza para tutor ${tutor.id}:`, error?.message || error);
      }
    }

    return res.json({ success: true, data: { procesados: selected.length, emails, whatsapps, omitidos: skipped, errores: errors, detalle: detail } });
  } catch (error) {
    console.error('Error enviando recordatorios de cobranza:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible enviar los estados de cuenta.' });
  }
});

module.exports = router;