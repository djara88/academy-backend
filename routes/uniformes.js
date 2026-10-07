// routes/uniformes.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarMensaje } = require('../services/whatsappService');
const { academyMessage, getAcademyName } = require('../services/academyIdentity');
const { getStudentEnrollment } = require('../services/branchContext');
const { createUniformOrder } = require('../services/uniformOrderService');

// Función auxiliar para validar que sea una talla real de apoderado
const esTallaValidaApoderado = (talla) => {
  if (!talla) return false;
  const t = String(talla).trim().toLowerCase();
  const descartados = [
    'no', 'no desea', 'no requiere', 'no quiere', 'ninguna', 'ninguno', 
    'sin camiseta', 'sin kit', 'n/a', '0', 'undefined', 'null', '', 'no aplica'
  ];
  if (descartados.includes(t)) return false;
  if (t.includes('no desea') || t.includes('sin camiseta') || t.includes('no requiere') || t.includes('no aplica')) return false;
  return true;
};

// ====================================================================
// 1. OBTENER TODO EL MÓDULO (CON PURGA AUTOMÁTICA DE REGISTROS 'NO DESEA')
// ====================================================================
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;

    const [resCatalogo, resPedidos, resJugadores] = await Promise.all([
      supabase.from('prendas_catalogo').select('*').eq('academia_id', academia_id).order('created_at', { ascending: false }),
      supabase.from('pedidos_indumentaria').select('*, prendas_catalogo(tipo_operacion), jugadores(id, nombre, foto_base64, tutor_id)').eq('academia_id', academia_id).order('created_at', { ascending: false }),
      supabase.from('jugadores').select('id, nombre, foto_base64, tutor_id, talla_apoderado').eq('academia_id', academia_id).order('nombre', { ascending: true })
    ]);

    let pedidos = resPedidos.data || [];
    const jugadores = resJugadores.data || [];

    // Purga de registros inválidos
    const idsAEliminar = pedidos
      .filter(p => p.prenda_nombre && p.prenda_nombre.toLowerCase().includes('apoderado') && !esTallaValidaApoderado(p.talla))
      .map(p => p.id);

    if (idsAEliminar.length > 0) {
      await supabase.from('pedidos_indumentaria').delete().in('id', idsAEliminar);
      pedidos = pedidos.filter(p => !idsAEliminar.includes(p.id));
    }

    // Auto-sincronización de apoderados válidos
    const nuevosPedidosApoderados = [];
    for (const jug of jugadores) {
      if (esTallaValidaApoderado(jug.talla_apoderado)) {
        const tallaLimpia = String(jug.talla_apoderado).trim().toUpperCase();
        const yaExiste = pedidos.some(p => p.jugador_id === jug.id && p.prenda_nombre && p.prenda_nombre.toLowerCase().includes('apoderado'));
        
        if (!yaExiste) {
          nuevosPedidosApoderados.push({
            academia_id,
            jugador_id: jug.id,
            prenda_id: null,
            prenda_nombre: 'Camiseta Apoderado',
            talla: tallaLimpia,
            monto: 0,
            estado_pago: 'Incluido en Matrícula',
            estado_entrega: 'Pendiente'
          });
        }
      }
    }

    if (nuevosPedidosApoderados.length > 0) {
      await supabase.from('pedidos_indumentaria').insert(nuevosPedidosApoderados);
      const { data: pedidosActualizados } = await supabase
        .from('pedidos_indumentaria')
        .select('*, prendas_catalogo(tipo_operacion), jugadores(id, nombre, foto_base64, tutor_id)')
        .eq('academia_id', academia_id)
        .order('created_at', { ascending: false });
      if (pedidosActualizados) {
        pedidos = pedidosActualizados.filter(p => !(p.prenda_nombre && p.prenda_nombre.toLowerCase().includes('apoderado') && !esTallaValidaApoderado(p.talla)));
      }
    }

    // Agrupación consolidada para el Reporte del Taller
    const conteoTaller = {};
    pedidos.forEach(p => {
      const esTaller = !p.prendas_catalogo || p.prendas_catalogo.tipo_operacion === 'Taller';
      const st = p.estado_entrega || 'Pendiente';
      
      if (esTaller && (st === 'Pendiente' || st === 'En Taller') && p.talla && esTallaValidaApoderado(p.talla)) {
        const key = `${p.prenda_nombre} (Talla ${p.talla})`;
        conteoTaller[key] = (conteoTaller[key] || 0) + 1;
      }
    });

    res.json({
      success: true,
      data: {
        catalogo: resCatalogo.data || [],
        resumenTaller: conteoTaller,
        pedidos,
        jugadores
      }
    });
  } catch (error) {
    console.error('❌ Error en GET /api/uniformes:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 2. CREAR PRENDA EN EL CATÁLOGO
// ====================================================================
router.post('/catalogo', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { nombre, precio, aplica_numero, aplica_nombre_estampado, tipo_operacion, stock_disponible } = req.body;

    const { data, error } = await supabase
      .from('prendas_catalogo')
      .insert([{
        academia_id,
        nombre,
        precio: Number(precio) || 0,
        aplica_numero: Boolean(aplica_numero),
        aplica_nombre_estampado: Boolean(aplica_nombre_estampado),
        tipo_operacion: tipo_operacion || 'Taller',
        stock_disponible: tipo_operacion === 'Stock' ? (Number(stock_disponible) || 0) : 0
      }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 3. EDITAR PRENDA DEL CATÁLOGO 🔥
// ====================================================================
router.put('/catalogo/:id', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { id } = req.params;
    const { nombre, precio, aplica_numero, aplica_nombre_estampado, tipo_operacion, stock_disponible } = req.body;

    const { data, error } = await supabase
      .from('prendas_catalogo')
      .update({
        nombre,
        precio: Number(precio) || 0,
        aplica_numero: Boolean(aplica_numero),
        aplica_nombre_estampado: Boolean(aplica_nombre_estampado),
        tipo_operacion: tipo_operacion || 'Taller',
        stock_disponible: tipo_operacion === 'Stock' ? (Number(stock_disponible) || 0) : 0
      })
      .eq('id', id)
      .eq('academia_id', academia_id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 4. ELIMINAR PRENDA DEL CATÁLOGO 🔥
// ====================================================================
router.delete('/catalogo/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('prendas_catalogo').delete()
      .eq('id', id)
      .eq('academia_id', req.user.academia_id);
    if (error) throw error;
    res.json({ success: true, message: 'Prenda eliminada del catálogo.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 5. ASIGNAR PRENDA A ALUMNO Y DESCONTAR STOCK SI APLICA
// ====================================================================
router.post('/pedidos', authMiddleware, async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const playerId = String(req.body?.jugador_id || '').trim();
    if (!playerId) return res.status(400).json({ success: false, error: 'Selecciona un alumno.' });

    const enrollment = await getStudentEnrollment(academyId, playerId);
    const garmentId = String(req.body?.prenda_id || '').trim() || null;
    let garment = null;
    if (garmentId) {
      const { data, error } = await supabase.from('prendas_catalogo')
        .select('id,nombre,precio,tipo_operacion,stock_disponible,rama_id')
        .eq('id', garmentId)
        .eq('academia_id', academyId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ success: false, error: 'Prenda no encontrada.' });
      garment = data;
    }

    const result = await createUniformOrder({
      academyId,
      userId: req.user.id,
      enrollment,
      garment,
      garmentId,
      garmentName: req.body?.prenda_nombre,
      size: req.body?.talla,
      jerseyNumber: req.body?.numero_estampado,
      printedName: req.body?.nombre_estampado,
      amount: req.body?.monto ?? garment?.precio,
      generateCharge: req.body?.generar_cobro === true,
      paymentStatus: req.body?.estado_pago,
      idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotency_key,
    });

    return res.status(result.idempotent ? 200 : 201).json({
      success: true,
      reused: result.idempotent,
      message: result.idempotent ? 'El pedido ya había sido creado.' : 'Indumentaria asignada correctamente al alumno.',
      data: result.order,
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      code: error?.code,
      error: error?.message || 'No fue posible asignar la prenda.',
    });
  }
});

router.put('/pedidos/:id/actualizar', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const academyName = await getAcademyName(academia_id);
    const { id } = req.params;
    const { estado_entrega, estado_pago } = req.body;

    const { data: pedidoActual, error: errPedidoActual } = await supabase
      .from('pedidos_indumentaria')
      .select('*, cobro:cobros!pedidos_indumentaria_cobro_id_fkey(id, monto, monto_pagado, estado)')
      .eq('id', id)
      .eq('academia_id', academia_id)
      .maybeSingle();

    if (errPedidoActual) throw errPedidoActual;
    if (!pedidoActual) return res.status(404).json({ success: false, error: 'Pedido no encontrado.' });

    if (estado_pago === 'Pagado' && pedidoActual.cobro) {
      const saldo = Math.max(Number(pedidoActual.cobro.monto || 0) - Number(pedidoActual.cobro.monto_pagado || 0), 0);
      if (saldo > 0) {
        const { error: errPago } = await supabase.rpc('registrar_pago_cobro', {
          p_academia_id: academia_id,
          p_cobro_id: pedidoActual.cobro.id,
          p_monto: saldo,
          p_metodo_pago: 'Registro desde Uniformes',
          p_observaciones: `Pago de ${pedidoActual.prenda_nombre}`,
          p_idempotency_key: `uniforme-${id}-pago-total`,
          p_usuario_id: req.user.id
        });
        if (errPago) throw errPago;
      }
    }

    const updateData = {};
    if (estado_entrega) {
      updateData.estado_entrega = estado_entrega;
      if (estado_entrega === 'Entregado') updateData.fecha_entrega = new Date().toISOString();
    }
    if (estado_pago) {
      updateData.estado_pago = estado_pago;
    }

    const { data: pedido, error } = await supabase
      .from('pedidos_indumentaria')
      .update(updateData)
      .eq('id', id)
      .eq('academia_id', academia_id)
      .select('*, jugadores(nombre, tutor_id)')
      .single();

    if (error) throw error;

    if (estado_entrega === 'Listo para Entrega' && pedido.jugadores?.tutor_id) {
      const { data: tutor } = await supabase.from('tutores').select('telefono, nombre_completo')
        .eq('id', pedido.jugadores.tutor_id).eq('academia_id', academia_id).single();
      if (tutor && tutor.telefono) {
        let numLimpio = tutor.telefono.replace(/\D/g, '');
        if (!numLimpio.startsWith('56') && numLimpio.length === 9) numLimpio = '56' + numLimpio;

        const numText = pedido.numero_estampado ? `#${pedido.numero_estampado}` : 'Sin número';
        const nomText = pedido.nombre_estampado ? `("${pedido.nombre_estampado}")` : '';

        const mensaje = academyMessage(academyName, `👕 *INDUMENTARIA LISTA PARA RETIRO*\n\n` +
          `Hola ${tutor.nombre_completo || 'Apoderado'},\n` +
          `Te informamos que la prenda de *${pedido.jugadores.nombre}* ya está disponible en la cancha:\n\n` +
          `📦 *Prenda:* ${pedido.prenda_nombre}\n` +
          `📏 *Talla:* ${pedido.talla}\n` +
          `🔢 *Detalles:* ${numText} ${nomText}\n\n` +
          `Puedes solicitarla con el profesor a cargo durante el próximo entrenamiento. ⚽💪`);

        try {
          await enviarMensaje(academia_id, numLimpio, mensaje);
        } catch (e) {}
      }
    }

    res.json({ success: true, data: pedido });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
