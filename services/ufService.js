const { FALLBACK_UF_CLP } = require('./billingCatalog');

let cached = { value: FALLBACK_UF_CLP, fetchedAt: 0, source: 'fallback' };
const CACHE_MS = 6 * 60 * 60 * 1000;

const getUfValue = async () => {
  if (Date.now() - cached.fetchedAt < CACHE_MS) return cached;
  try {
    const response = await fetch('https://mindicador.cl/api/uf', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`UF HTTP ${response.status}`);
    const payload = await response.json();
    const value = Number(payload?.serie?.[0]?.valor);
    if (!Number.isFinite(value) || value <= 0) throw new Error('UF inválida');
    cached = { value, fetchedAt: Date.now(), source: 'mindicador.cl' };
  } catch (error) {
    console.warn('No se pudo actualizar la UF; se usará el valor de respaldo:', error.message);
    cached = { ...cached, fetchedAt: Date.now() };
  }
  return cached;
};

module.exports = { getUfValue };

