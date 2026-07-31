const supabase = require('../config/supabase');

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    // Verificar token con Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      console.error('❌ Error al obtener usuario desde token:', error);
      return res.status(401).json({ error: 'Token inválido' });
    }

    console.log('✅ Usuario autenticado:', user.id, user.email);

    // Consultar la tabla public.usuarios
    const { data: usuario, error: userError } = await supabase
      .from('usuarios')
      .select('*')
      .eq('id', user.id)
      .maybeSingle(); // Usamos maybeSingle() en lugar de single() para evitar error si no existe

    if (userError) {
      console.error('❌ Error al consultar public.usuarios:', userError);
      return res.status(500).json({ error: 'Error al consultar datos del usuario' });
    }

    if (!usuario) {
      console.warn('⚠️ Usuario no encontrado en public.usuarios. ID:', user.id);
      return res.status(403).json({ error: 'Usuario no registrado en el sistema' });
    }

    console.log('✅ Usuario en tabla:', usuario);

    req.user = {
      id: user.id,
      email: user.email,
      academia_id: usuario.academia_id,
      rol: usuario.rol,
      nombre_completo: usuario.nombre_completo,
    };

    next();
  } catch (error) {
    console.error('❌ Error en middleware auth:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = authMiddleware;
