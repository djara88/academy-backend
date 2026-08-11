// routes/uniformes.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarMensaje } = require('../services/whatsappService');

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
// 1. OBTENER TODO EL MÓDULO (CON PURGA AUTOMÁTICA DE REGISTROS 'NO DESEA') 🔥
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

    // 🔥 A. PURGA AUTOMÁTICA DE REGISTROS ANTIGUOS INVÁLIDOS EN BD
    const idsAEliminar = pedidos
      .filter(p => p.prenda_nombre && p.prenda_nombre.toLowerCase().includes('apoderado') && !esTallaValidaApoderado(p.talla))
      .map(p => p.id);

    if (idsAEliminar.length > 0) {
      await supabase.from('pedidos_indumentaria').delete().in('id', idsAEliminar);
      pedidos = pedidos.filter(p => !idsAEliminar.includes(p.id));
    }

    // B. AUTO-SINCRONIZACIÓN: Crear solo si la talla del apoderado ES VÁLIDA y no existía
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

    // C. Agrupación consolidada para el Reporte del Taller
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
// 2. CREAR PRENDA EN EL CATÁLOGO (STOCK O TALLER)
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
// 3. ASIGNAR PRENDA A ALUMNO Y DESCONTAR STOCK SI APLICA
// ====================================================================
router.post('/pedidos', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugador_id, prenda_id, prenda_nombre, talla, numero_estampado, nombre_estampado, monto, generar_cobro, estado_pago } = req.body;

    let cobroId = null;
    const precioFinal = Number(monto) || 0;

    if (generar_cobro && precioFinal > 0 && estado_pago === 'Pendiente de Pago') {
      const { data: cobroCreado, error: errCobro } = await supabase
        .from('cobros')
        .insert([{
          academia_id,
          jugador_id,
          concepto: `Indumentaria: ${prenda_nombre} (Talla ${talla || 'S/T'})`,
          tipo_concepto: 'Indumentaria',
          monto: precioFinal,
          monto_pagado: 0,
          estado: 'Pendiente',
          fecha_vencimiento: new Date().toISOString().split('T')[0]
        }])
        .select().single();

      if (cobroCreado) cobroId = cobroCreado.id;
    }

    const { data: nuevoPedido, error: errPedido } = await supabase
      .from('pedidos_indumentaria')
      .insert([{
        academia_id,
        jugador_id,
        prenda_id: prenda_id || null,
        prenda_nombre,
        talla: talla || 'S/T',
        numero_estampado: numero_estampado ? Number(numero_estampado) : null,
        nombre_estampado: nombre_estampado || '',
        monto: precioFinal,
        cobro_id: cobroId,
        estado_pago: estado_pago || 'Pendiente de Pago',
        estado_entrega: 'Pendiente'
      }])
      .select().single();

    if (errPedido) throw errPedido;

    if (prenda_id) {
      const { data: prendaData } = await supabase.from('prendas_catalogo').select('tipo_operacion, stock_disponible').eq('id', prenda_id).single();
      if (prendaData && prendaData.tipo_operacion === 'Stock' && prendaData.stock_disponible > 0) {
        await supabase.from('prendas_catalogo').update({ stock_disponible: prendaData.stock_disponible - 1 }).eq('id', prenda_id);
      }
    }

    res.status(201).json({ success: true, message: 'Indumentaria asignada correctamente al alumno.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 4. ACTUALIZAR LOGÍSTICA (Y AVISAR WHATSAPP) O FINANZAS
// ====================================================================
router.put('/pedidos/:id/actualizar', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { id } = req.params;
    const { estado_entrega, estado_pago } = req.body;

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
      .select('*, jugadores(nombre, tutor_id)')
      .single();

    if (error) throw error;

    if (estado_entrega === 'Listo para Entrega' && pedido.jugadores?.tutor_id) {
      const { data: tutor } = await supabase.from('tutores').select('telefono, nombre_completo').eq('id', pedido.jugadores.tutor_id).single();
      if (tutor && tutor.telefono) {
        let numLimpio = tutor.telefono.replace(/\D/g, '');
        if (!numLimpio.startsWith('56') && numLimpio.length === 9) numLimpio = '56' + numLimpio;

        const numText = pedido.numero_estampado ? `#${pedido.numero_estampado}` : 'Sin número';
        const nomText = pedido.nombre_estampado ? `("${pedido.nombre_estampado}")` : '';

        const mensaje = `👕 *INDUMENTARIA LISTA PARA RETIRO*\n\n` +
          `Hola ${tutor.nombre_completo || 'Apoderado'},\n` +
          `Te informamos que la prenda de *${pedido.jugadores.nombre}* ya está disponible en la cancha:\n\n` +
          `📦 *Prenda:* ${pedido.prenda_nombre}\n` +
          `📏 *Talla:* ${pedido.talla}\n` +
          `🔢 *Detalles:* ${numText} ${nomText}\n\n` +
          `Puedes solicitarla con el profesor a cargo durante el próximo entrenamiento. ⚽💪`;

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
