const supabase = require('../config/supabase');

const authIdentityMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No autorizado' });

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Token inválido' });

    req.authUser = user;
    next();
  } catch (error) {
    console.error('Error validando identidad:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = authIdentityMiddleware;
