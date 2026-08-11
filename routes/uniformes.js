// routes/uniformes.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarMensaje } = require('../services/whatsappService');

// ====================================================================
// 1. OBTENER RESUMEN DE INDUMENTARIA, CATÁLOGO Y PEDIDOS
// ====================================================================
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;

    const [resCatalogo, resPedidos, resJugadores] = await Promise.all([
      supabase.from('prendas_catalogo').select('*').eq('academia_id', academia_id),
      supabase.from('pedidos_indumentaria').select('*, jugadores(id, nombre, foto_base64, tutor_id)').eq('academia_id', academia_id).order('created_at', { ascending: false }),
      supabase.from('jugadores').select('id, nombre, talla_uniforme, numero_camiseta, nombre_camiseta, foto_base64').eq('academia_id', academia_id)
    ]);

    if (resCatalogo.error) throw resCatalogo.error;
    if (resPedidos.error) throw resPedidos.error;

    const pedidos = resPedidos.data || [];

    // Agrupación de tallas pendientes/en taller para enviar a confeccionar al taller
    const conteoTallas = {};
    let pendientes = 0;
    let enTaller = 0;
    let listos = 0;
    let entregados = 0;

    pedidos.forEach(p => {
      const st = p.estado_entrega || 'Pendiente';
      if (st === 'Pendiente') pendientes++;
      if (st === 'En Taller') enTaller++;
      if (st === 'Listo para Entrega') listos++;
      if (st === 'Entregado') entregados++;

      if (st !== 'Entregado' && p.talla) {
        conteoTallas[p.talla] = (conteoTallas[p.talla] || 0) + 1;
      }
    });

    res.json({
      success: true,
      data: {
        catalogo: resCatalogo.data || [],
        kpis: { totalPedidos: pedidos.length, pendientes, enTaller, listos, entregados },
        resumenTallas: conteoTallas,
        pedidos,
        jugadores: resJugadores.data || []
      }
    });
  } catch (error) {
    console.error('❌ Error obteniendo módulo de uniformes:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 2. AGREGAR PRENDA AL CATÁLOGO DE LA ACADEMIA
// ====================================================================
router.post('/catalogo', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { nombre, precio, aplica_numero, aplica_nombre_estampado } = req.body;

    const { data, error } = await supabase
      .from('prendas_catalogo')
      .insert([{
        academia_id,
        nombre,
        precio: Number(precio) || 0,
        aplica_numero: Boolean(aplica_numero),
        aplica_nombre_estampado: Boolean(aplica_nombre_estampado)
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
// 3. ASIGNAR INDUMENTARIA A ALUMNO Y CREAR COBRO SEPARADO EN CUENTA CORRIENTE 🔥
// ====================================================================
router.post('/pedidos', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugador_id, prenda_id, prenda_nombre, talla, numero_estampado, nombre_estampado, monto, generar_cobro } = req.body;

    let cobroId = null;
    const precioFinal = Number(monto) || 0;

    // A. Si se solicita generar cobro, se crea una entrada INDEPENDIENTE en cobros
    if (generar_cobro && precioFinal > 0) {
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
        .select()
        .single();

      if (!errCobro && cobroCreado) {
        cobroId = cobroCreado.id;
      }
    }

    // B. Crear registro del pedido
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
        estado_entrega: 'Pendiente'
      }])
      .select()
      .single();

    if (errPedido) throw errPedido;

    res.status(201).json({ 
      success: true, 
      data: nuevoPedido, 
      message: cobroId 
        ? 'Indumentaria solicitada y cobro independiente registrado en la cuenta corriente.' 
        : 'Indumentaria registrada sin cargo adicional.' 
    });
  } catch (error) {
    console.error('❌ Error registrando pedido de indumentaria:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================================================================
// 4. CAMBIAR ESTADO DE ENTREGA Y AVISAR POR WHATSAPP SI ESTÁ LISTO
// ====================================================================
router.put('/pedidos/:id/estado', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { id } = req.params;
    const { estado_entrega } = req.body;

    const updateData = { estado_entrega };
    if (estado_entrega === 'Entregado') {
      updateData.fecha_entrega = new Date().toISOString();
    }

    const { data: pedido, error } = await supabase
      .from('pedidos_indumentaria')
      .update(updateData)
      .eq('id', id)
      .select('*, jugadores(nombre, tutor_id)')
      .single();

    if (error) throw error;

    // Enviar notificación automática por WhatsApp cuando la prenda llega a la cancha
    if (estado_entrega === 'Listo para Entrega' && pedido.jugadores?.tutor_id) {
      const { data: tutor } = await supabase
        .from('tutores')
        .select('telefono, nombre_completo')
        .eq('id', pedido.jugadores.tutor_id)
        .single();

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
        } catch (errWs) {
          console.error(`Error enviando WhatsApp de indumentaria a ${numLimpio}:`, errWs.message);
        }
      }
    }

    res.json({ success: true, data: pedido });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
