const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { isTrialPlan } = require('../services/planCatalog');
const { getBillingPlan, getBillingQuote, guardianAddonQuote, calculateGrossClp } = require('../services/billingCatalog');
const { PLATFORM_ACCESS_TOKEN, createPreference } = require('../services/mercadoPagoGateway');

const router = express.Router();
router.use(authMiddleware, requireDirector);
const today=()=>new Date().toISOString().slice(0,10);
const addDays=(days)=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);

const createGatewayOrder=async({academyId,charge,title,amountClp,userId})=>{
 const token=PLATFORM_ACCESS_TOKEN();if(!token){const e=new Error('Lestra todavía no tiene Checkout Pro de Mercado Pago configurado.');e.status=503;throw e;}
 const externalReference=`lestra:plataforma:${crypto.randomUUID()}`;
 const {data:order,error}=await supabase.from('payment_gateway_orders').insert({scope:'plataforma',academia_id:academyId,plataforma_cobro_id:charge.id,external_reference:externalReference,amount_expected:amountClp,status:'created',created_by:userId,metadata:{title}}).select('*').single();
 if(error)throw error;
 try{
  const preference=await createPreference({accessToken:token,externalReference,title,amountClp,orderId:order.id,metadata:{scope:'plataforma',academia_id:academyId,plataforma_cobro_id:charge.id}});
  const checkoutUrl=preference?.init_point||preference?.sandbox_init_point;if(!preference?.id||!checkoutUrl)throw new Error('Mercado Pago no devolvió una URL de checkout.');
  const {data:updated,error:updateError}=await supabase.from('payment_gateway_orders').update({preference_id:String(preference.id),checkout_url:checkoutUrl,updated_at:new Date().toISOString()}).eq('id',order.id).select('*').single();if(updateError)throw updateError;return updated;
 }catch(error){await supabase.from('payment_gateway_orders').update({status:'error',metadata:{title,error:String(error.message||error).slice(0,500)},updated_at:new Date().toISOString()}).eq('id',order.id);throw error;}
};

const reserveFounder=async(charge)=>{
 const {data:slot,error}=await supabase.rpc('reservar_syncademia_founder_slot',{p_academia_id:charge.academia_id,p_charge_id:charge.id});if(error)throw error;const number=Number(slot||0)||null;if(!number){const e=new Error('Los 10 cupos de Precio Fundador ya fueron asignados.');e.status=409;e.code='FOUNDER_SOLD_OUT';throw e;}
 const {error:updateError}=await supabase.from('plataforma_cobros').update({founder_slot:number}).eq('id',charge.id);if(updateError)throw updateError;return number;
};

router.post('/plan',async(req,res)=>{
 let charge=null;let founderSlot=null;
 try{
  const plan=getBillingPlan(String(req.body?.plan_code||''));if(!plan)return res.status(400).json({error:'Selecciona un plan válido.'});
  const billingCycle=req.body?.billing_cycle==='annual'?'annual':'monthly';const promotionCode=req.body?.promotion_code==='founder'?'founder':null;const guardians=req.body?.guardian_license===true;
  let quote;try{quote=getBillingQuote({planCode:plan.code,billingCycle,promotionCode,guardians});}catch(error){return res.status(400).json({error:error.message,code:error.code||'INVALID_BILLING_OFFER'});}
  const {data:academy,error:academyError}=await supabase.from('academias').select('id,founder_number,promotion_ends_at').eq('id',req.user.academia_id).single();if(academyError)throw academyError;
  if(promotionCode==='founder'&&academy.founder_number&&academy.promotion_ends_at&&academy.promotion_ends_at<today())return res.status(409).json({error:'Tu período de Precio Fundador de 12 meses ya terminó.',code:'FOUNDER_EXPIRED'});
  const label=promotionCode==='founder'?`${plan.name} · Precio Fundador`:billingCycle==='annual'?`${plan.name} · Anual (12 meses pagando 10)`:`${plan.name} · Mensual`;
  const {data:created,error:chargeError}=await supabase.from('plataforma_cobros').insert({academia_id:req.user.academia_id,concepto:`Suscripción Lestra Deportivo · ${label}${guardians?' + Apoderados PRO':''}`,subtotal_clp:calculateGrossClp({priceClp:quote.baseChargedNetClp}),addon_clp:quote.guardianChargedGrossClp,target_plan_code:plan.code,target_guardian_license:guardians,billing_cycle:quote.billingCycle,billing_period_months:quote.billingPeriodMonths,promotion_code:quote.promotionCode,discount_clp:quote.discountGrossClp,fecha_vencimiento:addDays(3),notas:`Checkout Pro Mercado Pago. Neto total: $${quote.chargedNetClp.toLocaleString('es-CL')} CLP. Total con IVA esperado: $${quote.chargedGrossClp.toLocaleString('es-CL')} CLP.`,created_by:req.user.id}).select('*').single();if(chargeError)throw chargeError;charge=created;
  if(promotionCode==='founder')founderSlot=await reserveFounder(charge);
  const amount=Number(charge.total_clp||quote.chargedGrossClp);const order=await createGatewayOrder({academyId:req.user.academia_id,charge,title:charge.concepto,amountClp:amount,userId:req.user.id});
  await supabase.from('plataforma_cobros').update({checkout_url:order.checkout_url,referencia:order.external_reference,updated_at:new Date().toISOString()}).eq('id',charge.id);
  return res.status(201).json({success:true,data:{chargeId:charge.id,orderId:order.id,checkoutUrl:order.checkout_url,amountClp:amount,netAmountClp:quote.chargedNetClp,planName:plan.name,guardianLicense:guardians,billingCycle:quote.billingCycle,promotionCode:quote.promotionCode,founderSlot,discountClp:quote.discountGrossClp,manualVerification:false}});
 }catch(error){
  if(charge?.id){if(founderSlot)await supabase.from('syncademia_founder_slots').update({academia_id:null,charge_id:null,reserved_until:null,updated_at:new Date().toISOString()}).eq('slot_no',founderSlot).eq('charge_id',charge.id).is('activated_at',null);if(!charge.checkout_url)await supabase.from('plataforma_cobros').delete().eq('id',charge.id).eq('estado','pendiente');}
  console.error('Error preparando suscripción Checkout Pro:',error?.message||error);return res.status(error?.status||500).json({error:error?.message||'No fue posible preparar el pago.',code:error?.code||undefined});
 }
});

router.post('/guardian-addon',async(req,res)=>{
 let charge=null;
 try{
  const {data:academy,error:academyError}=await supabase.from('academias').select('id,plan,plan_codigo,subscription_status,licencia_apoderados,guardian_license_ends_at').eq('id',req.user.academia_id).single();if(academyError)throw academyError;
  if(isTrialPlan(academy))return res.status(409).json({error:'Apoderados PRO ya está incluido durante tu prueba Full.',code:'GUARDIAN_INCLUDED_IN_TRIAL'});
  if(academy.subscription_status!=='active')return res.status(409).json({error:'Activa primero un plan de Lestra Deportivo.',code:'BASE_PLAN_REQUIRED'});
  const cycle=req.body?.billing_cycle==='annual'?'annual':'monthly';const quote=guardianAddonQuote(cycle);
  const {data:created,error}=await supabase.from('plataforma_cobros').insert({academia_id:req.user.academia_id,concepto:`Complemento Lestra Deportivo · Apoderados PRO · ${cycle==='annual'?'Anual (12 meses pagando 10)':'Mensual'}`,subtotal_clp:0,addon_clp:quote.chargedGrossClp,target_plan_code:null,target_guardian_license:true,billing_cycle:quote.billingCycle,billing_period_months:quote.billingPeriodMonths,promotion_code:null,discount_clp:quote.discountGrossClp,fecha_vencimiento:addDays(3),notas:`Checkout Pro Mercado Pago. Neto: $${quote.chargedNetClp.toLocaleString('es-CL')} CLP. Total con IVA: $${quote.chargedGrossClp.toLocaleString('es-CL')} CLP.`,created_by:req.user.id}).select('*').single();if(error)throw error;charge=created;
  const amount=Number(charge.total_clp||quote.chargedGrossClp);const order=await createGatewayOrder({academyId:req.user.academia_id,charge,title:charge.concepto,amountClp:amount,userId:req.user.id});await supabase.from('plataforma_cobros').update({checkout_url:order.checkout_url,referencia:order.external_reference,updated_at:new Date().toISOString()}).eq('id',charge.id);
  return res.status(201).json({success:true,data:{chargeId:charge.id,orderId:order.id,checkoutUrl:order.checkout_url,amountClp:amount,netAmountClp:quote.chargedNetClp,manualVerification:false}});
 }catch(error){if(charge?.id&&!charge.checkout_url)await supabase.from('plataforma_cobros').delete().eq('id',charge.id).eq('estado','pendiente');return res.status(error?.status||500).json({error:error?.message||'No fue posible preparar Apoderados PRO.'});}
});

module.exports=router;
