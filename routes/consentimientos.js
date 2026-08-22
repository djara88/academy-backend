const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { PRIVACY_VERSION } = require('../services/privacyConsents');
const {
  getAcademyConsentCatalog,
  buildSetupStatus,
  updateSetupPreferences,
} = require('../services/academySetupService');

const normalizeDecision = (value) => value === true ? 'aceptado' : 'rechazado';

router.get('/setup', authMiddleware, requireDirector, async (req, res) => {
  try {
    const data = await buildSetupStatus(req.user.academia_id);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error cargando Puesta en Marcha:', error?.message || error);
    return res.status(500).json({ success: false, error: 'No fue posible revisar la Puesta en Marcha de la academia.' });
  }
});

router.put('/setup/preferencias', authMiddleware, requireDirector, async (req, res) => {
  try {
    await updateSetupPreferences(req.user.academia_id, req.body || {});
    const data = await buildSetupStatus(req.user.academia_id);
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      error: error?.message || 'No fue posible guardar la configuración inicial.',
      code: error?.code || undefined,
    });
  }
});

router.get('/textos', authMiddleware, async (req, res) => {
  try {
    const { data: academia } = await supabase.from('academias')
      .select('nombre')
      .eq('id', req.user.academia_id)
      .single();
    const catalog = await getAcademyConsentCatalog(req.user.academia_id, academia?.nombre || 'la academia');
    res.json({ success: true, data: catalog });
  } catch (error) {
    res.status(500).json({ success: false, error: 'No fue posible cargar los textos de privacidad.' });
  }
});

router.post('/alumno', authMiddleware, async (req, res) => {
  try {
    const { academia_id, id: usuarioId } = req.user;
    const { jugador_id, tutor_id, decisiones = {} } = req.body || {};

    if (!jugador_id || !tutor_id) {
      return res.status(400).json({ success: false, error: 'Jugador y apoderado son obligatorios.' });
    }

    const [{ data: jugador }, { data: tutor }, { data: academia }] = await Promise.all([
      supabase.from('jugadores').select('id,nombre').eq('id', jugador_id).eq('academia_id', academia_id).maybeSingle(),
      supabase.from('tutores').select('id,nombre_completo').eq('id', tutor_id).eq('academia_id', academia_id).maybeSingle(),
      supabase.from('academias').select('nombre').eq('id', academia_id).maybeSingle(),
    ]);

    if (!jugador || !tutor) {
      return res.status(404).json({ success: false, error: 'No se encontró el alumno o apoderado en esta academia.' });
    }

    const catalog = await getAcademyConsentCatalog(academia_id, academia?.nombre || 'la academia');
    const catalogItems = Array.isArray(catalog.items) ? catalog.items : [];
    const mandatoryMissing = catalogItems.some((item) => item.obligatorio === true && decisiones[item.tipo] !== true);
    if (mandatoryMissing) {
      return res.status(400).json({ success: false, error: 'El apoderado debe confirmar las autorizaciones obligatorias.' });
    }

    const now = new Date().toISOString();
    const rows = catalogItems.map((definition) => {
      const estado = normalizeDecision(decisiones[definition.tipo]);
      return {
        academia_id,
        jugador_id,
        tutor_id,
        tipo: definition.tipo,
        estado,
        obligatorio: definition.obligatorio,
        version: PRIVACY_VERSION,
        finalidad: definition.finalidad,
        contenido_snapshot: definition.contenido,
        representante_nombre: tutor.nombre_completo || null,
        canal: 'matricula_presencial',
        registrado_por: usuarioId || null,
        otorgado_at: estado === 'aceptado' ? now : null,
        revocado_at: null,
      };
    });

    if (rows.length) {
      const { error } = await supabase.from('consentimientos_alumnos')
        .upsert(rows, { onConflict: 'jugador_id,tipo,version', ignoreDuplicates: false });
      if (error) throw error;
    }

    const privacyNotice = catalogItems.find((item) => item.tipo === 'aviso_privacidad');
    await supabase.from('jugadores').update({
      terminos_aceptados: true,
      fecha_aceptacion_terminos: now,
      terminos_condiciones: privacyNotice?.contenido || null,
    }).eq('id', jugador_id).eq('academia_id', academia_id);

    res.status(201).json({ success: true, version: PRIVACY_VERSION, data: rows.map(({ contenido_snapshot, ...row }) => row) });
  } catch (error) {
    console.error('Error guardando consentimientos:', error?.message || 'Error desconocido');
    res.status(500).json({ success: false, error: 'No fue posible registrar las autorizaciones de privacidad.' });
  }
});

router.post('/alumno/:jugador_id/revocar', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugador_id } = req.params;
    const { tipo } = req.body || {};
    if (!['datos_salud','imagen_interna','imagen_publica'].includes(tipo)) {
      return res.status(400).json({ success: false, error: 'Tipo de autorización no revocable por esta ruta.' });
    }

    const { data: jugador } = await supabase.from('jugadores').select('id')
      .eq('id', jugador_id).eq('academia_id', academia_id).maybeSingle();
    if (!jugador) return res.status(404).json({ success: false, error: 'Alumno no encontrado.' });

    const { error } = await supabase.from('consentimientos_alumnos')
      .update({ estado: 'revocado', revocado_at: new Date().toISOString() })
      .eq('academia_id', academia_id)
      .eq('jugador_id', jugador_id)
      .eq('tipo', tipo)
      .eq('estado', 'aceptado');
    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'No fue posible registrar la revocación.' });
  }
});

module.exports = router;