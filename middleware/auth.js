const supabase = require('../config/supabase');
const { isMasterAdminEmail } = require('./masterAdmin');
const { isProfessor, isAllowedProfessorRequest } = require('./professorAccess');

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

    if (usuario.activo === false) {
      return res.status(403).json({ error: 'Tu acceso está desactivado. Contacta a la dirección de tu academia.' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      academia_id: usuario.academia_id,
      rol: usuario.rol,
      nombre_completo: usuario.nombre_completo,
      activo: usuario.activo !== false,
    };

    if (isProfessor(req.user) && !isAllowedProfessorRequest(req)) {
      return res.status(403).json({
        error: 'Tu perfil de profesor solo puede acceder a las categorías que te asignó la dirección.',
      });
    }

    next();
  } catch (error) {
    console.error('❌ Error en middleware auth:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = authMiddleware;
