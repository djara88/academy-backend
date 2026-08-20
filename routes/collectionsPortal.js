const crypto = require('crypto');
const express = require('express');
const supabase = require('../config/supabase');
const { normalizeRut } = require('../services/rutGuard');
const { sendCollectionVerificationEmail } = require('../services/collectionEmail');
const { enviarMensaje } = require('../services/whatsappService');
const { academyMessage } = require('../services/academyIdentity');
const {
  digest,
  createPortalToken,
  loadPortalToken,
  authorizedPlayersForToken,
  normalizePhone,
} = require('../services/collectionPortal');

const router = express.Router();
const safe = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const academyBySlug = async (slugValue) => {
  const slug = safe(slugValue, 100).toLowerCase();
  if (!slug) return null;
  const { data, error } = await supabase.from('academias')
    .select('id,nombre,subdominio,pagina_publica_activa,estado,logo,logo_url,pagina_color_primario,pagina_color_secundario,pagina_color_fondo')
    .ilike('subdominio', slug).maybeSingle();
  if (error) throw error;
  if (!data || data.pagina_publica_activa !== true || String(data.estado || '').toLowerCase() === 'inactiva') return null;
  return data;
};

const resolveRutTarget = async (academyId, rut) => {
  const normalized = normalizeRut(rut);
  if (normalized.length < 7) return null;
  const [tutorsResult, playersResult] = await Promise.all([
    supabase.from('tutores').select('id,nombre,nombre_completo,rut,email,telefono').eq('academia_id', academyId),
    supabase.from('jugadores').select('id,nombre,rut,tutor_id,apoderado_id,tutor_principal_id').eq('academia_id', academyId),
  ]);
  if (tutorsResult.error) throw tutorsResult.error;
  if (playersResult.error) throw playersResult.error;
  const tutors = tutorsResult.data || [];
  const players = playersResult.data || [];
  const tutor = tutors.find((row) => normalizeRut(row.rut) === normalized);
  if (tutor) return { tutor, player: null, normalized };
  const player = players.find((row) => normalizeRut(row.rut) === normalized);
  if (!player) return null;
  const directTutorId = player.tutor_id || player.tutor_principal_id || player.apoderado_id || null;
  let linkedTutorId = directTutorId;
  if (!linkedTutorId) {
    const { data: link, error } = await supabase.from('jugador_tutor').select('tutor_id').eq('jugador_id', player.id).limit(1).maybeSingle();
    if (error) throw error;
    linkedTutorId = link?.tutor_id || null;
  }
  const linkedTutor = tutors.find((row) => String(row.id) === String(linkedTutorId || '')) || null;
  return { tutor: linkedTutor, player, normalized };
};

const sendVerification = async ({ academy, target, code }) => {
  const tutor = target?.tutor;
  if (tutor?.email && /^\S+@\S+\.\S+$/.test(String(tutor.email))) {
    await sendCollectionVerificationEmail({ email: String(tutor.email).trim().toLowerCase(), name: tutor.nombre_completo || tutor.nombre || 'Apoderado', academyName: academy.nombre, code });
    return { sent: true, channel: 'email' };
  }
  const phone = normalizePhone(tutor?.telefono);
  if (phone) {
    await enviarMensaje(academy.id, phone, academyMessage(academy.nombre,
      `🔐 *Código de consulta de pagos*\n\nTu código temporal es *${code}*.\nVence en 10 minutos. Si no solicitaste esta consulta, ignora este mensaje.`));
    return { sent: true, channel: 'whatsapp' };
  }
  return { sent: false, channel: null };
};

const buildStatement = async (tokenRow) => {
  const players = await authorizedPlayersForToken(tokenRow);
  const playerIds = players.map((player) => player.id);
  const [academyResult, configResult, chargesResult] = await Promise.all([
    supabase.from('academias').select('id,nombre,subdominio,logo,logo_url,pagina_color_primario,pagina_color_secundario,pagina_color_fondo').eq('id', tokenRow.academia_id).single(),
    supabase.from('configuracion_financiera')
      .select('acepta_efectivo,acepta_transferencia,acepta_pago_online,transferencia_banco,transferencia_tipo_cuenta,transferencia_numero,transferencia_rut,transferencia_correo,link_pago_online')
      .eq('academia_id', tokenRow.academia_id).maybeSingle(),
    playerIds.length ? supabase.from('cobros')
      .select('id,jugador_id,concepto,tipo_concepto,monto,monto_pagado,estado,fecha_vencimiento,torneo_id,periodo_mensualidad')
      .eq('academia_id', tokenRow.academia_id).in('jugador_id', playerIds).neq('estado', 'Anulado')
      .order('fecha_vencimiento', { ascending: true }) : Promise.resolve({ data: [], error: null }),
  ]);
  if (academyResult.error) throw academyResult.error;
  if (configResult.error) throw configResult.error;
  if (chargesResult.error) throw chargesResult.error;
  const charges = (chargesResult.data || []).filter((charge) => Number(charge.monto || 0) - Number(charge.monto_pagado || 0) > 0);
  const chargeIds = charges.map((charge) => charge.id);
  const [installmentsResult, informedResult] = await Promise.all([
    chargeIds.length ? supabase.from('cobro_cuotas')
      .select('id,cobro_id,numero,total_cuotas,monto,monto_pagado,fecha_vencimiento,estado')
      .eq('academia_id', tokenRow.academia_id).in('cobro_id', chargeIds).neq('estado', 'Anulada').order('numero')
      : Promise.resolve({ data: [], error: null }),
    chargeIds.length ? supabase.from('pagos_informados')
      .select('id,cobro_id,cuota_id,monto,fecha_pago_informada,estado,created_at')
      .eq('academia_id', tokenRow.academia_id).in('cobro_id', chargeIds).eq('estado', 'Pendiente').order('created_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (installmentsResult.error) throw installmentsResult.error;
  if (informedResult.error) throw informedResult.error;
  const installmentsByCharge = new Map();
  for (const row of installmentsResult.data || []) {
    const list = installmentsByCharge.get(String(row.cobro_id)) || [];
    list.push({ ...row, saldo: Math.max(Number(row.monto || 0) - Number(row.monto_pagado || 0), 0), vencida: row.fecha_vencimiento < today() && row.estado !== 'Pagada' });
    installmentsByCharge.set(String(row.cobro_id), list);
  }
  const informedByCharge = new Map();
  for (const row of informedResult.data || []) {
    const list = informedByCharge.get(String(row.cobro_id)) || [];
    list.push(row); informedByCharge.set(String(row.cobro_id), list);
  }
  const outputCharges = charges.map((charge) => ({
    ...charge,
    saldo: Math.max(Number(charge.monto || 0) - Number(charge.monto_pagado || 0), 0),
    vencido: Boolean(charge.fecha_vencimiento && charge.fecha_vencimiento < today()),
    cuotas: installmentsByCharge.get(String(charge.id)) || [],
    pagos_informados_pendientes: informedByCharge.get(String(charge.id)) || [],
  }));
  return {
    academia: { nombre: academyResult.data.nombre, slug: academyResult.data.subdominio, logo: academyResult.data.logo_url || academyResult.data.logo || null, colores: { primario: academyResult.data.pagina_color_primario || '#289E9D', secundario: academyResult.data.pagina_color_secundario || '#70E4DF', fondo: academyResult.data.pagina_color_fondo || '#0D1117' } },
    jugadores: players.map((player) => ({ id: player.id, nombre: player.nombre, estado_financiero: player.estado_financiero || null })),
    cobros: outputCharges,
    saldo_total: outputCharges.reduce((sum, charge) => sum + charge.saldo, 0),
    metodos_pago: configResult.data || null,
    expira_at: tokenRow.expira_at,
  };
};

router.post('/public/:slug/iniciar', async (req, res) => {
  const genericMessage = 'Si el RUT coincide con un registro de la academia, enviaremos un código temporal al contacto informado en la matrícula.';
  try {
    const academy = await academyBySlug(req.params.slug);
    const normalized = normalizeRut(req.body?.rut);
    const fakeId = crypto.randomUUID();
    if (!academy || normalized.length < 7) return res.json({ success: true, verification_id: fakeId, message: genericMessage });
    const target = await resolveRutTarget(academy.id, normalized);
    if (!target || !target.tutor) return res.json({ success: true, verification_id: fakeId, message: genericMessage });
    const code = String(crypto.randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
    const provisionalChannel = target.tutor.email ? 'email' : 'whatsapp';
    const { data: verification, error } = await supabase.from('cobranza_verificaciones').insert({ academia_id: academy.id,tutor_id:target.tutor.id,jugador_id:target.player?.id||null,rut_hash:digest(target.normalized),codigo_hash:digest(code),canal:provisionalChannel,destino_enmascarado:'contacto registrado',expira_at:expiresAt }).select('id').single();
    if (error) throw error;
    try {
      const delivery = await sendVerification({ academy, target, code });
      if (!delivery.sent) { await supabase.from('cobranza_verificaciones').delete().eq('id', verification.id); return res.json({ success:true,verification_id:fakeId,message:genericMessage }); }
      if (delivery.channel !== provisionalChannel) await supabase.from('cobranza_verificaciones').update({ canal: delivery.channel }).eq('id', verification.id);
      return res.json({ success:true,verification_id:verification.id,message:genericMessage });
    } catch (deliveryError) {
      console.error('No se pudo enviar código de cobranza:', deliveryError?.message || deliveryError);
      await supabase.from('cobranza_verificaciones').delete().eq('id', verification.id);
      return res.json({ success:true,verification_id:fakeId,message:genericMessage });
    }
  } catch (error) { console.error('Error iniciando portal de cobranza:', error?.message || error); return res.status(500).json({ error:'No fue posible iniciar la consulta de pagos.' }); }
});

router.post('/public/:slug/verificar', async (req, res) => {
  try {
    const academy = await academyBySlug(req.params.slug);
    if (!academy) return res.status(400).json({ error:'Código inválido o vencido.' });
    const verificationId=safe(req.body?.verification_id,80); const code=safe(req.body?.codigo,12);
    const {data:verification,error}=await supabase.from('cobranza_verificaciones').select('*').eq('id',verificationId).eq('academia_id',academy.id).maybeSingle();
    if(error)throw error;
    if(!verification||verification.verificado_at||verification.intentos>=5||new Date(verification.expira_at).getTime()<=Date.now())return res.status(400).json({error:'Código inválido o vencido.'});
    const expected=Buffer.from(String(verification.codigo_hash),'hex'); const received=Buffer.from(digest(code),'hex');
    const valid=expected.length===received.length&&crypto.timingSafeEqual(expected,received);
    if(!valid){await supabase.from('cobranza_verificaciones').update({intentos:Number(verification.intentos||0)+1}).eq('id',verification.id);return res.status(400).json({error:'Código inválido o vencido.'});}
    await supabase.from('cobranza_verificaciones').update({verificado_at:new Date().toISOString()}).eq('id',verification.id);
    const portal=await createPortalToken({academyId:academy.id,tutorId:verification.tutor_id,playerId:verification.jugador_id,via:'rut_otp',ttlMinutes:30});
    return res.json({success:true,token:portal.token,expira_at:portal.expiresAt});
  } catch(error){console.error('Error verificando portal de cobranza:',error?.message||error);return res.status(500).json({error:'No fue posible verificar el código.'});}
});

router.get('/public/estado/:token', async (req,res)=>{
  try{const tokenRow=await loadPortalToken(req.params.token);if(!tokenRow)return res.status(401).json({error:'El enlace de consulta venció o ya no es válido.'});return res.json({success:true,data:await buildStatement(tokenRow)});}catch(error){console.error('Error cargando estado de cuenta público:',error?.message||error);return res.status(500).json({error:'No fue posible cargar el estado de cuenta.'});}
});

router.post('/public/pagos-informados/:token', async (req,res)=>{
  try{
    const tokenRow=await loadPortalToken(req.params.token);if(!tokenRow)return res.status(401).json({error:'El enlace de consulta venció o ya no es válido.'});
    const {data:paymentConfig,error:configError}=await supabase.from('configuracion_financiera').select('acepta_transferencia').eq('academia_id',tokenRow.academia_id).maybeSingle();
    if(configError)throw configError;
    if(paymentConfig?.acepta_transferencia!==true)return res.status(409).json({error:'Esta academia no tiene habilitado el reporte de transferencias.'});
    const players=await authorizedPlayersForToken(tokenRow);const playerIds=new Set(players.map((player)=>String(player.id)));const chargeId=safe(req.body?.cobro_id,80);
    const {data:charge,error:chargeError}=await supabase.from('cobros').select('id,jugador_id,monto,monto_pagado,estado').eq('id',chargeId).eq('academia_id',tokenRow.academia_id).maybeSingle();
    if(chargeError)throw chargeError;
    if(!charge||!playerIds.has(String(charge.jugador_id))||['Pagado','Anulado'].includes(charge.estado))return res.status(404).json({error:'Cobro no disponible.'});

    const {data:pendingReports,error:pendingError}=await supabase.from('pagos_informados').select('id,cuota_id,monto').eq('academia_id',tokenRow.academia_id).eq('cobro_id',charge.id).eq('estado','Pendiente');
    if(pendingError)throw pendingError;
    const pendingTotal=(pendingReports||[]).reduce((sum,row)=>sum+Number(row.monto||0),0);
    const chargeBalance=Math.max(Number(charge.monto||0)-Number(charge.monto_pagado||0)-pendingTotal,0);
    const amount=Number(req.body?.monto);
    if(!Number.isFinite(amount)||amount<=0||amount>chargeBalance)return res.status(400).json({error:'El monto informado supera el saldo disponible considerando pagos que ya esperan validación.'});

    const installmentId=safe(req.body?.cuota_id,80)||null;
    if(installmentId){
      const {data:installment,error}=await supabase.from('cobro_cuotas').select('id,cobro_id,monto,monto_pagado,estado').eq('id',installmentId).eq('cobro_id',charge.id).eq('academia_id',tokenRow.academia_id).maybeSingle();if(error)throw error;
      const pendingQuota=(pendingReports||[]).filter((row)=>String(row.cuota_id||'')===String(installmentId)).reduce((sum,row)=>sum+Number(row.monto||0),0);
      const balance=installment?Math.max(Number(installment.monto||0)-Number(installment.monto_pagado||0)-pendingQuota,0):0;
      if(!installment||installment.estado==='Anulada'||amount>balance)return res.status(400).json({error:'La cuota seleccionada no admite ese monto considerando pagos que esperan validación.'});
    }

    const clientKey=safe(req.body?.idempotency_key,100)||crypto.randomUUID();const idempotencyKey=`portal-${tokenRow.id}-${clientKey}`;
    const {data:existing,error:existingError}=await supabase.from('pagos_informados').select('id,estado').eq('academia_id',tokenRow.academia_id).eq('idempotency_key',idempotencyKey).maybeSingle();if(existingError)throw existingError;if(existing)return res.json({success:true,data:existing,message:'Este pago ya había sido informado.'});
    const paymentDate=/^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.fecha_pago||''))?String(req.body.fecha_pago):today();
    if(paymentDate>today())return res.status(400).json({error:'La fecha de transferencia no puede estar en el futuro.'});
    const {data,error}=await supabase.from('pagos_informados').insert({academia_id:tokenRow.academia_id,cobro_id:charge.id,cuota_id:installmentId,jugador_id:charge.jugador_id,tutor_id:tokenRow.tutor_id||null,monto:amount,metodo_pago:'Transferencia',fecha_pago_informada:paymentDate,comprobante_ref:safe(req.body?.comprobante_ref,1000)||null,observaciones:safe(req.body?.observaciones,1000)||null,estado:'Pendiente',canal:'portal',idempotency_key:idempotencyKey}).select('id,estado,monto,fecha_pago_informada,created_at').single();if(error)throw error;
    return res.status(201).json({success:true,data,message:'Pago informado. La academia debe validarlo antes de que se descuente de tu estado de cuenta.'});
  }catch(error){console.error('Error informando pago desde portal:',error?.message||error);return res.status(500).json({error:error?.message||'No fue posible informar el pago.'});}
});

module.exports=router;