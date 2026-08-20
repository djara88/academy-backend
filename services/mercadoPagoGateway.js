const crypto = require('crypto');
const supabase = require('../config/supabase');
const { fetchWithTimeout } = require('./httpClient');

const API_BASE = 'https://api.mercadopago.com';
const PLATFORM_ACCESS_TOKEN = () => String(process.env.MERCADO_PAGO_PLATFORM_ACCESS_TOKEN || '').trim();
const CLIENT_ID = () => String(process.env.MERCADO_PAGO_CLIENT_ID || '').trim();
const CLIENT_SECRET = () => String(process.env.MERCADO_PAGO_CLIENT_SECRET || '').trim();
const WEBHOOK_SECRET = () => String(process.env.MERCADO_PAGO_WEBHOOK_SECRET || '').trim();
const OAUTH_REDIRECT_URI = () => String(process.env.MERCADO_PAGO_REDIRECT_URI || 'https://academy-backend-kqsv.onrender.com/api/mercadopago/oauth/callback').trim();
const PUBLIC_API_URL = () => String(process.env.PUBLIC_API_URL || 'https://academy-backend-kqsv.onrender.com').replace(/\/$/, '');
const PUBLIC_WEB_URL = () => String(process.env.PUBLIC_WEB_URL || 'https://deportivo.lestra.app').replace(/\/$/, '');
const OAUTH_STATE_SECRET = () => String(process.env.MERCADO_PAGO_OAUTH_STATE_SECRET || process.env.COLLECTION_PORTAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

const gatewayCapabilities = () => ({
  platformCheckout: Boolean(PLATFORM_ACCESS_TOKEN()),
  marketplaceOAuth: Boolean(CLIENT_ID() && CLIENT_SECRET() && OAUTH_REDIRECT_URI()),
  webhookValidation: Boolean(WEBHOOK_SECRET()),
});

const mpRequest = async (path, { accessToken, method = 'GET', body = null, timeoutMs = 12000 } = {}) => {
  if (!accessToken) {
    const error = new Error('Mercado Pago no tiene credenciales configuradas para esta operación.');
    error.code = 'MERCADOPAGO_NOT_CONFIGURED';
    throw error;
  }
  const response = await fetchWithTimeout(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, timeoutMs);
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const detail = payload?.message || payload?.error || `HTTP ${response.status}`;
    const error = new Error(`Mercado Pago rechazó la operación: ${detail}`);
    error.status = response.status;
    error.code = payload?.error || 'MERCADOPAGO_API_ERROR';
    error.details = payload;
    throw error;
  }
  return payload;
};

const oauthTokenRequest = async (payload) => {
  const response = await fetchWithTimeout(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 12000);
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok || !data?.access_token) {
    const error = new Error(`Mercado Pago no pudo completar OAuth: ${data?.message || data?.error || `HTTP ${response.status}`}`);
    error.status = response.status;
    error.code = data?.error || 'MERCADOPAGO_OAUTH_ERROR';
    error.details = data;
    throw error;
  }
  return data;
};

const createPreference = async ({ accessToken, externalReference, title, amountClp, payerEmail = null, metadata = {}, orderId }) => {
  const amount = Math.round(Number(amountClp || 0));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('El monto de checkout debe ser mayor que cero.');
  const webBase = PUBLIC_WEB_URL();
  const apiBase = PUBLIC_API_URL();
  const body = {
    items: [{ id: orderId, title: String(title || 'Pago Lestra').slice(0, 240), quantity: 1, currency_id: 'CLP', unit_price: amount }],
    external_reference: String(externalReference),
    back_urls: {
      success: `${webBase}/pago-resultado?order=${encodeURIComponent(orderId)}&status=success`,
      pending: `${webBase}/pago-resultado?order=${encodeURIComponent(orderId)}&status=pending`,
      failure: `${webBase}/pago-resultado?order=${encodeURIComponent(orderId)}&status=failure`,
    },
    auto_return: 'approved',
    notification_url: `${apiBase}/api/mercadopago/webhook`,
    metadata: { lestra_order_id: orderId, ...metadata },
  };
  if (payerEmail && /^\S+@\S+\.\S+$/.test(String(payerEmail))) body.payer = { email: String(payerEmail).trim().toLowerCase() };
  return mpRequest('/checkout/preferences', { accessToken, method: 'POST', body });
};

const getPayment = async ({ accessToken, paymentId }) => mpRequest(`/v1/payments/${encodeURIComponent(String(paymentId))}`, { accessToken });

const storeSecret = async ({ secretId = null, value, name, description = '' }) => {
  const { data, error } = await supabase.rpc('store_mercadopago_secret', {
    p_secret_id: secretId,
    p_secret: value,
    p_name: name,
    p_description: description,
  });
  if (error) throw error;
  return data;
};

const readSecret = async (secretId) => {
  if (!secretId) return null;
  const { data, error } = await supabase.rpc('read_mercadopago_secret', { p_secret_id: secretId });
  if (error) throw error;
  return data || null;
};

const storeAcademyCredentials = async ({ academyId, oauth }) => {
  const { data: existing, error: existingError } = await supabase.from('mercadopago_conexiones')
    .select('*').eq('academia_id', academyId).maybeSingle();
  if (existingError) throw existingError;
  const accessSecretId = await storeSecret({
    secretId: existing?.access_secret_id || null,
    value: oauth.access_token,
    name: `mercadopago-access-${academyId}`,
    description: `Access Token Mercado Pago academia ${academyId}`,
  });
  let refreshSecretId = existing?.refresh_secret_id || null;
  if (oauth.refresh_token) {
    refreshSecretId = await storeSecret({
      secretId: refreshSecretId,
      value: oauth.refresh_token,
      name: `mercadopago-refresh-${academyId}`,
      description: `Refresh Token Mercado Pago academia ${academyId}`,
    });
  }
  const expiresAt = oauth.expires_in ? new Date(Date.now() + Number(oauth.expires_in) * 1000).toISOString() : null;
  const row = {
    academia_id: academyId,
    mp_user_id: Number(oauth.user_id) || null,
    access_secret_id: accessSecretId,
    refresh_secret_id: refreshSecretId,
    token_expires_at: expiresAt,
    scope: oauth.scope || null,
    status: 'conectado',
    connected_at: existing?.connected_at || new Date().toISOString(),
    last_refresh_at: existing ? new Date().toISOString() : null,
    last_error: null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('mercadopago_conexiones').upsert(row, { onConflict: 'academia_id' }).select('*').single();
  if (error) throw error;
  return data;
};

const refreshAcademyCredentials = async (connection) => {
  const refreshToken = await readSecret(connection.refresh_secret_id);
  if (!refreshToken) throw new Error('La conexión Mercado Pago no tiene refresh token. Debe vincularse nuevamente.');
  const oauth = await oauthTokenRequest({
    client_id: CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return storeAcademyCredentials({ academyId: connection.academia_id, oauth });
};

const getAcademyConnection = async (academyId, { withAccessToken = false } = {}) => {
  let { data: connection, error } = await supabase.from('mercadopago_conexiones').select('*').eq('academia_id', academyId).maybeSingle();
  if (error) throw error;
  if (!connection || connection.status !== 'conectado') return null;
  const expiresSoon = connection.token_expires_at && new Date(connection.token_expires_at).getTime() < Date.now() + 7 * 24 * 60 * 60 * 1000;
  if (expiresSoon && CLIENT_ID() && CLIENT_SECRET() && connection.refresh_secret_id) {
    try { connection = await refreshAcademyCredentials(connection); }
    catch (refreshError) {
      await supabase.from('mercadopago_conexiones').update({ status: 'error', last_error: String(refreshError.message || refreshError).slice(0, 500), updated_at: new Date().toISOString() }).eq('id', connection.id);
      throw refreshError;
    }
  }
  if (!withAccessToken) return connection;
  const accessToken = await readSecret(connection.access_secret_id);
  if (!accessToken) return null;
  return { ...connection, accessToken };
};

const exchangeAuthorizationCode = async ({ code, redirectUri = OAUTH_REDIRECT_URI() }) => oauthTokenRequest({
  client_id: CLIENT_ID(),
  client_secret: CLIENT_SECRET(),
  grant_type: 'authorization_code',
  code,
  redirect_uri: redirectUri,
});

const signState = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', OAUTH_STATE_SECRET()).update(body).digest('base64url');
  return `${body}.${signature}`;
};

const verifyState = (state) => {
  const [body, signature] = String(state || '').split('.');
  if (!body || !signature || !OAUTH_STATE_SECRET()) return null;
  const expected = crypto.createHmac('sha256', OAUTH_STATE_SECRET()).update(body).digest();
  let received;
  try { received = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload?.academyId || !payload?.exp || Number(payload.exp) < Date.now()) return null;
  return payload;
};

const buildAuthorizationUrl = ({ academyId, userId }) => {
  if (!CLIENT_ID() || !CLIENT_SECRET()) throw new Error('OAuth de Mercado Pago no está configurado en Lestra.');
  const state = signState({ academyId, userId, nonce: crypto.randomUUID(), exp: Date.now() + 10 * 60 * 1000 });
  const url = new URL('https://auth.mercadopago.com/authorization');
  url.searchParams.set('client_id', CLIENT_ID());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('platform_id', 'mp');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', OAUTH_REDIRECT_URI());
  return url.toString();
};

const validateWebhookSignature = ({ xSignature, xRequestId, dataId }) => {
  const secret = WEBHOOK_SECRET();
  if (!secret) return false;
  const parts = Object.fromEntries(String(xSignature || '').split(',').map((part) => part.trim().split('=').map((value) => value?.trim())).filter(([key, value]) => key && value));
  if (!parts.ts || !parts.v1) return false;
  const id = dataId == null ? '' : String(dataId).toLowerCase();
  const manifest = `${id ? `id:${id};` : ''}${xRequestId ? `request-id:${xRequestId};` : ''}ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest();
  let received;
  try { received = Buffer.from(parts.v1, 'hex'); } catch { return false; }
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
};

module.exports = {
  PLATFORM_ACCESS_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  WEBHOOK_SECRET,
  OAUTH_REDIRECT_URI,
  PUBLIC_API_URL,
  PUBLIC_WEB_URL,
  gatewayCapabilities,
  createPreference,
  getPayment,
  getAcademyConnection,
  storeAcademyCredentials,
  exchangeAuthorizationCode,
  buildAuthorizationUrl,
  verifyState,
  validateWebhookSignature,
};
