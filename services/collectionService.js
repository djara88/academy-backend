const supabase = require('../config/supabase');
const { todayInChile } = require('./monthlyBilling');
const { sendCollectionStatementEmail } = require('./collectionEmail');
const { createPortalToken, linkedPlayersForTutor, normalizePhone } = require('./collectionPortal');
const { enviarMensaje } = require('./whatsappService');
const { academyMessage } = require('./academyIdentity');

const safe = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const money = (value) => Math.max(0, Number(value) || 0);
const publicAppUrl = () => String(process.env.PUBLIC_APP_URL || 'https://deportivo.lestra.app').replace(/\/$/, '');

const accountForTutor = async (academyId, tutorId, options = {}) => {
  const { onlyOverdue = false } = options;
  const players = await linkedPlayersForTutor(academyId, tutorId);
  const playerIds = players.map((player) => player.id);
  if (!playerIds.length) return { players, items: [], total: 0 };

  const { data: charges, error: chargeError } = await supabase.from('cobros')
    .select('id,jugador_id,concepto,monto,monto_pagado,estado,fecha_vencimiento')
    .eq('academia_id', academyId)
    .in('jugador_id', playerIds)
    .neq('estado', 'Anulado')
    .order('fecha_vencimiento');
  if (chargeError) throw chargeError;

  const pendingCharges = (charges || []).filter((row) => money(row.monto) - money(row.monto_pagado) > 0);
  const chargeIds = pendingCharges.map((row) => row.id);
  const { data: installments, error: installmentError } = chargeIds.length
    ? await supabase.from('cobro_cuotas')
      .select('id,cobro_id,numero,total_cuotas,monto,monto_pagado,fecha_vencimiento,estado')
      .eq('academia_id', academyId)
      .in('cobro_id', chargeIds)
      .neq('estado', 'Anulada')
      .order('numero')
    : { data: [], error: null };
  if (installmentError) throw installmentError;

  const byCharge = new Map();
  for (const quota of installments || []) {
    const list = byCharge.get(String(quota.cobro_id)) || [];
    list.push(quota);
    byCharge.set(String(quota.cobro_id), list);
  }
  const playerMap = new Map(players.map((player) => [String(player.id), player.nombre]));
  const today = todayInChile();
  const items = [];

  for (const charge of pendingCharges) {
    const quotas = byCharge.get(String(charge.id)) || [];
    if (quotas.length) {
      for (const quota of quotas) {
        const balance = money(quota.monto) - money(quota.monto_pagado);
        if (balance <= 0) continue;
        if (onlyOverdue && (!quota.fecha_vencimiento || quota.fecha_vencimiento >= today)) continue;
        items.push({
          chargeId: charge.id,
          quotaId: quota.id,
          label: `${charge.concepto} · ${playerMap.get(String(charge.jugador_id)) || 'Alumno'}`,
          amount: balance,
          installment: `Cuota ${quota.numero} de ${quota.total_cuotas}`,
          dueDate: quota.fecha_vencimiento,
          overdue: Boolean(quota.fecha_vencimiento && quota.fecha_vencimiento < today),
        });
      }
    } else {
      const balance = money(charge.monto) - money(charge.monto_pagado);
      if (balance <= 0) continue;
      if (onlyOverdue && (!charge.fecha_vencimiento || charge.fecha_vencimiento >= today)) continue;
      items.push({
        chargeId: charge.id,
        quotaId: null,
        label: `${charge.concepto} · ${playerMap.get(String(charge.jugador_id)) || 'Alumno'}`,
        amount: balance,
        installment: null,
        dueDate: charge.fecha_vencimiento,
        overdue: Boolean(charge.fecha_vencimiento && charge.fecha_vencimiento < today),
      });
    }
  }

  return {
    players,
    items,
    total: items.reduce((sum, item) => sum + item.amount, 0),
    overdueTotal: items.filter((item) => item.overdue).reduce((sum, item) => sum + item.amount, 0),
  };
};

const claimNotification = async ({ academyId, tutorId, channel, type, tokenId, total, itemCount, dedupeKey }) => {
  if (!dedupeKey) return { claimed: true, rowId: null };
  const { data: existing, error: existingError } = await supabase.from('cobranza_notificaciones')
    .select('id,estado')
    .eq('academia_id', academyId)
    .eq('dedupe_key', dedupeKey)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing && existing.estado === 'Enviado') return { claimed: false, rowId: existing.id };

  if (existing) {
    const { data, error } = await supabase.from('cobranza_notificaciones')
      .update({
        tutor_id: tutorId,
        token_id: tokenId || null,
        canal: channel,
        tipo: type,
        estado: 'Pendiente',
        enviado_at: null,
        metadata: { total, conceptos: itemCount, reintento: true },
      })
      .eq('id', existing.id)
      .select('id')
      .single();
    if (error) throw error;
    return { claimed: true, rowId: data.id };
  }

  const { data, error } = await supabase.from('cobranza_notificaciones').insert({
    academia_id: academyId,
    tutor_id: tutorId,
    token_id: tokenId || null,
    canal: channel,
    tipo: type,
    estado: 'Pendiente',
    dedupe_key: dedupeKey,
    metadata: { total, conceptos: itemCount },
  }).select('id').single();
  if (error) {
    if (error.code === '23505') return { claimed: false, rowId: null };
    throw error;
  }
  return { claimed: true, rowId: data.id };
};

const finishNotification = async (rowId, state, metadata = {}) => {
  if (!rowId) return;
  await supabase.from('cobranza_notificaciones').update({
    estado: state,
    enviado_at: state === 'Enviado' ? new Date().toISOString() : null,
    metadata,
  }).eq('id', rowId);
};

const sendStatementToTutor = async ({
  academy,
  tutor,
  onlyOverdue = false,
  channels = ['email', 'whatsapp'],
  userId = null,
  via = 'direccion',
  notificationType = 'estado_cuenta',
  dedupePrefix = null,
}) => {
  const account = await accountForTutor(academy.id, tutor.id, { onlyOverdue });
  if (!account.items.length || account.total <= 0) {
    return { tutor_id: tutor.id, nombre: tutor.nombre_completo || tutor.nombre || 'Apoderado', total: 0, canales: [], omitido: 'sin_deuda' };
  }

  const portal = await createPortalToken({
    academyId: academy.id,
    tutorId: tutor.id,
    via,
    userId,
    ttlMinutes: 14 * 24 * 60,
  });
  const portalUrl = `${publicAppUrl()}/pagar/${portal.token}`;
  const name = tutor.nombre_completo || tutor.nombre || 'Apoderado';
  const channelSet = new Set(channels);
  const sentChannels = [];
  const errors = [];

  if (channelSet.has('email') && tutor.email && /^\S+@\S+\.\S+$/.test(String(tutor.email))) {
    const dedupeKey = dedupePrefix ? `${dedupePrefix}:${tutor.id}:email` : null;
    const claim = await claimNotification({
      academyId: academy.id, tutorId: tutor.id, channel: 'email', type: notificationType,
      tokenId: portal.tokenId, total: account.total, itemCount: account.items.length, dedupeKey,
    });
    if (claim.claimed) {
      try {
        const sent = await sendCollectionStatementEmail({
          email: tutor.email,
          name,
          academyName: academy.nombre,
          totalPending: account.total,
          portalUrl,
          items: account.items,
        });
        if (sent) sentChannels.push('email');
        await finishNotification(claim.rowId, sent ? 'Enviado' : 'Error', { total: account.total, conceptos: account.items.length });
      } catch (error) {
        errors.push(`email: ${safe(error?.message, 250)}`);
        await finishNotification(claim.rowId, 'Error', { total: account.total, conceptos: account.items.length, error: safe(error?.message, 300) });
      }
    }
  }

  const phone = normalizePhone(tutor.telefono);
  if (channelSet.has('whatsapp') && phone) {
    const dedupeKey = dedupePrefix ? `${dedupePrefix}:${tutor.id}:whatsapp` : null;
    const claim = await claimNotification({
      academyId: academy.id, tutorId: tutor.id, channel: 'whatsapp', type: notificationType,
      tokenId: portal.tokenId, total: account.total, itemCount: account.items.length, dedupeKey,
    });
    if (claim.claimed) {
      try {
        const lines = account.items.slice(0, 8)
          .map((item) => `• ${item.label}${item.installment ? ` · ${item.installment}` : ''}: $${Math.round(item.amount).toLocaleString('es-CL')}`)
          .join('\n');
        await enviarMensaje(academy.id, phone, academyMessage(academy.nombre,
          `💳 *${onlyOverdue ? 'PAGO PENDIENTE' : 'ESTADO DE CUENTA'}*\n\n${lines}\n\n*Total pendiente: $${Math.round(account.total).toLocaleString('es-CL')}*\n\nConsulta el detalle y las opciones de pago aquí:\n${portalUrl}\n\nℹ️ Informar una transferencia no la marca como pagada hasta que la academia la valide.`));
        sentChannels.push('whatsapp');
        await finishNotification(claim.rowId, 'Enviado', { total: account.total, conceptos: account.items.length });
      } catch (error) {
        errors.push(`whatsapp: ${safe(error?.message, 250)}`);
        await finishNotification(claim.rowId, 'Error', { total: account.total, conceptos: account.items.length, error: safe(error?.message, 300) });
      }
    }
  }

  return {
    tutor_id: tutor.id,
    nombre: name,
    total: account.total,
    vencido: account.overdueTotal,
    canales: sentChannels,
    errores: errors,
    portal_expira_at: portal.expiresAt,
  };
};

const sendStatementsForAcademy = async ({
  academyId,
  tutorIds = [],
  onlyOverdue = false,
  channels = ['email', 'whatsapp'],
  userId = null,
  via = 'direccion',
  notificationType = 'estado_cuenta',
  dedupePrefix = null,
}) => {
  const requested = new Set((tutorIds || []).map(String));
  const [{ data: academy, error: academyError }, { data: tutors, error: tutorError }] = await Promise.all([
    supabase.from('academias').select('id,nombre').eq('id', academyId).single(),
    supabase.from('tutores').select('id,nombre,nombre_completo,email,telefono').eq('academia_id', academyId).order('nombre_completo'),
  ]);
  if (academyError) throw academyError;
  if (tutorError) throw tutorError;

  const selected = (tutors || []).filter((tutor) => !requested.size || requested.has(String(tutor.id)));
  const detail = [];
  let emails = 0;
  let whatsapps = 0;
  let skipped = 0;
  let errors = 0;

  for (const tutor of selected) {
    try {
      const result = await sendStatementToTutor({ academy, tutor, onlyOverdue, channels, userId, via, notificationType, dedupePrefix });
      detail.push(result);
      emails += result.canales?.includes('email') ? 1 : 0;
      whatsapps += result.canales?.includes('whatsapp') ? 1 : 0;
      errors += result.errores?.length || 0;
      if (!result.canales?.length) skipped += 1;
    } catch (error) {
      errors += 1;
      detail.push({ tutor_id: tutor.id, nombre: tutor.nombre_completo || tutor.nombre || 'Apoderado', total: 0, canales: [], errores: [safe(error?.message, 300)] });
    }
  }

  return { procesados: selected.length, emails, whatsapps, omitidos: skipped, errores: errors, detalle: detail };
};

module.exports = { accountForTutor, sendStatementToTutor, sendStatementsForAcademy };
