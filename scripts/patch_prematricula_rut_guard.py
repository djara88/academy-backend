from pathlib import Path

# Patch routes/prematriculas.js
p = Path('routes/prematriculas.js')
s = p.read_text()

anchor = "const { fetchWithTimeout } = require('../services/httpClient');\n"
imp = "const { findRutConflict, assertRutAvailable } = require('../services/rutGuard');\n"
if imp not in s:
    if anchor not in s:
        raise SystemExit('import anchor not found')
    s = s.replace(anchor, anchor + imp, 1)

old_select = ".select('id,estado,expires_at,sent_at,opened_at,signed_at,tutor_payload,jugador_payload,created_at,jugador_id')"
new_select = ".select('id,estado,expires_at,sent_at,opened_at,signed_at,tutor_payload,jugador_payload,finanzas_payload,evaluacion_payload,emergencia_payload,created_at,jugador_id')"
if old_select in s:
    s = s.replace(old_select, new_select, 1)

post_anchor = "router.post('/', authMiddleware, async (req, res) => {\n"
validate_route = r'''router.get('/validar-rut', authMiddleware, async (req, res) => {
  try {
    const rut = safeText(req.query?.rut, 40);
    const excludePrematriculaId = safeText(req.query?.exclude_id, 80) || null;
    if (!rut) return res.json({ success: true, available: true, conflict: null });
    const conflict = await findRutConflict({
      supabase,
      academiaId: req.user.academia_id,
      rut,
      excludePrematriculaId,
    });
    return res.json({
      success: true,
      available: !conflict,
      code: conflict?.code || null,
      error: conflict?.message || null,
      conflict,
    });
  } catch (error) {
    console.error('Error validando RUT de pre-matrícula:', error?.message || 'Error desconocido');
    return res.status(500).json({ success: false, error: 'No fue posible validar el RUT.' });
  }
});

'''
if "router.get('/validar-rut'" not in s:
    if post_anchor not in s:
        raise SystemExit('post anchor not found')
    s = s.replace(post_anchor, validate_route + post_anchor, 1)

required_anchor = """    if (!safeText(tutor.nombre_completo, 180) || !safeText(tutor.email, 240) || !safeText(jugador.nombre, 180)) {
      return res.status(400).json({ success: false, error: 'Nombre del alumno, apoderado y correo son obligatorios.' });
    }

"""
unique_check = """    if (jugador.rut) {
      await assertRutAvailable({ supabase, academiaId: academia_id, rut: jugador.rut });
    }

"""
first_post = s.find(post_anchor)
if first_post >= 0 and unique_check not in s[first_post:first_post+5000]:
    pos = s.find(required_anchor, first_post)
    if pos < 0:
        raise SystemExit('required fields anchor not found')
    insert_at = pos + len(required_anchor)
    s = s[:insert_at] + unique_check + s[insert_at:]

catch_old = """  } catch (error) {
    console.error('Error creando pre-matrícula:', error?.message || 'Error desconocido');
    return res.status(500).json({ success: false, error: 'No fue posible crear la pre-matrícula.' });
  }
});

router.get('/public/:token', async (req, res) => {"""
catch_new = """  } catch (error) {
    console.error('Error creando pre-matrícula:', error?.message || 'Error desconocido');
    if (['PLAYER_RUT_EXISTS', 'PRE_ENROLLMENT_RUT_EXISTS'].includes(error?.code)) {
      return res.status(409).json({ success: false, code: error.code, error: error.message, conflict: error.conflict || null });
    }
    return res.status(500).json({ success: false, error: 'No fue posible crear la pre-matrícula.' });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const tutor = req.body?.tutor || {};
    const jugador = req.body?.jugador || {};
    const finanzas = req.body?.finanzas || {};
    const evaluacion = req.body?.evaluacion || {};
    const emergencia = req.body?.emergencia || {};

    if (!safeText(tutor.nombre_completo, 180) || !safeText(tutor.email, 240) || !safeText(jugador.nombre, 180)) {
      return res.status(400).json({ success: false, error: 'Nombre del alumno, apoderado y correo son obligatorios.' });
    }

    const { data: pre, error: preError } = await supabase.from('prematriculas')
      .select('*')
      .eq('id', req.params.id)
      .eq('academia_id', academia_id)
      .maybeSingle();
    if (preError) throw preError;
    if (!pre) return res.status(404).json({ success: false, error: 'Pre-matrícula no encontrada.' });
    if (!['enviada', 'abierta', 'error'].includes(pre.estado)) {
      return res.status(409).json({ success: false, error: 'Esta pre-matrícula ya no puede modificarse.' });
    }

    if (jugador.rut) {
      await assertRutAvailable({
        supabase,
        academiaId: academia_id,
        rut: jugador.rut,
        excludePrematriculaId: pre.id,
      });
    }

    const { data: academia, error: academyError } = await supabase.from('academias').select('*').eq('id', academia_id).single();
    if (academyError || !academia) return res.status(404).json({ success: false, error: 'Academia no encontrada.' });

    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86400000).toISOString();
    const termsSnapshot = selectEnrollmentTerms(academia) || 'La academia no mantiene condiciones adicionales de matrícula configuradas en Syncademia.';
    const consentCatalog = getConsentCatalog(academia?.nombre || 'la academia');
    const now = new Date().toISOString();

    const { data: updated, error: updateError } = await supabase.from('prematriculas').update({
      estado: 'enviada',
      token_hash: tokenHash,
      expires_at: expiresAt,
      sent_at: now,
      opened_at: null,
      tutor_payload: tutor,
      jugador_payload: jugador,
      finanzas_payload: finanzas,
      evaluacion_payload: evaluacion,
      emergencia_payload: emergencia,
      privacy_version: PRIVACY_VERSION,
      terms_snapshot: termsSnapshot,
      consent_snapshot: consentCatalog,
      updated_at: now,
    }).eq('id', pre.id).eq('academia_id', academia_id).select('id,estado,expires_at').single();
    if (updateError) throw updateError;

    const link = `${FRONTEND_URL}/prematricula/${token}`;
    const emailSent = await sendPrematriculaEmail({ academia, tutor, jugador, link });
    return res.json({ success: true, data: updated, link, email_sent: emailSent });
  } catch (error) {
    console.error('Error editando pre-matrícula:', error?.message || 'Error desconocido');
    if (['PLAYER_RUT_EXISTS', 'PRE_ENROLLMENT_RUT_EXISTS'].includes(error?.code)) {
      return res.status(409).json({ success: false, code: error.code, error: error.message, conflict: error.conflict || null });
    }
    return res.status(500).json({ success: false, error: 'No fue posible actualizar la pre-matrícula.' });
  }
});

router.patch('/:id/cancelar', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('prematriculas').update({
      estado: 'cancelada',
      updated_at: new Date().toISOString(),
    })
      .eq('id', req.params.id)
      .eq('academia_id', req.user.academia_id)
      .in('estado', ['enviada', 'abierta', 'error', 'vencida'])
      .select('id,estado')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ success: false, error: 'Esta pre-matrícula ya no puede cancelarse.' });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error cancelando pre-matrícula:', error?.message || 'Error desconocido');
    return res.status(500).json({ success: false, error: 'No fue posible cancelar la pre-matrícula.' });
  }
});

router.get('/public/:token', async (req, res) => {"""
if "router.put('/:id'" not in s:
    if catch_old not in s:
        raise SystemExit('create catch/public anchor not found')
    s = s.replace(catch_old, catch_new, 1)

p.write_text(s)

# Patch services/enrollmentService.js to use canonical RUT normalization.
e = Path('services/enrollmentService.js')
t = e.read_text()
imp_anchor = "const { recalculateFinancialStatus } = require('./monthlyBilling');\n"
rut_imp = "const { normalizeRut } = require('./rutGuard');\n"
if rut_imp not in t:
    if imp_anchor not in t:
        raise SystemExit('enrollment import anchor not found')
    t = t.replace(imp_anchor, imp_anchor + rut_imp, 1)
old_player_norm = "const normalizedRut = String(jugador.rut).replace(/\\./g, '').replace(/\\s/g, '').toUpperCase();"
new_player_norm = "const normalizedRut = normalizeRut(jugador.rut);"
t = t.replace(old_player_norm, new_player_norm)
old_player_cmp = "String(row.rut || '').replace(/\\./g, '').replace(/\\s/g, '').toUpperCase() === normalizedRut"
new_player_cmp = "normalizeRut(row.rut) === normalizedRut"
t = t.replace(old_player_cmp, new_player_cmp)
old_tutor_norm = "const normalizedTutorRut = String(tutor.rut).replace(/\\./g, '').replace(/\\s/g, '').toUpperCase();"
new_tutor_norm = "const normalizedTutorRut = normalizeRut(tutor.rut);"
t = t.replace(old_tutor_norm, new_tutor_norm)
old_tutor_cmp = "String(row.rut || '').replace(/\\./g, '').replace(/\\s/g, '').toUpperCase() === normalizedTutorRut"
new_tutor_cmp = "normalizeRut(row.rut) === normalizedTutorRut"
t = t.replace(old_tutor_cmp, new_tutor_cmp)
e.write_text(t)
