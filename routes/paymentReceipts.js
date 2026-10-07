const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { loadPortalToken, authorizedPlayersForToken } = require('../services/collectionPortal');
const { assertUploadedFile } = require('../services/fileValidation');
const { resolveIdempotencyKey, fingerprint } = require('../services/idempotency');

const router = express.Router();
const allowedTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => allowedTypes.has(file.mimetype) ? cb(null, true) : cb(new Error('Formato de comprobante no permitido.')),
});
const safe = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const extensionFor = (file) => {
  const byMime = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  return byMime[file?.mimetype] || path.extname(file?.originalname || '').toLowerCase() || '.bin';
};

router.post('/public/transferencia/:token', upload.single('comprobante'), async (req, res) => {
  let storedPath = null;
  try {
    const tokenRow = await loadPortalToken(req.params.token);
    if (!tokenRow) return res.status(401).json({ error: 'El enlace de pago venció o ya no es válido.' });
    if (!req.file) return res.status(400).json({ error: 'Adjunta el comprobante de transferencia.' });
    await assertUploadedFile(req.file);

    const { data: config, error: configError } = await supabase.from('configuracion_financiera')
      .select('acepta_transferencia').eq('academia_id', tokenRow.academia_id).maybeSingle();
    if (configError) throw configError;
    if (config?.acepta_transferencia !== true) return res.status(409).json({ error: 'La academia no tiene transferencias habilitadas.' });

    const players = await authorizedPlayersForToken(tokenRow);
    const playerIds = new Set(players.map((row) => String(row.id)));
    const chargeId = safe(req.body?.cobro_id, 80);
    const quotaId = safe(req.body?.cuota_id, 80) || null;
    const amount = Math.round(Number(req.body?.monto));
    const paymentDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.fecha_pago || '')) ? String(req.body.fecha_pago) : new Date().toISOString().slice(0, 10);
    const observations = safe(req.body?.observaciones, 1000) || null;
    const fileDigest = fingerprint(req.file.buffer.toString('base64'));
    const idempotencyKey = resolveIdempotencyKey({
      providedKey: req.get('Idempotency-Key') || safe(req.body?.idempotency_key, 160),
      namespace: 'payment-receipt',
      windowMs: 15 * 60 * 1000,
      payload: {
        tokenId: tokenRow.id,
        chargeId,
        quotaId,
        amount,
        paymentDate,
        observations,
        fileDigest,
      },
    });
    if (!chargeId || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Cobro y monto son obligatorios.' });

    const { data: charge, error: chargeError } = await supabase.from('cobros')
      .select('id,jugador_id,monto,monto_pagado,estado').eq('id', chargeId).eq('academia_id', tokenRow.academia_id).maybeSingle();
    if (chargeError) throw chargeError;
    if (!charge || !playerIds.has(String(charge.jugador_id)) || ['Pagado', 'Anulado'].includes(charge.estado)) return res.status(404).json({ error: 'Cobro no disponible.' });

    let availableBalance = Math.max(Number(charge.monto || 0) - Number(charge.monto_pagado || 0), 0);
    if (quotaId) {
      const { data: quota, error: quotaError } = await supabase.from('cobro_cuotas')
        .select('id,cobro_id,monto,monto_pagado,estado').eq('id', quotaId).eq('academia_id', tokenRow.academia_id).maybeSingle();
      if (quotaError) throw quotaError;
      if (!quota || String(quota.cobro_id) !== String(charge.id) || ['Pagada', 'Anulada'].includes(quota.estado)) return res.status(409).json({ error: 'La cuota ya no está disponible.' });
      availableBalance = Math.max(Number(quota.monto || 0) - Number(quota.monto_pagado || 0), 0);
    }

    let pendingQuery = supabase.from('pagos_informados').select('monto').eq('academia_id', tokenRow.academia_id).eq('cobro_id', charge.id).eq('estado', 'Pendiente');
    pendingQuery = quotaId ? pendingQuery.eq('cuota_id', quotaId) : pendingQuery.is('cuota_id', null);
    const { data: pending, error: pendingError } = await pendingQuery;
    if (pendingError) throw pendingError;
    availableBalance = Math.max(availableBalance - (pending || []).reduce((sum, row) => sum + Number(row.monto || 0), 0), 0);
    if (amount > availableBalance) return res.status(400).json({ error: 'El monto informado supera el saldo disponible para este concepto.' });

    const { data: existing, error: existingError } = await supabase.from('pagos_informados')
      .select('id,estado,monto,created_at')
      .eq('academia_id', tokenRow.academia_id)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      return res.json({ success: true, data: existing, reused: true, message: 'Esta transferencia ya había sido informada.' });
    }

    const ownerPart = tokenRow.tutor_id || tokenRow.jugador_id || 'portal';
    storedPath = `${tokenRow.academia_id}/${ownerPart}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}${extensionFor(req.file)}`;
    const uploadResult = await supabase.storage.from('comprobantes-pago').upload(storedPath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (uploadResult.error) throw uploadResult.error;

    const { data, error } = await supabase.from('pagos_informados').insert({
      academia_id: tokenRow.academia_id,
      cobro_id: charge.id,
      cuota_id: quotaId,
      jugador_id: charge.jugador_id,
      tutor_id: tokenRow.tutor_id || null,
      monto: amount,
      metodo_pago: 'Transferencia',
      fecha_pago_informada: paymentDate,
      comprobante_ref: storedPath,
      observaciones: observations,
      estado: 'Pendiente',
      canal: 'portal',
      idempotency_key: idempotencyKey,
    }).select('id,estado,monto,created_at').single();
    if (error) {
      if (error.code === '23505') {
        const { data: duplicate } = await supabase.from('pagos_informados')
          .select('id,estado,monto,created_at')
          .eq('academia_id', tokenRow.academia_id)
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle();
        if (duplicate) {
          if (storedPath) {
            await supabase.storage.from('comprobantes-pago').remove([storedPath]).catch(() => null);
            storedPath = null;
          }
          return res.json({ success: true, data: duplicate, reused: true, message: 'Esta transferencia ya había sido informada.' });
        }
      }
      throw error;
    }
    storedPath = null;
    return res.status(201).json({ success: true, data, message: 'Transferencia informada. La academia revisará el comprobante antes de aplicar el pago.' });
  } catch (error) {
    if (storedPath) await supabase.storage.from('comprobantes-pago').remove([storedPath]).catch(() => null);
    console.error('Error informando transferencia con comprobante:', error?.message || error);
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'El comprobante supera 5 MB.' : 'No fue posible procesar el archivo.' });
    if (error?.code === 'INVALID_FILE_SIGNATURE') return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: error?.message || 'No fue posible informar la transferencia.' });
  }
});

router.get('/comprobante/:pagoInformadoId', authMiddleware, requireDirector, async (req, res) => {
  try {
    const { data: payment, error } = await supabase.from('pagos_informados')
      .select('id,comprobante_ref').eq('id', req.params.pagoInformadoId).eq('academia_id', req.user.academia_id).maybeSingle();
    if (error) throw error;
    if (!payment?.comprobante_ref) return res.status(404).json({ error: 'Comprobante no disponible.' });
    const expectedPrefix = `${req.user.academia_id}/`;
    if (!String(payment.comprobante_ref).startsWith(expectedPrefix)) return res.status(403).json({ error: 'Comprobante inválido.' });
    const { data, error: signedError } = await supabase.storage.from('comprobantes-pago').createSignedUrl(payment.comprobante_ref, 10 * 60);
    if (signedError || !data?.signedUrl) throw signedError || new Error('No se pudo firmar el comprobante.');
    return res.json({ success: true, url: data.signedUrl, expires_in_seconds: 600 });
  } catch (error) {
    return res.status(500).json({ error: 'No fue posible abrir el comprobante.' });
  }
});

router.use((error, _req, res, next) => {
  if (!error) return next();
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'El comprobante supera 5 MB.' : 'No fue posible procesar el archivo.' });
  if (error.message === 'Formato de comprobante no permitido.') return res.status(400).json({ error: error.message });
  if (error?.code === 'INVALID_FILE_SIGNATURE') return res.status(400).json({ error: error.message });
  return next(error);
});

module.exports = router;
