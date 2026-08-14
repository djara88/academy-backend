const DAY_MS = 24 * 60 * 60 * 1000;

const normalize = (value) => String(value || '').trim().toLowerCase();
const isActiveAcademyState = (value) => ['activa', 'activo', 'active'].includes(normalize(value));

const getSubscriptionState = (academy = {}, now = new Date()) => {
  const status = normalize(academy.subscription_status || 'active');
  const trialEnd = academy.trial_ends_at ? new Date(academy.trial_ends_at) : null;
  const remainingMs = trialEnd ? trialEnd.getTime() - now.getTime() : null;
  const trialExpired = status === 'trialing' && remainingMs !== null && remainingMs <= 0;
  const blockedByStatus = ['past_due', 'suspended', 'cancelled'].includes(status);
  const blocked = trialExpired || blockedByStatus || !isActiveAcademyState(academy.estado);

  return {
    status: trialExpired ? 'suspended' : status,
    blocked,
    trial: status === 'trialing',
    trialStartedAt: academy.trial_started_at || null,
    trialEndsAt: academy.trial_ends_at || null,
    remainingDays: remainingMs === null ? null : Math.max(0, Math.ceil(remainingMs / DAY_MS)),
    remainingHours: remainingMs === null ? null : Math.max(0, Math.ceil(remainingMs / (60 * 60 * 1000))),
    urgency: remainingMs === null ? null : remainingMs <= DAY_MS ? 'critical' : remainingMs <= 3 * DAY_MS ? 'high' : remainingMs <= 7 * DAY_MS ? 'medium' : 'normal',
    reason: trialExpired ? 'Prueba gratuita vencida' : academy.blocked_reason || null,
  };
};

module.exports = { getSubscriptionState, isActiveAcademyState };

