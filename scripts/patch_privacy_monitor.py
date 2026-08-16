from pathlib import Path

# Fix helper count logic in privacyExecution
p = Path('services/privacyExecution.js')
s = p.read_text()
s = s.replace("  const { error, count } = await query.select('jugador_id', { count: 'exact', head: true });\n  if (error) throw error;\n  return Number(count || 0);", "  const { data, error } = await query.select('jugador_id');\n  if (error) throw error;\n  return len(data or []) if False else Number(data?.length || 0);")
# JS replacement above cannot contain Python len; normalize final literal safely
s = s.replace("  return len(data or []) if False else Number(data?.length || 0);", "  return Number(data?.length || 0);")
p.write_text(s)

# server.js
p = Path('server.js')
s = p.read_text()
needle = "const { validatePassword } = require('./services/passwordPolicy');\n"
if "requestFailureRecorder" not in s:
    s = s.replace(needle, needle + "const { requestFailureRecorder } = require('./services/systemMonitor');\n")
needle = "app.use(cors({\n"
if "app.use(requestFailureRecorder);" not in s:
    s = s.replace(needle, "app.use(requestFailureRecorder);\n\n" + needle)
needle = "const subscriptionRoutes = require('./routes/subscriptions');\n"
if "privacyRequestRoutes" not in s:
    s = s.replace(needle, needle + "const privacyRequestRoutes = require('./routes/privacyRequests');\n")
needle = "app.use('/api/subscriptions', subscriptionRoutes);\n"
if "app.use('/api/privacy-requests'" not in s:
    s = s.replace(needle, needle + "app.use('/api/privacy-requests', privacyRequestRoutes);\n")
p.write_text(s)

# saasAdmin.js
p = Path('routes/saasAdmin.js')
s = p.read_text()
needle = "const { activateChargePlan } = require('../services/subscriptionBilling');\n"
if "getSystemMonitorSnapshot" not in s:
    s = s.replace(needle, needle + "const { getSystemMonitorSnapshot } = require('../services/systemMonitor');\n")
needle = "router.get('/resumen', async (_req, res) => {\n"
if "router.get('/monitor'" not in s:
    block = "router.get('/monitor', async (_req, res) => {\n  try {\n    const data = await getSystemMonitorSnapshot();\n    res.json({ success: true, data });\n  } catch (error) {\n    console.error('Error cargando monitor del sistema:', error?.message || 'Error desconocido');\n    res.status(500).json({ error: 'No fue posible cargar el monitor del sistema.' });\n  }\n});\n\n"
    s = s.replace(needle, block + needle)
p.write_text(s)

# apoderados.js guardian privacy endpoints
p = Path('routes/apoderados.js')
s = p.read_text()
if "PRIVACY_TYPES" not in s:
    insert_after = "const temporaryPassword = () => `${crypto.randomBytes(9).toString('base64url')}A9!`;\n"
    s = s.replace(insert_after, insert_after + "const PRIVACY_TYPES = new Set(['acceso', 'rectificacion', 'supresion', 'oposicion', 'portabilidad', 'bloqueo', 'revocacion_imagen']);\nconst safeText = (value, max = 5000) => String(value ?? '').trim().slice(0, max);\n")

marker = "module.exports = router;"
if "'/me/solicitudes-privacidad'" not in s:
    block = r'''
router.get('/me/solicitudes-privacidad', authMiddleware, requireGuardian, ...guardianFeature, async (req, res) => {
  try {
    const { data: tutor, error: tutorError } = await supabase.from('tutores')
      .select('id').eq('usuario_id', req.user.id).eq('academia_id', req.user.academia_id).eq('acceso_activo', true).maybeSingle();
    if (tutorError || !tutor) return res.status(403).json({ error: 'Tu acceso de apoderado no está activo.' });
    const { data, error } = await supabase.from('solicitudes_privacidad')
      .select('id,jugador_id,tipo,estado,detalle,fecha_recepcion,fecha_limite,fecha_limite_prorrogada,respuesta,fecha_resolucion,fecha_ejecucion,jugadores(id,nombre)')
      .eq('academia_id', req.user.academia_id).eq('tutor_id', tutor.id).order('fecha_recepcion', { ascending: false }).limit(100);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (error) {
    res.status(500).json({ error: 'No fue posible cargar tus solicitudes de privacidad.' });
  }
});

router.post('/me/solicitudes-privacidad', authMiddleware, requireGuardian, ...guardianFeature, async (req, res) => {
  try {
    const tipo = safeText(req.body?.tipo, 40).toLowerCase();
    if (!PRIVACY_TYPES.has(tipo)) return res.status(400).json({ error: 'Tipo de solicitud no válido.' });
    const { data: tutor, error: tutorError } = await supabase.from('tutores')
      .select('id,nombre,nombre_completo,rut,email').eq('usuario_id', req.user.id).eq('academia_id', req.user.academia_id).eq('acceso_activo', true).maybeSingle();
    if (tutorError || !tutor) return res.status(403).json({ error: 'Tu acceso de apoderado no está activo.' });
    const players = await getTutorPlayers(req.user.academia_id, tutor.id);
    const playerId = safeText(req.body?.jugador_id, 80);
    const player = players.find((item) => String(item.id) === playerId);
    if (!player) return res.status(403).json({ error: 'Solo puedes solicitar acciones sobre alumnos vinculados a tu cuenta.' });
    const now = new Date();
    const blockRequested = req.body?.bloqueo_solicitado === true && ['rectificacion', 'supresion', 'oposicion', 'bloqueo'].includes(tipo);
    const { data: created, error } = await supabase.from('solicitudes_privacidad').insert({
      academia_id: req.user.academia_id,
      jugador_id: player.id,
      tutor_id: tutor.id,
      tipo,
      estado: 'verificacion_pendiente',
      canal: 'portal_apoderado',
      solicitante_nombre: tutor.nombre_completo || tutor.nombre || 'Apoderado',
      solicitante_documento: tutor.rut || null,
      solicitante_email: tutor.email || req.user.email,
      detalle: safeText(req.body?.detalle, 5000) || null,
      cambios_solicitados: req.body?.cambios_solicitados && typeof req.body.cambios_solicitados === 'object' ? req.body.cambios_solicitados : {},
      bloqueo_solicitado: blockRequested,
      fecha_recepcion: now.toISOString(),
      fecha_limite: new Date(now.getTime() + 30 * 86400000).toISOString(),
      created_by: req.user.id,
    }).select('*').single();
    if (error) throw error;
    await supabase.from('solicitudes_privacidad_eventos').insert({
      solicitud_id: created.id,
      academia_id: req.user.academia_id,
      evento: 'solicitud_portal_apoderado',
      actor_user_id: req.user.id,
      detalle: { tipo, jugador_id: player.id },
    });
    res.status(201).json({ success: true, data: created });
  } catch (error) {
    console.error('Error registrando solicitud desde portal:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible registrar tu solicitud.' });
  }
});

'''
    s = s.replace(marker, block + marker)
p.write_text(s)
