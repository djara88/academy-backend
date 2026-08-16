const supabase = require('../config/supabase');

const nowIso = () => new Date().toISOString();

const storagePathFromUrl = (value, bucket) => {
  const raw = String(value || '').trim();
  if (!raw || !bucket) return null;
  const marker = `/${bucket}/`;
  const index = raw.indexOf(marker);
  if (index < 0) return null;
  try {
    return decodeURIComponent(raw.slice(index + marker.length).split('?')[0]);
  } catch (_error) {
    return raw.slice(index + marker.length).split('?')[0];
  }
};

const recordPrivacyEvent = async ({ requestId, academyId, event, actorUserId = null, detail = {} }) => {
  const { error } = await supabase.from('solicitudes_privacidad_eventos').insert({
    solicitud_id: requestId,
    academia_id: academyId,
    evento: event,
    actor_user_id: actorUserId,
    detalle: detail,
  });
  if (error) console.warn('No fue posible registrar un evento de privacidad.');
};

const revokeImageConsent = async ({ academyId, playerId, requestId, actorUserId }) => {
  const timestamp = nowIso();
  const { data: player, error: playerError } = await supabase.from('jugadores')
    .select('id,foto_url,avatar_url')
    .eq('id', playerId).eq('academia_id', academyId).maybeSingle();
  if (playerError || !player) throw playerError || new Error('Alumno no encontrado.');

  const possiblePaths = [
    storagePathFromUrl(player.foto_url, 'fotos_alumnos'),
    storagePathFromUrl(player.avatar_url, 'fotos_alumnos'),
  ].filter(Boolean);
  if (possiblePaths.length) {
    const { error: storageError } = await supabase.storage.from('fotos_alumnos').remove([...new Set(possiblePaths)]);
    if (storageError) console.warn('No fue posible eliminar una fotografía histórica de Storage.');
  }

  const [{ error: consentError }, { error: updateError }] = await Promise.all([
    supabase.from('consentimientos_alumnos').update({
      estado: 'revocado',
      revocado_at: timestamp,
    }).eq('academia_id', academyId).eq('jugador_id', playerId).in('tipo', ['imagen_interna', 'imagen_publica']),
    supabase.from('jugadores').update({
      foto_base64: null,
      foto_url: null,
      avatar_url: null,
    }).eq('academia_id', academyId).eq('id', playerId),
  ]);
  if (consentError) throw consentError;
  if (updateError) throw updateError;

  await recordPrivacyEvent({
    requestId,
    academyId,
    event: 'revocacion_imagen_ejecutada',
    actorUserId,
    detail: { foto_eliminada: true, consentimientos_revocados: true },
  });
  return { foto_eliminada: true, consentimientos_revocados: true };
};

const deleteRows = async (table, academyId, playerId) => {
  let query = supabase.from(table).delete().eq('jugador_id', playerId);
  if (academyId && !['jugador_categoria', 'jugador_tutor'].includes(table)) query = query.eq('academia_id', academyId);
  const { data, error } = await query.select('jugador_id');
  if (error) throw error;
  return Number(data?.length || 0);
};

const anonymizePlayer = async ({ academyId, playerId, requestId, actorUserId }) => {
  const timestamp = nowIso();
  const { data: player, error: playerError } = await supabase.from('jugadores')
    .select('id,nombre,foto_url,avatar_url')
    .eq('id', playerId).eq('academia_id', academyId).maybeSingle();
  if (playerError || !player) throw playerError || new Error('Alumno no encontrado.');

  const { data: prematriculas, error: preError } = await supabase.from('prematriculas')
    .select('id,final_document_path')
    .eq('academia_id', academyId).eq('jugador_id', playerId);
  if (preError) throw preError;

  const pdfPaths = (prematriculas || []).map((row) => row.final_document_path).filter(Boolean);
  if (pdfPaths.length) {
    const { error } = await supabase.storage.from('matriculas-pdf').remove(pdfPaths);
    if (error) console.warn('No fue posible retirar uno o más PDFs históricos de matrícula.');
  }

  const photoPaths = [
    storagePathFromUrl(player.foto_url, 'fotos_alumnos'),
    storagePathFromUrl(player.avatar_url, 'fotos_alumnos'),
  ].filter(Boolean);
  if (photoPaths.length) {
    const { error } = await supabase.storage.from('fotos_alumnos').remove([...new Set(photoPaths)]);
    if (error) console.warn('No fue posible retirar una fotografía histórica de Storage.');
  }

  const deletableTables = [
    'alertas_asistencia', 'asistencias', 'evaluaciones', 'jugador_categoria', 'jugador_insignias',
    'jugador_tutor', 'matriculas', 'partido_citaciones', 'partido_estadisticas',
    'partido_plan_jugadores', 'pedidos_indumentaria', 'torneo_participantes',
  ];
  const deleted = {};
  for (const table of deletableTables) {
    try {
      deleted[table] = await deleteRows(table, academyId, playerId);
    } catch (error) {
      console.warn(`No fue posible limpiar ${table} durante una supresión:`, error?.message || 'Error');
      throw error;
    }
  }

  const { error: consentError } = await supabase.from('consentimientos_alumnos').update({
    estado: 'revocado',
    representante_nombre: null,
    revocado_at: timestamp,
  }).eq('academia_id', academyId).eq('jugador_id', playerId);
  if (consentError) throw consentError;

  if ((prematriculas || []).length) {
    const ids = prematriculas.map((row) => row.id);
    const { error: redactError } = await supabase.from('prematriculas').update({
      jugador_payload: { redacted: true },
      evaluacion_payload: {},
      emergencia_payload: {},
      signature_data_url: null,
      signed_by_document: null,
      signed_ip: null,
      signed_user_agent: null,
      final_document_path: null,
      final_document_sha256: null,
      evidence_sha256: null,
      updated_at: timestamp,
    }).in('id', ids).eq('academia_id', academyId);
    if (redactError) throw redactError;
  }

  const anonymized = {
    nombre: `Alumno anonimizado ${String(playerId).slice(0, 8)}`,
    rut_pasaporte: null,
    rut: null,
    rut_jugador: null,
    dni: null,
    pasaporte: null,
    numero_documento: null,
    fecha_nacimiento: null,
    sexo: null,
    genero: null,
    edad: null,
    lugar_nacimiento: null,
    nacionalidad: null,
    ciudad: null,
    comuna: null,
    region: null,
    telefono_apoderado: null,
    nombre_apoderado: null,
    rut_apoderado: null,
    email_apoderado: null,
    parentesco_apoderado: null,
    alerta_medica: null,
    grupo_sanguineo: null,
    alergias: null,
    prevision_salud: null,
    contacto_emergencia: null,
    telefono_emergencia: null,
    observaciones_medicas: null,
    medicamentos: null,
    enfermedades_cronicas: null,
    lesion_previa: null,
    contacto_emergencia_nombre: null,
    contacto_emergencia_telefono: null,
    contacto_emergencia_parentesco: null,
    certificado_medico: null,
    certificado_nacimiento: null,
    foto_rut: null,
    ficha_medica_url: null,
    documento_identidad_url: null,
    foto_base64: null,
    foto_url: null,
    avatar_url: null,
    firma_digital: null,
    ip_aceptacion: null,
    terminos_condiciones: null,
    terminos_aceptados: false,
    fecha_aceptacion_terminos: null,
    notas: null,
    insignias: [],
    logros: [],
    tutor_id: null,
    apoderado_id: null,
    tutor_principal_id: null,
    usuario_id: null,
    estado: 'Inactivo',
    estado_matricula: 'Anonimizada',
    privacy_blocked_at: timestamp,
    privacy_anonymized_at: timestamp,
  };
  const { error: playerUpdateError } = await supabase.from('jugadores').update(anonymized)
    .eq('academia_id', academyId).eq('id', playerId);
  if (playerUpdateError) throw playerUpdateError;

  const summary = {
    modo: 'anonimizacion_controlada',
    identificadores_eliminados: true,
    fotografia_eliminada: true,
    datos_salud_eliminados: true,
    documentos_matricula_eliminados: pdfPaths.length,
    historiales_no_financieros_eliminados: deleted,
    registros_financieros_preservados_sin_identidad_directa: true,
  };
  await recordPrivacyEvent({ requestId, academyId, event: 'supresion_ejecutada', actorUserId, detail: summary });
  return summary;
};

const buildPrivacyExport = async ({ academyId, playerId }) => {
  const { data: player, error: playerError } = await supabase.from('jugadores').select('*')
    .eq('academia_id', academyId).eq('id', playerId).maybeSingle();
  if (playerError || !player) throw playerError || new Error('Alumno no encontrado.');

  const tutorIds = [...new Set([player.tutor_id, player.apoderado_id, player.tutor_principal_id].filter(Boolean))];
  const [tutorsResult, consentsResult, evalResult, attendanceResult, chargesResult, paymentsResult, preResult] = await Promise.all([
    tutorIds.length ? supabase.from('tutores').select('*').eq('academia_id', academyId).in('id', tutorIds) : Promise.resolve({ data: [], error: null }),
    supabase.from('consentimientos_alumnos').select('*').eq('academia_id', academyId).eq('jugador_id', playerId),
    supabase.from('evaluaciones').select('*').eq('academia_id', academyId).eq('jugador_id', playerId),
    supabase.from('asistencias').select('*').eq('jugador_id', playerId),
    supabase.from('cobros').select('*').eq('academia_id', academyId).eq('jugador_id', playerId),
    supabase.from('pagos').select('*').eq('academia_id', academyId).eq('jugador_id', playerId),
    supabase.from('prematriculas').select('id,estado,created_at,signed_at,privacy_version,terms_snapshot,consent_snapshot,evidence_sha256,final_document_sha256').eq('academia_id', academyId).eq('jugador_id', playerId),
  ]);
  const error = [tutorsResult, consentsResult, evalResult, attendanceResult, chargesResult, paymentsResult, preResult].find((item) => item.error)?.error;
  if (error) throw error;

  return {
    generated_at: nowIso(),
    alcance: 'Datos disponibles en Syncademia para el alumno seleccionado.',
    jugador: player,
    apoderados: tutorsResult.data || [],
    consentimientos: consentsResult.data || [],
    evaluaciones: evalResult.data || [],
    asistencias: attendanceResult.data || [],
    cobros: chargesResult.data || [],
    pagos: paymentsResult.data || [],
    matriculas_digitales: preResult.data || [],
  };
};

module.exports = {
  recordPrivacyEvent,
  revokeImageConsent,
  anonymizePlayer,
  buildPrivacyExport,
};
