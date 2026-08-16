const supabase = require('../config/supabase');
const { isMasterAdminEmail } = require('./masterAdmin');
const { isProfessor, isGuardian, isAllowedProfessorRequest, isAllowedGuardianRequest } = require('./professorAccess');
const { getSubscriptionState } = require('../services/subscriptionAccess');

const getAuthenticatorLevelFromToken = (token) => {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return 'aal1';
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload?.aal === 'aal2' ? 'aal2' : 'aal1';
  } catch (_error) {
    return 'aal1';
  }
};

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No autorizado' });

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Token inválido' });

    req.auth = { aal: getAuthenticatorLevelFromToken(token) };

    const { data: usuario, error: userError } = await supabase
      .from('usuarios').select('*').eq('id', user.id).maybeSingle();
    if (userError) {
      console.error('❌ Error al consultar usuario:', userError);
      return res.status(500).json({ error: 'Error al validar el usuario' });
    }

    if (isMasterAdminEmail(user.email)) {
      req.user = { id: user.id, email: user.email, academia_id: null, rol: 'superadmin', nombre_completo: 'Control Maestro SaaS' };
      return next();
    }

    if (!usuario) return res.status(403).json({ error: 'Usuario no registrado en el sistema' });
    if (usuario.activo === false) return res.status(403).json({ error: 'Tu acceso está desactivado. Contacta a la dirección de tu academia.' });

    let academy = null;
    if (usuario.academia_id) {
      const { data, error: academyError } = await supabase.from('academias')
        .select('id,nombre,estado,plan,plan_codigo,max_profesores,max_jugadores,licencia_apoderados,subscription_status,trial_started_at,trial_ends_at,blocked_at,blocked_reason,next_billing_date,plan_price_clp,guardian_price_clp')
        .eq('id', usuario.academia_id).maybeSingle();
      if (academyError) return res.status(500).json({ error: 'Error al validar la suscripción de la academia' });
      if (!data) return res.status(403).json({ error: 'La academia asociada ya no existe', code: 'ACADEMY_NOT_FOUND' });
      academy = data;
      const access = getSubscriptionState(academy);
      req.academy = academy;
      req.subscription = access;
      if (access.blocked) {
        if (access.trial && access.status === 'suspended') {
          await supabase.from('academias').update({
            estado: 'Bloqueada', subscription_status: 'suspended',
            blocked_at: academy.blocked_at || new Date().toISOString(),
            blocked_reason: academy.blocked_reason || 'Prueba gratuita vencida',
          }).eq('id', academy.id).eq('subscription_status', 'trialing');
        }
        const allowedWhileBlocked = [
          '/api/academias/mi-plan', '/api/subscriptions/plans', '/api/subscriptions/checkout',
          '/api/subscriptions/payment-status', '/api/cambiar-password', '/api/presence/heartbeat',
        ];
        const path = req.originalUrl?.split('?')[0] || '';
        if (!allowedWhileBlocked.includes(path)) {
          return res.status(403).json({
            error: access.reason || 'La suscripción de esta academia se encuentra bloqueada.',
            code: access.trial ? 'TRIAL_EXPIRED' : 'ACADEMY_BLOCKED', subscription: access,
          });
        }
      }
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
      return res.status(403).json({ error: 'Tu perfil de profesor solo puede acceder a las categorías que te asignó la dirección.' });
    }
    if (isGuardian(req.user) && !isAllowedGuardianRequest(req)) {
      return res.status(403).json({ error: 'Tu perfil de apoderado solo puede acceder a la información de tus jugadores vinculados.' });
    }
    next();
  } catch (error) {
    console.error('❌ Error en middleware auth:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = authMiddleware;
module.exports.getAuthenticatorLevelFromToken = getAuthenticatorLevelFromToken;
