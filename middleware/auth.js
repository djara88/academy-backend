const supabase = require('../config/supabase');

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    console.log('🔍 Token recibido:', token.substring(0, 30) + '...');

    // Verificar token con Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      console.error('❌ Error al obtener usuario:', error);
      return res.status(401).json({ error: 'Token inválido' });
    }

    console.log('✅ Usuario autenticado:', user.id, user.email);

    // Obtener datos del usuario desde nuestra tabla "usuarios"
    const { data: usuario, error: userError } = await supabase
      .from('usuarios')
      .select('*')
      .eq('id', user.id)
      .single();

    if (userError || !usuario) {
      console.error('❌ Usuario no encontrado en tabla usuarios:', userError);
      return res.status(403).json({ error: 'Usuario no registrado en el sistema' });
    }

    console.log('✅ Usuario en tabla:', usuario);

    req.user = {
      id: user.id,
      email: user.email,
      academia_id: usuario.academia_id,
      rol: usuario.rol,
    };

    next();
  } catch (error) {
    console.error('❌ Error en middleware auth:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = authMiddleware;
