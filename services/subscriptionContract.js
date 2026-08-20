const supabase = require('../config/supabase');
const { getBillingPlan, getBillingQuote, calculateGrossClp } = require('./billingCatalog');

const DAY_MS = 24 * 60 * 60 * 1000;
const RENEWAL_WINDOW_DAYS = 7;
const clean = (value, max = 240) => String(value ?? '').trim().replace(/[\r\n|]+/g, ' ').slice(0, max);
const today = () => new Date().toISOString().slice(0, 10);
const normalizeCycle = (value) => value === 'annual' ? 'annual' : 'monthly';

const addMonths = (dateValue, months) => {
  const date = new Date(`${String(dateValue).slice(0, 10)}T12:00:00Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + Number(months || 0));
  const maxDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, maxDay));
  return date.toISOString().slice(0, 10);
};

const previousDay = (dateValue) => new Date(Date.parse(`${dateValue}T12:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

const normalizeBillingProfile = (payload = {}) => ({
  documento_tipo: payload.documento_tipo === 'boleta' ? 'boleta' : 'factura',
  rut: clean(payload.rut, 30),
  razon_social: clean(payload.razon_social, 180),
  giro: clean(payload.giro, 180) || null,
  direccion: clean(payload.direccion, 220) || null,
  comuna: clean(payload.comuna, 120) || null,
  ciudad: clean(payload.ciudad, 120) || null,
  email: clean(payload.email, 180).toLowerCase(),
  contacto_nombre: clean(payload.contacto_nombre, 160) || null,
});

const validateBillingProfile = (profile) => {
  if (!['boleta', 'factura'].includes(profile.documento_tipo)) return 'Selecciona Boleta o Factura.';
  if (!profile.rut) return 'Ingresa el RUT para el documento tributario.';
  if (!profile.razon_social) return profile.documento_tipo === 'factura' ? 'Ingresa la razón social.' : 'Ingresa el nombre para la boleta.';
  if (!/^\S+@\S+\.\S+$/.test(profile.email || '')) return 'Ingresa un correo válido para recibir el documento.';
  if (profile.documento_tipo === 'factura') {
    if (!profile.giro) return 'Ingresa el giro para la factura.';
    if (!profile.direccion) return 'Ingresa la dirección para la factura.';
    if (!profile.comuna) return 'Ingresa la comuna para la factura.';
    if (!profile.ciudad) return 'Ingresa la ciudad para la factura.';
  }
  return null;
};

const getBillingProfile = async (academyId) => {
  const { data, error } = await supabase.from('academia_facturacion').select('*').eq('academia_id', academyId).maybeSingle();
  if (error) throw error;
  return data || null;
};

const saveBillingProfile = async ({ academyId, userId, payload }) => {
  const profile = normalizeBillingProfile(payload);
  const validationError = validateBillingProfile(profile);
  if (validationError) {
    const error = new Error(validationError);
    error.status = 400;
    error.code = 'INVALID_BILLING_PROFILE';
    throw error;
  }
  const { data, error } = await supabase.from('academia_facturacion').upsert({
    academia_id: academyId,
    ...profile,
    updated_by: userId || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'academia_id' }).select('*').single();
  if (error) throw error;
  return data;
};

const billingSnapshot = (profile) => profile ? {
  documento_tipo: profile.documento_tipo,
  rut: profile.rut,
  razon_social: profile.razon_social,
  giro: profile.giro || null,
  direccion: profile.direccion || null,
  comuna: profile.comuna || null,
  ciudad: profile.ciudad || null,
  email: profile.email,
  contacto_nombre: profile.contacto_nombre || null,
  captured_at: new Date().toISOString(),
} : null;

const getAcademyContract = async (academyId) => {
  const { data, error } = await supabase.from('academias').select([
    'id','nombre','plan','plan_codigo','subscription_status','billing_cycle','billing_amount_clp','next_billing_date',
    'plan_price_clp','guardian_price_clp','licencia_apoderados','guardian_license_ends_at','promotion_code','promotion_ends_at',
    'founder_number','contract_locked_at','contract_source_charge_id'
  ].join(',')).eq('id', academyId).single();
  if (error) throw error;
  return data;
};

const getOpenChangeRequest = async (academyId) => {
  const { data, error } = await supabase.from('subscription_change_requests').select('*')
    .eq('academia_id', academyId).in('status', ['pending', 'approved']).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
};

const quoteForTarget = ({ planCode, billingCycle, guardians, promotionCode = null }) => {
  const plan = getBillingPlan(planCode);
  if (!plan) {
    const error = new Error('El contrato tiene un plan no reconocido.');
    error.status = 409;
    error.code = 'INVALID_CONTRACT_PLAN';
    throw error;
  }
  const quote = getBillingQuote({ planCode, billingCycle, promotionCode, guardians });
  return { plan, quote };
};

const getRenewalTarget = async (academy) => {
  const request = await getOpenChangeRequest(academy.id);
  if (request?.status === 'approved' && (!request.effective_from || request.effective_from <= academy.next_billing_date)) {
    return {
      planCode: request.requested_plan_code,
      billingCycle: normalizeCycle(request.requested_billing_cycle),
      guardians: Boolean(request.requested_guardian_license),
      promotionCode: null,
      request,
    };
  }
  const founderStillValid = academy.promotion_code === 'founder'
    && academy.promotion_ends_at
    && academy.next_billing_date
    && academy.promotion_ends_at >= academy.next_billing_date
    && normalizeCycle(academy.billing_cycle) === 'monthly';
  return {
    planCode: academy.plan_codigo,
    billingCycle: normalizeCycle(academy.billing_cycle),
    guardians: Boolean(academy.licencia_apoderados),
    promotionCode: founderStillValid ? 'founder' : null,
    request: request?.status === 'pending' ? request : null,
  };
};

const ensureRenewalChargeForAcademy = async (academyOrId, { force = false } = {}) => {
  const academy = typeof academyOrId === 'string' ? await getAcademyContract(academyOrId) : academyOrId;
  if (!academy?.contract_locked_at || academy.subscription_status !== 'active' || !academy.next_billing_date || !academy.plan_codigo) return null;
  if (!force) {
    const threshold = new Date(Date.now() + RENEWAL_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
    if (academy.next_billing_date > threshold) return null;
  }

  const { data: existing, error: existingError } = await supabase.from('plataforma_cobros').select('*')
    .eq('academia_id', academy.id).eq('charge_kind', 'renewal').eq('periodo_inicio', academy.next_billing_date)
    .in('estado', ['pendiente', 'vencido', 'pagado']).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing;

  const target = await getRenewalTarget(academy);
  const { plan, quote } = quoteForTarget(target);
  const profile = await getBillingProfile(academy.id);
  const periodEndExclusive = addMonths(academy.next_billing_date, quote.billingPeriodMonths);
  const concept = `Renovación Lestra Deportivo · ${plan.name} · ${quote.billingCycle === 'annual' ? 'Anual (12 meses pagando 10)' : 'Mensual'}${target.guardians ? ' + Apoderados PRO' : ''}`;
  const row = {
    academia_id: academy.id,
    concepto: concept,
    periodo_inicio: academy.next_billing_date,
    periodo_fin: previousDay(periodEndExclusive),
    subtotal_clp: calculateGrossClp({ priceClp: quote.baseChargedNetClp }),
    addon_clp: quote.guardianChargedGrossClp,
    target_plan_code: plan.code,
    target_guardian_license: target.guardians,
    billing_cycle: quote.billingCycle,
    billing_period_months: quote.billingPeriodMonths,
    promotion_code: quote.promotionCode,
    discount_clp: quote.discountGrossClp,
    fecha_vencimiento: academy.next_billing_date,
    charge_kind: 'renewal',
    change_request_id: target.request?.status === 'approved' ? target.request.id : null,
    billing_document_type: profile?.documento_tipo || null,
    billing_snapshot: billingSnapshot(profile),
    notas: 'Renovación generada automáticamente según el contrato vigente de Lestra.',
  };
  const { data, error } = await supabase.from('plataforma_cobros').insert(row).select('*').single();
  if (error) {
    if (error.code === '23505') {
      const { data: raced, error: racedError } = await supabase.from('plataforma_cobros').select('*')
        .eq('academia_id', academy.id).eq('charge_kind', 'renewal').eq('periodo_inicio', academy.next_billing_date)
        .in('estado', ['pendiente', 'vencido', 'pagado']).maybeSingle();
      if (racedError) throw racedError;
      return raced;
    }
    throw error;
  }
  return data;
};

const getContractState = async (academyId) => {
  const academy = await getAcademyContract(academyId);
  if (academy.contract_locked_at) await ensureRenewalChargeForAcademy(academy);
  const [profile, requestResult, chargeResult] = await Promise.all([
    getBillingProfile(academyId),
    supabase.from('subscription_change_requests').select('*').eq('academia_id', academyId).in('status', ['pending', 'approved']).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('plataforma_cobros').select('*').eq('academia_id', academyId).eq('charge_kind', 'renewal').in('estado', ['pendiente', 'vencido']).order('periodo_inicio', { ascending: true }).limit(1).maybeSingle(),
  ]);
  if (requestResult.error) throw requestResult.error;
  if (chargeResult.error) throw chargeResult.error;
  return {
    locked: Boolean(academy.contract_locked_at),
    lockedAt: academy.contract_locked_at || null,
    academy,
    billingProfile: profile,
    changeRequest: requestResult.data || null,
    pendingRenewal: chargeResult.data || null,
  };
};

const cancelCompetingInitialCheckouts = async (charge) => {
  const { data: rows, error } = await supabase.from('plataforma_cobros').select('id,founder_slot')
    .eq('academia_id', charge.academia_id)
    .eq('estado', 'pendiente')
    .in('charge_kind', ['manual', 'initial'])
    .not('target_plan_code', 'is', null)
    .neq('id', charge.id);
  if (error) throw error;
  const ids = (rows || []).map((row) => row.id);
  if (!ids.length) return;
  const now = new Date().toISOString();
  const { error: cancelError } = await supabase.from('plataforma_cobros').update({ estado: 'anulado', updated_at: now }).in('id', ids);
  if (cancelError) throw cancelError;
  const { error: orderError } = await supabase.from('payment_gateway_orders').update({ status: 'cancelled', updated_at: now })
    .eq('scope', 'plataforma').in('plataforma_cobro_id', ids).in('status', ['created', 'pending']);
  if (orderError) throw orderError;
  const { error: founderError } = await supabase.from('syncademia_founder_slots').update({
    academia_id: null,
    charge_id: null,
    reserved_until: null,
    updated_at: now,
  }).in('charge_id', ids).is('activated_at', null);
  if (founderError) throw founderError;
};

const lockContractFromCharge = async (charge) => {
  if (!charge?.academia_id || !charge?.target_plan_code) return;
  const { error } = await supabase.from('academias').update({
    contract_locked_at: new Date().toISOString(),
    contract_source_charge_id: charge.id,
  }).eq('id', charge.academia_id).is('contract_locked_at', null);
  if (error) throw error;
  if (charge.charge_kind === 'initial' || charge.charge_kind === 'manual' || !charge.charge_kind) {
    await cancelCompetingInitialCheckouts(charge);
  }
};

const ensureSubscriptionExpense = async ({ charge, paymentId = null, paidAt = null, method = 'Mercado Pago', reference = null }) => {
  if (!charge?.id || !charge?.academia_id) return null;
  const { data: existing, error: existingError } = await supabase.from('egresos').select('id').eq('plataforma_cobro_id', charge.id).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing.id;
  const paymentMethod = clean(method, 80) || 'Mercado Pago';
  const receiptReference = clean(reference, 120) || (paymentId ? `${paymentMethod} ${paymentId}` : null);
  const { data, error } = await supabase.from('egresos').insert({
    academia_id: charge.academia_id,
    concepto: charge.concepto,
    categoria_gasto: 'Software / Suscripción Lestra',
    centro_costo: 'Administración',
    monto: Number(charge.total_clp || 0),
    metodo_pago: paymentMethod,
    fecha_gasto: String(paidAt || new Date().toISOString()).slice(0, 10),
    comprobante_ref: receiptReference,
    observaciones: `Egreso generado automáticamente por el pago de Lestra${charge.billing_document_type ? ` · ${charge.billing_document_type}` : ''}.`,
    plataforma_cobro_id: charge.id,
  }).select('id').single();
  if (error) {
    if (error.code === '23505') return null;
    throw error;
  }
  return data?.id || null;
};

const startSubscriptionRenewalAutomation = () => {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const threshold = new Date(Date.now() + RENEWAL_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
      const { data, error } = await supabase.from('academias').select([
        'id','nombre','plan','plan_codigo','subscription_status','billing_cycle','billing_amount_clp','next_billing_date',
        'plan_price_clp','guardian_price_clp','licencia_apoderados','guardian_license_ends_at','promotion_code','promotion_ends_at',
        'founder_number','contract_locked_at','contract_source_charge_id'
      ].join(',')).not('contract_locked_at', 'is', null).eq('subscription_status', 'active').lte('next_billing_date', threshold);
      if (error) throw error;
      for (const academy of data || []) {
        try { await ensureRenewalChargeForAcademy(academy); }
        catch (academyError) { console.error(`Renovación Lestra falló para academia ${academy.id}:`, academyError?.message || academyError); }
      }
    } catch (error) {
      console.error('Automatización de renovaciones Lestra falló:', error?.message || error);
    } finally { running = false; }
  };
  const warmup = setTimeout(() => void run(), 60_000);
  warmup.unref?.();
  const timer = setInterval(() => void run(), 60 * 60 * 1000);
  timer.unref?.();
  return { stop() { clearTimeout(warmup); clearInterval(timer); }, runNow: run };
};

module.exports = {
  RENEWAL_WINDOW_DAYS,
  normalizeBillingProfile,
  validateBillingProfile,
  getBillingProfile,
  saveBillingProfile,
  billingSnapshot,
  getAcademyContract,
  getOpenChangeRequest,
  getContractState,
  ensureRenewalChargeForAcademy,
  lockContractFromCharge,
  ensureSubscriptionExpense,
  startSubscriptionRenewalAutomation,
  addMonths,
};