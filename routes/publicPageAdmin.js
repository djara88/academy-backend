const express = require('express');
const multer = require('multer');
const { randomUUID } = require('crypto');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');

const router = express.Router();
router.use(authMiddleware, requireDirector);

const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4, parts: 5 },
  fileFilter: (_req, file, callback) => {
    if (!allowedImageTypes.has(file.mimetype)) {
      return callback(Object.assign(new Error('La foto debe ser JPG, PNG o WEBP.'), { code: 'INVALID_IMAGE_TYPE' }));
    }
    return callback(null, true);
  },
});

const photoUpload = (req, res, next) => upload.single('photo')(req, res, (error) => {
  if (!error) return next();
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Cada foto puede pesar hasta 5 MB.' });
  return res.status(400).json({ error: error.message || 'No fue posible procesar la foto.' });
});

const publicBaseUrl = () => String(process.env.FRONTEND_URL || 'https://lestra.app').replace(/\/$/, '');
const safeText = (value, max = 180) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const normalizeSlug = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const validHex = (value) => /^#[0-9A-F]{6}$/i.test(String(value || ''));
const socialKeys = ['instagram', 'facebook', 'tiktok', 'youtube', 'website'];
const extensionFor = (type) => type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';

const sanitizeSocials = (input = {}) => {
  const result = {};
  for (const key of socialKeys) {
    const value = safeText(input?.[key], 500);
    if (!value) continue;
    if (!/^https:\/\/\S+$/i.test(value)) {
      const error = new Error(`${key} debe usar un enlace https:// válido.`);
      error.status = 400;
      error.code = 'INVALID_SOCIAL_URL';
      throw error;
    }
    result[key] = value;
  }
  return result;
};

const loadConfig = async (academyId) => {
  const [{ data: academy, error: academyError }, { data: photos, error: photoError }] = await Promise.all([
    supabase.from('academias')
      .select('id,nombre,subdominio,pagina_publica_activa,descripcion_publica,pagina_color_primario,pagina_color_secundario,pagina_color_fondo,pagina_rrss')
      .eq('id', academyId).single(),
    supabase.from('academia_pagina_fotos')
      .select('id,url,storage_path,alt_text,orden,created_at')
      .eq('academia_id', academyId).order('orden').order('created_at'),
  ]);
  if (academyError || photoError) throw academyError || photoError;
  return {
    ...academy,
    pagina_rrss: academy.pagina_rrss || {},
    fotos: photos || [],
    url: `${publicBaseUrl()}/a/${academy.subdominio}`,
  };
};

router.get('/', async (req, res) => {
  try {
    return res.json({ success: true, data: await loadConfig(req.user.academia_id) });
  } catch (error) {
    console.error('Error cargando editor de página pública:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible cargar la página pública.' });
  }
});

router.put('/', async (req, res) => {
  try {
    const slug = normalizeSlug(req.body?.slug);
    if (slug.length < 3) return res.status(400).json({ error: 'El enlace público debe tener al menos 3 caracteres.' });

    const primary = String(req.body?.color_primario || '#289E9D').toUpperCase();
    const secondary = String(req.body?.color_secundario || '#70E4DF').toUpperCase();
    const background = String(req.body?.color_fondo || '#0D1117').toUpperCase();
    if (![primary, secondary, background].every(validHex)) {
      return res.status(400).json({ error: 'Los colores deben usar formato hexadecimal #RRGGBB.' });
    }

    const socials = sanitizeSocials(req.body?.rrss || {});
    const { error } = await supabase.from('academias').update({
      subdominio: slug,
      pagina_publica_activa: req.body?.activa !== false,
      descripcion_publica: safeText(req.body?.descripcion, 1200) || null,
      pagina_color_primario: primary,
      pagina_color_secundario: secondary,
      pagina_color_fondo: background,
      pagina_rrss: socials,
    }).eq('id', req.user.academia_id);
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Ese enlace público ya está siendo utilizado.' });
      throw error;
    }
    return res.json({ success: true, data: await loadConfig(req.user.academia_id) });
  } catch (error) {
    console.error('Error guardando editor de página pública:', error?.message || error);
    return res.status(error?.status || 500).json({ error: error?.status ? error.message : 'No fue posible guardar la página pública.', code: error?.code });
  }
});

router.post('/photos', photoUpload, async (req, res) => {
  const academyId = req.user.academia_id;
  let storagePath = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'Selecciona una foto.' });
    const { count, error: countError } = await supabase.from('academia_pagina_fotos')
      .select('id', { count: 'exact', head: true }).eq('academia_id', academyId);
    if (countError) throw countError;
    if (Number(count || 0) >= 6) return res.status(409).json({ error: 'La galería permite hasta 6 fotos.' });

    storagePath = `${academyId}/${randomUUID()}.${extensionFor(req.file.mimetype)}`;
    const { error: uploadError } = await supabase.storage.from('academia-publica')
      .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, cacheControl: '3600', upsert: false });
    if (uploadError) throw uploadError;
    const url = supabase.storage.from('academia-publica').getPublicUrl(storagePath).data.publicUrl;

    const { data, error } = await supabase.from('academia_pagina_fotos').insert({
      academia_id: academyId,
      storage_path: storagePath,
      url,
      alt_text: safeText(req.body?.alt_text, 180) || null,
      orden: Number(count || 0),
    }).select('id,url,storage_path,alt_text,orden').single();
    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (error) {
    if (storagePath) await supabase.storage.from('academia-publica').remove([storagePath]);
    console.error('Error subiendo foto pública:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible subir la foto.' });
  }
});

router.delete('/photos/:id', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const { data: photo, error: findError } = await supabase.from('academia_pagina_fotos')
      .select('id,storage_path').eq('id', req.params.id).eq('academia_id', academyId).maybeSingle();
    if (findError) throw findError;
    if (!photo) return res.status(404).json({ error: 'Foto no encontrada.' });

    const { error: storageError } = await supabase.storage.from('academia-publica').remove([photo.storage_path]);
    if (storageError) throw storageError;
    const { error: deleteError } = await supabase.from('academia_pagina_fotos')
      .delete().eq('id', photo.id).eq('academia_id', academyId);
    if (deleteError) throw deleteError;
    return res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando foto pública:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible eliminar la foto.' });
  }
});

module.exports = router;
