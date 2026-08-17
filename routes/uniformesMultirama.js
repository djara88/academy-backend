const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { getAcademyName, academyMessage } = require('../services/academyIdentity');
const { enviarMensaje } = require('../services/whatsappService');
const {
  getBranch,
  getStudentEnrollment,
  getActiveEnrollments,
  getPlayersForEnrollments,
  listAcademyBranches,
  safeText,
} = require('../services/branchContext');

const router = express.Router();
router.use(authMiddleware);

const validGuardianSize = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  return !['no','no desea','no requiere','no quiere','ninguna','ninguno','sin camiseta','sin kit','n/a','0','undefined','null','no aplica'].includes(text)
    && !text.includes('no desea') && !text.includes('sin camiseta') && !text.includes('no requiere') && !text.includes('no aplica');
};

const catalogScope = async (academyId, branchId) => {
  if (!branchId) return { rama_id: null, sede_id: null };
  const branch = await getBranch(academyId, branchId);
  return { rama_id: branch.id, sede_id: branch.sede_id, branch };
};

const decorateStudents = async (academyId, branchId) => {
  const enrollments = await getActiveEnrollments({ academyId, branchId: branchId || undefined });
  const players = await getPlayersForEnrollments(
    academyId,
    enrollments,
    'id,nombre,foto_base64,foto_url,avatar_url,tutor_id,talla_apoderado,talla_uniforme,numero_camiseta,nombre_camiseta',
  );
  const byPlayer = new Map();
  for (const enrollment of enrollments) {
    const list = byPlayer.get(String(enrollment.jugador_id)) || [];
    list.push(enrollment);
    byPlayer.set(String(enrollment.jugador_id), list);
  }
  return players.map((player) => ({ ...player, inscripciones: byPlayer.get(String(player.id)) || [] }));
};

const buildWorkshopSummary = (orders) => {
  const summary = {};
  for (const order of orders || []) {
    const workshop = !order.prendas_catalogo || order.prendas_catalogo.tipo_operacion === 'Taller';
    const status = order.estado_entrega || 'Pendiente';
    if (!workshop || !['Pendiente','En Taller'].includes(status) || !order.talla || !validGuardianSize(order.talla)) continue;
    const key = `${order.prenda_nombre} (Talla ${order.talla})`;
    summary[key] = (summary[key] || 0) + 1;
  }
  return summary;
};

router.get('/', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const branchId = safeText(req.query?.rama_id, 80);
    if (branchId) await getBranch(academyId, branchId);

    let catalogQuery = supabase.from('prendas_catalogo')
      .select('*,ramas(id,nombre,disciplina),sedes(id,nombre)')
      .eq('academia_id', academyId)
      .order('created_at', { ascending: false });
    let ordersQuery = supabase.from('pedidos_indumentaria')
      .select('*,prendas_catalogo(tipo_operacion,rama_id),jugadores(id,nombre,foto_base64,foto_url,avatar_url,tutor_id),ramas(id,nombre,disciplina),sedes(id,nombre),inscripciones_deportivas(id,categoria_id,rol_especialidad)')
      .eq('academia_id', academyId)
      .order('created_at', { ascending: false });

    if (branchId) {
      catalogQuery = catalogQuery.or(`rama_id.is.null,rama_id.eq.${branchId}`);
      ordersQuery = ordersQuery.eq('rama_id', branchId);
    }

    const [catalogResult, ordersResult, branches, students] = await Promise.all([
      catalogQuery,
      ordersQuery,
      listAcademyBranches(academyId),
      decorateStudents(academyId, branchId || null),
    ]);
    if (catalogResult.error) throw catalogResult.error;
    if (ordersResult.error) throw ordersResult.error;

    const orders = (ordersResult.data || []).filter((order) => !(String(order.prenda_nombre || '').toLowerCase().includes('apoderado') && !validGuardianSize(order.talla)));
    return res.json({
      success: true,
      data: {
        ramas: branches,
        rama_seleccionada_id: branchId || null,
        catalogo: catalogResult.data || [],
        pedidos: orders,
        alumnos: students,
        resumenTaller: buildWorkshopSummary(orders),
      },
    });
  } catch (error) {
    console.error('Error cargando Uniformes multirrama:', error?.message || error);
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar Uniformes.' });
  }
});

router.post('/catalogo', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const scope = await catalogScope(academyId, safeText(req.body?.rama_id, 80));
    const name = safeText(req.body?.nombre, 180);
    if (!name) return res.status(400).json({ error: 'El nombre de la prenda es obligatorio.' });
    const operation = req.body?.tipo_operacion === 'Stock' ? 'Stock' : 'Taller';
    const { data, error } = await supabase.from('prendas_catalogo').insert({
      academia_id: academyId,
      sede_id: scope.sede_id,
      rama_id: scope.rama_id,
      nombre: name,
      precio: Math.max(0, Number(req.body?.precio) || 0),
      aplica_numero: Boolean(req.body?.aplica_numero),
      aplica_nombre_estampado: Boolean(req.body?.aplica_nombre_estampado),
      tipo_operacion: operation,
      stock_disponible: operation === 'Stock' ? Math.max(0, Math.round(Number(req.body?.stock_disponible) || 0)) : 0,
    }).select('*,ramas(id,nombre,disciplina),sedes(id,nombre)').single();
    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible crear la prenda.' });
  }
});

router.put('/catalogo/:id', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const { data: current, error: currentError } = await supabase.from('prendas_catalogo')
      .select('*').eq('id', req.params.id).eq('academia_id', academyId).maybeSingle();
    if (currentError) throw currentError;
    if (!current) return res.status(404).json({ error: 'Prenda no encontrada.' });
    const scope = req.body?.rama_id !== undefined
      ? await catalogScope(academyId, safeText(req.body?.rama_id, 80))
      : { rama_id: current.rama_id, sede_id: current.sede_id };
    const operation = req.body?.tipo_operacion === 'Stock' ? 'Stock' : (req.body?.tipo_operacion === 'Taller' ? 'Taller' : current.tipo_operacion);
    const { data, error } = await supabase.from('prendas_catalogo').update({
      nombre: req.body?.nombre !== undefined ? safeText(req.body.nombre, 180) : current.nombre,
      precio: req.body?.precio !== undefined ? Math.max(0, Number(req.body.precio) || 0) : current.precio,
      aplica_numero: req.body?.aplica_numero !== undefined ? Boolean(req.body.aplica_numero) : current.aplica_numero,
      aplica_nombre_estampado: req.body?.aplica_nombre_estampado !== undefined ? Boolean(req.body.aplica_nombre_estampado) : current.aplica_nombre_estampado,
      tipo_operacion: operation,
      stock_disponible: operation === 'Stock'
        ? Math.max(0, Math.round(Number(req.body?.stock_disponible ?? current.stock_disponible) || 0))
        : 0,
      sede_id: scope.sede_id,
      rama_id: scope.rama_id,
    }).eq('id', current.id).eq('academia_id', academyId)
      .select('*,ramas(id,nombre,disciplina),sedes(id,nombre)').single();
    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible actualizar la prenda.' });
  }
});

router.delete('/catalogo/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('prendas_catalogo').delete()
      .eq('id', req.params.id).eq('academia_id', req.user.academia_id);
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'No fue posible eliminar la prenda.' });
  }
});

router.post('/pedidos', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const playerId = safeText(req.body?.jugador_id, 80);
    const branchId = safeText(req.body?.rama_id, 80);
    if (!playerId || !branchId) return res.status(400).json({ error: 'Selecciona alumno y rama para asignar la prenda.' });
    const enrollment = await getStudentEnrollment(academyId, playerId, { branchId });

    let garment = null;
    const garmentId = safeText(req.body?.prenda_id, 80);
    if (garmentId) {
      const { data, error } = await supabase.from('prendas_catalogo').select('*')
        .eq('id', garmentId).eq('academia_id', academyId).maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Prenda no encontrada.' });
      if (data.rama_id && String(data.rama_id) !== String(branchId)) {
        return res.status(409).json({ error: 'Esta prenda pertenece a otra rama deportiva.', code: 'GARMENT_BRANCH_MISMATCH' });
      }
      garment = data;
    }

    const garmentName = safeText(req.body?.prenda_nombre || garment?.nombre, 180);
    if (!garmentName) return res.status(400).json({ error: 'Selecciona o indica una prenda.' });
    const amount = Math.max(0, Number(req.body?.monto ?? garment?.precio) || 0);
    let chargeId = null;
    if (req.body?.generar_cobro === true && amount > 0 && req.body?.estado_pago !== 'Pagado') {
      const { data: charge, error } = await supabase.from('cobros').insert({
        academia_id: academyId,
        jugador_id: playerId,
        inscripcion_id: enrollment.id,
        sede_id: enrollment.sede_id,
        rama_id: enrollment.rama_id,
        concepto: `Indumentaria · ${garmentName} (Talla ${safeText(req.body?.talla, 30) || 'S/T'})`,
        tipo_concepto: 'Indumentaria',
        monto: amount,
        monto_pagado: 0,
        estado: 'Pendiente',
        fecha_vencimiento: new Date().toISOString().slice(0, 10),
      }).select('id').single();
      if (error) throw error;
      chargeId = charge.id;
    }

    const { data: order, error: orderError } = await supabase.from('pedidos_indumentaria').insert({
      academia_id: academyId,
      jugador_id: playerId,
      inscripcion_id: enrollment.id,
      sede_id: enrollment.sede_id,
      rama_id: enrollment.rama_id,
      prenda_id: garment?.id || null,
      prenda_nombre: garmentName,
      talla: safeText(req.body?.talla, 30) || 'S/T',
      numero_estampado: req.body?.numero_estampado === '' || req.body?.numero_estampado == null ? null : Number(req.body.numero_estampado),
      nombre_estampado: safeText(req.body?.nombre_estampado, 80),
      monto: amount,
      cobro_id: chargeId,
      estado_pago: safeText(req.body?.estado_pago, 60) || 'Pendiente de Pago',
      estado_entrega: 'Pendiente',
    }).select('*').single();
    if (orderError) {
      if (chargeId) await supabase.from('cobros').delete().eq('id', chargeId).eq('academia_id', academyId);
      throw orderError;
    }

    if (garment?.tipo_operacion === 'Stock') {
      if (Number(garment.stock_disponible || 0) <= 0) {
        await supabase.from('pedidos_indumentaria').delete().eq('id', order.id);
        if (chargeId) await supabase.from('cobros').delete().eq('id', chargeId).eq('academia_id', academyId);
        return res.status(409).json({ error: 'No queda stock disponible de esta prenda.' });
      }
      const { error: stockError } = await supabase.from('prendas_catalogo')
        .update({ stock_disponible: Number(garment.stock_disponible) - 1 })
        .eq('id', garment.id).eq('academia_id', academyId).eq('stock_disponible', garment.stock_disponible);
      if (stockError) throw stockError;
    }

    return res.status(201).json({ success: true, message: 'Indumentaria asignada a la rama seleccionada.', data: order });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible asignar la prenda.', code: error?.code });
  }
});

router.put('/pedidos/:id/actualizar', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const { data: current, error: currentError } = await supabase.from('pedidos_indumentaria')
      .select('*,cobro:cobros!pedidos_indumentaria_cobro_id_fkey(id,monto,monto_pagado,estado),jugadores(nombre,tutor_id)')
      .eq('id', req.params.id).eq('academia_id', academyId).maybeSingle();
    if (currentError) throw currentError;
    if (!current) return res.status(404).json({ error: 'Pedido no encontrado.' });

    const changes = {};
    if (req.body?.estado_entrega) {
      changes.estado_entrega = safeText(req.body.estado_entrega, 60);
      if (changes.estado_entrega === 'Entregado') changes.fecha_entrega = new Date().toISOString();
    }
    if (req.body?.estado_pago) changes.estado_pago = safeText(req.body.estado_pago, 60);

    if (changes.estado_pago === 'Pagado' && current.cobro) {
      const balance = Math.max(Number(current.cobro.monto || 0) - Number(current.cobro.monto_pagado || 0), 0);
      if (balance > 0) {
        const { error: paymentError } = await supabase.rpc('registrar_pago_cobro', {
          p_academia_id: academyId,
          p_cobro_id: current.cobro.id,
          p_monto: balance,
          p_metodo_pago: 'Registro desde Uniformes',
          p_observaciones: `Pago de ${current.prenda_nombre}`,
          p_idempotency_key: `uniforme-${current.id}-pago-total`,
          p_usuario_id: req.user.id,
        });
        if (paymentError) throw paymentError;
      }
    }

    const { data: order, error } = await supabase.from('pedidos_indumentaria')
      .update(changes).eq('id', current.id).eq('academia_id', academyId)
      .select('*,jugadores(nombre,tutor_id),ramas(id,nombre,disciplina)').single();
    if (error) throw error;

    if (changes.estado_entrega === 'Listo para Entrega' && order.jugadores?.tutor_id) {
      const [{ data: tutor }, academyName] = await Promise.all([
        supabase.from('tutores').select('telefono,nombre_completo').eq('id', order.jugadores.tutor_id).eq('academia_id', academyId).maybeSingle(),
        getAcademyName(academyId),
      ]);
      if (tutor?.telefono) {
        let phone = String(tutor.telefono).replace(/\D/g, '');
        if (!phone.startsWith('56') && phone.length === 9) phone = `56${phone}`;
        const branchText = order.ramas?.nombre ? `\n🏷️ *Rama:* ${order.ramas.nombre}` : '';
        await enviarMensaje(academyId, phone, academyMessage(academyName,
          `👕 *INDUMENTARIA LISTA PARA RETIRO*\n\nHola ${tutor.nombre_completo || 'Apoderado/a'}, la prenda de *${order.jugadores.nombre}* está disponible.\n📦 *Prenda:* ${order.prenda_nombre}\n📏 *Talla:* ${order.talla}${branchText}`));
      }
    }
    return res.json({ success: true, data: order });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'No fue posible actualizar el pedido.' });
  }
});

module.exports = router;
