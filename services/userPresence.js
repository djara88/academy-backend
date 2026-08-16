const LIVE_WINDOW_MS = Math.max(30_000, Number(process.env.PRESENCE_LIVE_WINDOW_MS || 90_000));
const AVERAGE_WINDOW_MS = Math.max(60_000, Number(process.env.PRESENCE_AVERAGE_WINDOW_MS || 15 * 60_000));
const SAMPLE_INTERVAL_MS = Math.max(10_000, Number(process.env.PRESENCE_SAMPLE_INTERVAL_MS || 30_000));

const users = new Map();
const samples = [];

const normalizeRole = (value) => String(value || 'usuario').trim().toLowerCase() || 'usuario';

const pruneUsers = (nowMs) => {
  const keepSince = nowMs - AVERAGE_WINDOW_MS;
  for (const [userId, entry] of users.entries()) {
    if (entry.lastSeen < keepSince) users.delete(userId);
  }
};

const pruneSamples = (nowMs) => {
  const keepSince = nowMs - AVERAGE_WINDOW_MS;
  while (samples.length && samples[0].at < keepSince) samples.shift();
};

const liveEntries = (nowMs) => {
  const since = nowMs - LIVE_WINDOW_MS;
  return [...users.values()].filter((entry) => entry.lastSeen >= since);
};

const recordUserPresence = (user, nowMs = Date.now()) => {
  const userId = String(user?.id || '').trim();
  if (!userId) return false;

  users.set(userId, {
    userId,
    academyId: user?.academia_id ? String(user.academia_id) : null,
    role: normalizeRole(user?.rol),
    lastSeen: nowMs,
  });
  pruneUsers(nowMs);
  return true;
};

const samplePresence = (nowMs = Date.now()) => {
  pruneUsers(nowMs);
  pruneSamples(nowMs);
  const active = liveEntries(nowMs);
  samples.push({
    at: nowMs,
    liveUsers: active.length,
    activeAcademies: new Set(active.map((entry) => entry.academyId).filter(Boolean)).size,
  });
  pruneSamples(nowMs);
  return samples[samples.length - 1];
};

const roundOne = (value) => Math.round(Number(value || 0) * 10) / 10;

const getPresenceSnapshot = (nowMs = Date.now()) => {
  pruneUsers(nowMs);
  pruneSamples(nowMs);
  const active = liveEntries(nowMs);
  const activeAcademies = new Set(active.map((entry) => entry.academyId).filter(Boolean)).size;
  const byRole = active.reduce((acc, entry) => {
    acc[entry.role] = (acc[entry.role] || 0) + 1;
    return acc;
  }, {});

  // Si el proceso acaba de iniciar, el valor actual sirve como primera muestra
  // para evitar mostrar un promedio vacío durante los primeros 30 segundos.
  const recentSamples = samples.length ? samples : [{ at: nowMs, liveUsers: active.length, activeAcademies }];
  const averageUsers = recentSamples.reduce((sum, sample) => sum + sample.liveUsers, 0) / recentSamples.length;
  const averageAcademies = recentSamples.reduce((sum, sample) => sum + sample.activeAcademies, 0) / recentSamples.length;
  const peakUsers = Math.max(active.length, ...recentSamples.map((sample) => sample.liveUsers));

  return {
    liveUsers: active.length,
    averageUsers15m: roundOne(averageUsers),
    peakUsers15m: peakUsers,
    activeAcademies,
    averageAcademies15m: roundOne(averageAcademies),
    byRole,
    liveWindowSeconds: Math.round(LIVE_WINDOW_MS / 1000),
    averageWindowMinutes: Math.round(AVERAGE_WINDOW_MS / 60_000),
    sampleIntervalSeconds: Math.round(SAMPLE_INTERVAL_MS / 1000),
    samples: recentSamples.length,
    sampledAt: new Date(nowMs).toISOString(),
  };
};

let timer = null;
const startPresenceSampler = () => {
  if (timer) return { stop: stopPresenceSampler };
  samplePresence();
  timer = setInterval(() => samplePresence(), SAMPLE_INTERVAL_MS);
  timer.unref?.();
  return { stop: stopPresenceSampler };
};

function stopPresenceSampler() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

// Solo para pruebas deterministas; no se expone por HTTP.
const resetPresenceForTests = () => {
  users.clear();
  samples.splice(0, samples.length);
  stopPresenceSampler();
};

module.exports = {
  LIVE_WINDOW_MS,
  AVERAGE_WINDOW_MS,
  SAMPLE_INTERVAL_MS,
  recordUserPresence,
  samplePresence,
  getPresenceSnapshot,
  startPresenceSampler,
  stopPresenceSampler,
  resetPresenceForTests,
};
