const supabase = require('../config/supabase');
const { isMasterAdminEmail } = require('./masterAdmin');

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No autorizado' });

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    const { data: usuario, error: userError } = await supabase
      .from('usuarios')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (userError) {
      console.error('❌ Error al consultar usuario:', userError);
      return res.status(500).json({ error: 'Error al validar el usuario' });
    }

    if (!usuario && isMasterAdminEmail(user.email)) {
      req.user = {
        id: user.id,
        email: user.email,
        academia_id: null,
        rol: 'superadmin',
        nombre_completo: 'Control Maestro SaaS',
      };
      return next();
    }

    if (!usuario) {
      return res.status(403).json({ error: 'Usuario no registrado en el sistema' });
    }

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
