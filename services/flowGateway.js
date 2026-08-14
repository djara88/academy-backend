const crypto = require('crypto');

const baseUrl = () => process.env.FLOW_BASE_URL || 'https://www.flow.cl/api';
const isConfigured = () => Boolean(process.env.FLOW_API_KEY && process.env.FLOW_SECRET_KEY);

const sign = (params) => {
  const payload = Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('');
  return crypto.createHmac('sha256', process.env.FLOW_SECRET_KEY || '').update(payload).digest('hex');
};

const request = async (path, params, method = 'POST') => {
  if (!isConfigured()) throw Object.assign(new Error('La pasarela Flow aún no tiene sus credenciales configuradas.'), { code: 'FLOW_NOT_CONFIGURED' });
  const signed = { ...params, apiKey: process.env.FLOW_API_KEY };
  signed.s = sign(signed);
  const body = new URLSearchParams(Object.entries(signed).map(([key, value]) => [key, String(value)]));
  const response = await fetch(`${baseUrl()}${path}${method === 'GET' ? `?${body}` : ''}`, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined,
    body: method === 'POST' ? body : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Flow respondió HTTP ${response.status}`);
  return data;
};

const createPayment = (payload) => request('/payment/create', payload, 'POST');
const getPaymentStatus = (token) => request('/payment/getStatus', { token }, 'GET');

module.exports = { isConfigured, createPayment, getPaymentStatus };

