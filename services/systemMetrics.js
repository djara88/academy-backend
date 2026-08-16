const supabase = require('../config/supabase');

const MB = 1024 * 1024;
const DEFAULT_LIMIT_MB = Math.max(128, Number(process.env.SYSTEM_MEMORY_LIMIT_MB || 512));
const SAMPLE_INTERVAL_MS = Math.max(60_000, Number(process.env.SYSTEM_METRICS_INTERVAL_MS || 5 * 60_000));
const RETENTION_DAYS = Math.min(90, Math.max(7, Number(process.env.SYSTEM_METRICS_RETENTION_DAYS || 30)));
let samplerTimer = null;
let cleanupAt = 0;

const memorySample = () => {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const rssMb = Math.round(memory.rss / MB);
  const heapMb = Math.round(memory.heapUsed / MB);
  return {
    captured_at: new Date().toISOString(),
    instance_id: process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || null,
    commit_sha: process.env.RENDER_GIT_COMMIT?.slice(0, 12) || null,
    uptime_seconds: Math.round(process.uptime()),
    memory_rss_mb: rssMb,
    heap_used_mb: heapMb,
    memory_percent: Math.round((rssMb / DEFAULT_LIMIT_MB) * 100),
    memory_limit_mb: DEFAULT_LIMIT_MB,
    cpu_user_ms: Math.round(cpu.user / 1000),
    cpu_system_ms: Math.round(cpu.system / 1000),
  };
};

const captureSystemMetric = async () => {
  try {
    const sample = memorySample();
    const { error } = await supabase.from('system_metrics').insert(sample);
    if (error) throw error;
    const now = Date.now();
    if (now >= cleanupAt) {
      cleanupAt = now + 24 * 60 * 60 * 1000;
      const cutoff = new Date(now - RETENTION_DAYS * 86400000).toISOString();
      const { error: cleanupError } = await supabase.from('system_metrics').delete().lt('captured_at', cutoff);
      if (cleanupError) console.warn('No fue posible limpiar métricas antiguas:', cleanupError.message);
    }
    return sample;
  } catch (error) {
    console.warn('No fue posible guardar la muestra del monitor:', error?.message || 'Error desconocido');
    return null;
  }
};

const startSystemMetricsSampler = () => {
  if (samplerTimer) return { stop: stopSystemMetricsSampler };
  const initial = setTimeout(() => void captureSystemMetric(), 5000);
  initial.unref?.();
  samplerTimer = setInterval(() => void captureSystemMetric(), SAMPLE_INTERVAL_MS);
  samplerTimer.unref?.();
  return { stop: stopSystemMetricsSampler };
};

function stopSystemMetricsSampler() {
  if (samplerTimer) clearInterval(samplerTimer);
  samplerTimer = null;
}

const average = (values) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
const nearestBefore = (rows, targetMs) => {
  let candidate = null;
  for (const row of rows) {
    const at = new Date(row.captured_at).getTime();
    if (at <= targetMs) candidate = row;
    else break;
  }
  return candidate || rows[0] || null;
};

const getMemoryHistory = async (hours = 24) => {
  const safeHours = Math.min(24 * 30, Math.max(1, Number(hours || 24)));
  const since = new Date(Date.now() - safeHours * 3600000).toISOString();
  const { data, error } = await supabase.from('system_metrics')
    .select('captured_at,instance_id,commit_sha,uptime_seconds,memory_rss_mb,heap_used_mb,memory_percent,memory_limit_mb,cpu_user_ms,cpu_system_ms')
    .gte('captured_at', since)
    .order('captured_at', { ascending: true })
    .limit(10000);
  if (error) throw error;
  const rows = data || [];
  const now = Date.now();
  const current = rows[rows.length - 1] || memorySample();
  const lastHour = rows.filter((row) => new Date(row.captured_at).getTime() >= now - 3600000);
  const last6h = rows.filter((row) => new Date(row.captured_at).getTime() >= now - 6 * 3600000);
  const last24h = rows.filter((row) => new Date(row.captured_at).getTime() >= now - 24 * 3600000);
  const oneHourAgo = nearestBefore(rows, now - 3600000);
  const sixHoursAgo = nearestBefore(rows, now - 6 * 3600000);
  const dayAgo = nearestBefore(rows, now - 24 * 3600000);
  const delta = (oldRow) => oldRow ? current.memory_rss_mb - oldRow.memory_rss_mb : null;
  const durationHours = last6h.length > 1
    ? Math.max(0.1, (new Date(last6h[last6h.length - 1].captured_at) - new Date(last6h[0].captured_at)) / 3600000)
    : 0;
  const delta6h = delta(sixHoursAgo);
  const slope6h = durationHours && last6h.length >= 6 ? Number(((last6h[last6h.length - 1].memory_rss_mb - last6h[0].memory_rss_mb) / durationHours).toFixed(1)) : null;
  const enoughHistory = rows.length >= 6;
  const suspectedLeak = enoughHistory && last6h.length >= 12 && Number(delta6h || 0) >= 80 && Number(slope6h || 0) >= 10;
  const trendStatus = suspectedLeak && current.memory_percent >= 70 ? 'critical' : suspectedLeak ? 'warning' : enoughHistory ? 'stable' : 'collecting';

  return {
    range_hours: safeHours,
    sample_interval_minutes: Math.round(SAMPLE_INTERVAL_MS / 60000),
    retention_days: RETENTION_DAYS,
    rows,
    summary: {
      current_rss_mb: current.memory_rss_mb,
      current_percent: current.memory_percent,
      avg_1h_mb: average(lastHour.map((row) => row.memory_rss_mb)),
      avg_6h_mb: average(last6h.map((row) => row.memory_rss_mb)),
      avg_24h_mb: average(last24h.map((row) => row.memory_rss_mb)),
      min_24h_mb: last24h.length ? Math.min(...last24h.map((row) => row.memory_rss_mb)) : null,
      max_24h_mb: last24h.length ? Math.max(...last24h.map((row) => row.memory_rss_mb)) : null,
      delta_1h_mb: delta(oneHourAgo),
      delta_6h_mb: delta6h,
      delta_24h_mb: delta(dayAgo),
      slope_6h_mb_per_hour: slope6h,
      suspected_leak: suspectedLeak,
      status: trendStatus,
      samples: rows.length,
    },
  };
};

module.exports = { captureSystemMetric, startSystemMetricsSampler, stopSystemMetricsSampler, getMemoryHistory };
