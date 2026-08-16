from pathlib import Path
p=Path('routes/apoderados.js')
s=p.read_text()

s=s.replace(".select('id,nombre,nombre_completo,email,telefono,parentesco,usuario_id,acceso_activo,invitado_at,created_at')",
            ".select('id,nombre,nombre_completo,rut,email,telefono,parentesco,direccion,usuario_id,acceso_activo,invitado_at,created_at')",1)

anchor="router.post('/:id/acceso', authMiddleware, requireDirector, ...guardianFeature, async (req, res) => {\n"
route=r'''router.patch('/:id', authMiddleware, requireDirector, ...guardianFeature, async (req, res) => {
  const clean = (value, max = 240) => String(value ?? '').trim().slice(0, max);
  let previousAuth = null;
  try {
    const nombreCompleto = clean(req.body?.nombre_completo, 180);
    const rut = clean(req.body?.rut, 40) || null;
    const telefono = clean(req.body?.telefono, 80) || null;
    const email = clean(req.body?.email, 240).toLowerCase() || null;
    const parentesco = clean(req.body?.parentesco, 80) || null;
    const direccion = clean(req.body?.direccion, 300) || null;
    if (!nombreCompleto) return res.status(400).json({ error: 'El nombre del apoderado es obligatorio.' });
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Ingresa un correo válido.' });

    const { data: tutor, error: tutorError } = await supabase.from('tutores')
      .select('id,nombre,nombre_completo,rut,email,telefono,parentesco,direccion,usuario_id')
      .eq('id', req.params.id).eq('academia_id', req.user.academia_id).maybeSingle();
    if (tutorError) throw tutorError;
    if (!tutor) return res.status(404).json({ error: 'Apoderado no encontrado.' });

    if (rut) {
      const normalized = rut.replace(/[^0-9kK]/g, '').toUpperCase();
      const { data: peers, error: peerError } = await supabase.from('tutores').select('id,rut,nombre_completo')
        .eq('academia_id', req.user.academia_id).neq('id', tutor.id);
      if (peerError) throw peerError;
      const duplicate = (peers || []).find((item) => String(item.rut || '').replace(/[^0-9kK]/g, '').toUpperCase() === normalized);
      if (duplicate) return res.status(409).json({ error: `Ya existe otro apoderado con ese RUT: ${duplicate.nombre_completo || 'Apoderado'}.` });
    }

    if (tutor.usuario_id) {
      previousAuth = { email: tutor.email || null, name: tutor.nombre_completo || tutor.nombre || 'Apoderado' };
      const authUpdate = { user_metadata: { full_name: nombreCompleto } };
      if (email && email !== String(tutor.email || '').toLowerCase()) {
        authUpdate.email = email;
        authUpdate.email_confirm = true;
      }
      const { error: authError } = await supabase.auth.admin.updateUserById(tutor.usuario_id, authUpdate);
      if (authError) {
        if (authError.status === 422 || String(authError.message || '').toLowerCase().includes('email')) {
          return res.status(409).json({ error: 'Ese correo ya está vinculado a otra cuenta de Syncademia.' });
        }
        throw authError;
      }
    }

    const { data: updated, error: updateError } = await supabase.from('tutores').update({
      nombre: nombreCompleto,
      nombre_completo: nombreCompleto,
      rut,
      telefono,
      email,
      parentesco,
      direccion,
    }).eq('id', tutor.id).eq('academia_id', req.user.academia_id)
      .select('id,nombre_completo,rut,email,telefono,parentesco,direccion,usuario_id,acceso_activo').single();
    if (updateError) throw updateError;

    if (tutor.usuario_id) {
      const { error: userError } = await supabase.from('usuarios').update({
        nombre: nombreCompleto,
        nombre_completo: nombreCompleto,
        email,
        correo: email,
      }).eq('id', tutor.usuario_id).eq('academia_id', req.user.academia_id);
      if (userError) throw userError;
    }

    return res.json({ success: true, data: updated, message: 'Datos del apoderado actualizados.' });
  } catch (error) {
    if (previousAuth) {
      try {
        const { data: currentTutor } = await supabase.from('tutores').select('usuario_id').eq('id', req.params.id).maybeSingle();
        if (currentTutor?.usuario_id) {
          const rollback = { user_metadata: { full_name: previousAuth.name } };
          if (previousAuth.email) { rollback.email = previousAuth.email; rollback.email_confirm = true; }
          await supabase.auth.admin.updateUserById(currentTutor.usuario_id, rollback);
        }
      } catch (_rollbackError) {}
    }
    console.error('Error actualizando apoderado:', error?.message || 'Error desconocido');
    return res.status(500).json({ error: 'No fue posible actualizar los datos del apoderado.' });
  }
});

'''
if "router.patch('/:id', authMiddleware" not in s:
    if anchor not in s: raise SystemExit('anchor not found')
    s=s.replace(anchor,route+anchor,1)
p.write_text(s)
