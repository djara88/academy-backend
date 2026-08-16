const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireFeature } = require('../middleware/planAccess');
const { FEATURES } = require('../services/planCatalog');
const { generatePlayerReportV2 } = require('../services/playerReportV2');
const { resolveEvaluationProfile, PROFILES } = require('../services/evaluationCatalog');
const { fetchWithTimeout } = require('../services/httpClient');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const sanitizeFilePart = (value) => String(value || 'alumno')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9_-]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 80) || 'alumno';

const cleanBadgeTitle = (value) => String(value || '')
  .replace(/^[^\p{L}\p{N}]+/u, '')
  .trim();

const buildReportBadges = (badgeRows = [], legacyBadges = []) => {
  const normalized = [];

  (badgeRows || []).forEach((row) => {
    const titulo = cleanBadgeTitle(row?.insignias?.titulo);
    if (!titulo) return;
    normalized.push({
      fecha_otorgado: row.fecha_otorgado || null,
      titulo,
      descripcion: row.insignias?.descripcion || null,
      icono_url: row.insignias?.icono_url || null,
    });
  });

  (Array.isArray(legacyBadges) ? legacyBadges : []).forEach((badge) => {
    const source = typeof badge === 'string' ? { nombre: badge } : (badge || {});
    const titulo = cleanBadgeTitle(source.titulo || source.nombre);
    if (!titulo) return;
    normalized.push({
      fecha_otorgado: source.fecha_otorgado || source.fecha || null,
      titulo,
      descripcion: source.descripcion || null,
      icono_url: source.icono_url || null,
    });
  });

  const unique = new Map();
  normalized.forEach((badge) => {
    const key = badge.titulo.toLocaleLowerCase('es-CL');
    if (!unique.has(key)) unique.set(key, badge);
  });

  return [...unique.values()]
    .sort((a, b) => {
      const dateA = a.fecha_otorgado ? new Date(a.fecha_otorgado).getTime() : 0;
      const dateB = b.fecha_otorgado ? new Date(b.fecha_otorgado).getTime() : 0;
      return dateB - dateA;
    })
    .slice(0, 6);
};

const sendReportEmail = async ({ academia, tutor, jugador, pdfBuffer, sportProfile }) => {
  if (!tutor?.email || !process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) return false;
  try {
    const discipline = sportProfile?.label || 'deporte';
    const response = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: academia.nombre || 'Academia Deportiva', email: process.env.BREVO_SENDER_EMAIL },
        to: [{ email: tutor.email, name: tutor.nombre_completo || tutor.nombre || '' }],
        subject: `${academia.nombre || 'Academia'} | Informe de evolución deportiva - ${jugador.nombre}`,
        htmlContent: `
          <div style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.55;max-width:640px;margin:auto">
            <h2 style="color:#111827">Informe de evolución deportiva</h2>
            <p>Hola ${escapeHtml(tutor.nombre_completo || tutor.nombre || 'apoderado/a')},</p>
            <p>Adjuntamos el informe actualizado de <strong>${escapeHtml(jugador.nombre)}</strong>, preparado por <strong>${escapeHtml(academia.nombre || 'la academia')}</strong>.</p>
            <p>El informe corresponde al perfil de <strong>${escapeHtml(discipline)}</strong> y contiene el radar comparativo de sus evaluaciones, evolución por métrica, actividad del período y reconocimientos recientes.</p>
            <p style="margin-top:24px">Gracias por acompañar su proceso deportivo.</p>
            <p><strong>${escapeHtml(academia.nombre || 'Academia Deportiva')}</strong></p>
          </div>`,
        attachment: [{ name: `Informe_${sanitizeFilePart(jugador.nombre)}.pdf`, content: pdfBuffer.toString('base64') }],
      }),
    }, 10000);
    if (!response.ok) console.warn(`Brevo rechazó informe de alumno (HTTP ${response.status}).`);
    return response.ok;
  } catch (error) {
    console.warn('No fue posible enviar informe del alumno:', error?.code || error?.message || 'error externo');
    return false;
  }
};

router.post('/:jugador_id/enviar-informe', authMiddleware, ...requireFeature(FEATURES.EXPORTS), async (req, res) => {
  try {
    const startedAt = Date.now();
    const { academia_id } = req.user;
    const { jugador_id } = req.params;
    const comentarios = String(req.body?.comentarios || '').trim().slice(0, 4000);

    const { data: jugador, error: jugadorError } = await supabase.from('jugadores')
      .select(`
        id,nombre,rut,fecha_nacimiento,posicion_cancha,tipo_alumno,certificado_medico,
        foto_base64,foto_url,avatar_url,tutor_id,insignias,rama_id,
        jugador_categoria ( categorias ( id, nombre ) ),
        partido_estadisticas ( goles, asistencias, es_mvp )
      `)
      .eq('id', jugador_id)
      .eq('academia_id', academia_id)
      .maybeSingle();
    if (jugadorError) throw jugadorError;
    if (!jugador) return res.status(404).json({ success: false, error: 'Alumno no encontrado.' });

    const [
      { data: academia, error: academiaError },
      { data: evaluaciones, error: evalError },
      { data: asistencias, error: asistError },
      { data: badgeRows, error: badgeError },
      branchResult,
    ] = await Promise.all([
      supabase.from('academias').select('*').eq('id', academia_id).single(),
      supabase.from('evaluaciones').select('id,created_at,datos_radar,comentarios_profesor,disciplina_codigo,perfil_evaluacion,metricas_version')
        .eq('jugador_id', jugador_id).eq('academia_id', academia_id).order('created_at', { ascending: false }).limit(2),
      supabase.from('asistencias').select('estado').eq('jugador_id', jugador_id),
      supabase.from('jugador_insignias').select('fecha_otorgado,insignias(titulo,descripcion,icono_url)')
        .eq('jugador_id', jugador_id).order('fecha_otorgado', { ascending: false }).limit(6),
      jugador.rama_id
        ? supabase.from('ramas').select('id,nombre,disciplina,config_evaluacion').eq('id', jugador.rama_id).eq('academia_id', academia_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (academiaError) throw academiaError;
    if (evalError) throw evalError;
    if (asistError) throw asistError;
    if (badgeError) throw badgeError;
    if (branchResult.error) throw branchResult.error;

    let tutor = null;
    if (jugador.tutor_id) {
      const { data, error } = await supabase.from('tutores')
        .select('id,nombre_completo,nombre,email,telefono')
        .eq('id', jugador.tutor_id).eq('academia_id', academia_id).maybeSingle();
      if (error) throw error;
      tutor = data;
    }

    const latestProfileCode = evaluaciones?.[0]?.disciplina_codigo;
    const fallbackDiscipline = latestProfileCode && PROFILES[latestProfileCode]
      ? PROFILES[latestProfileCode].label
      : 'Otro';
    const sportProfile = resolveEvaluationProfile({
      discipline: branchResult.data?.disciplina || fallbackDiscipline,
      role: jugador.posicion_cancha || '',
      customConfig: branchResult.data?.config_evaluacion || {},
    });

    const statsPartidos = jugador.partido_estadisticas || [];
    const stats = {
      partidos_jugados: statsPartidos.length,
      goles: sportProfile.supportsFootballStats ? statsPartidos.reduce((sum, row) => sum + (Number(row.goles) || 0), 0) : 0,
      asistencias: sportProfile.supportsFootballStats ? statsPartidos.reduce((sum, row) => sum + (Number(row.asistencias) || 0), 0) : 0,
      mvp: sportProfile.supportsFootballStats ? statsPartidos.filter((row) => row.es_mvp).length : 0,
      clases_presente: (asistencias || []).filter((row) => row.estado === 'Presente').length,
      clases_ausente: (asistencias || []).filter((row) => row.estado === 'Ausente').length,
      clases_justificadas: (asistencias || []).filter((row) => row.estado === 'Justificado').length,
    };

    const badges = buildReportBadges(badgeRows || [], jugador.insignias || []);

    const formattedPlayer = {
      ...jugador,
      categorias: (jugador.jugador_categoria || []).map((rel) => rel.categorias).filter(Boolean),
    };

    const pdfBuffer = await generatePlayerReportV2({
      academia,
      jugador: formattedPlayer,
      tutor,
      evaluaciones: evaluaciones || [],
      stats,
      comentarios,
      badges,
      sportProfile,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `${academia_id}/${jugador_id}/${stamp}_${Date.now()}.pdf`;
    const uploadPromise = supabase.storage.from('informes-alumnos')
      .upload(fileName, pdfBuffer, { contentType: 'application/pdf', upsert: false });
    const emailPromise = sendReportEmail({ academia, tutor, jugador, pdfBuffer, sportProfile });

    const [uploadResult, emailSent] = await Promise.all([uploadPromise, emailPromise]);
    if (uploadResult.error) throw uploadResult.error;

    const { data: signedData, error: signedError } = await supabase.storage.from('informes-alumnos')
      .createSignedUrl(fileName, 15 * 60);
    if (signedError || !signedData?.signedUrl) throw new Error('No fue posible crear el enlace seguro del informe.');

    res.json({
      success: true,
      url: signedData.signedUrl,
      email_sent: emailSent,
      expires_in_seconds: 900,
      document_generation_ms: pdfBuffer.generationMs || null,
      total_processing_ms: Date.now() - startedAt,
      pdf_size_bytes: pdfBuffer.length,
      badges_rendered: badges.length,
      compared_evaluations: Math.min(2, (evaluaciones || []).length),
      discipline: sportProfile.code,
      discipline_label: sportProfile.label,
    });
  } catch (error) {
    console.error('Error generando informe premium:', error?.message || 'Error desconocido');
    res.status(500).json({ success: false, error: 'No fue posible generar el informe del alumno.' });
  }
});

module.exports = router;