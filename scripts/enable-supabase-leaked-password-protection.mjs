const PROJECT_REF = String(process.env.SUPABASE_PROJECT_REF || 'yihcktculicmuuzzxzik').trim();
const ACCESS_TOKEN = String(process.env.SUPABASE_ACCESS_TOKEN || '').trim();
const CHECK_ONLY = process.argv.includes('--check');

if (!PROJECT_REF) {
  console.error('SUPABASE_PROJECT_REF is required.');
  process.exit(1);
}
if (!ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is required. Use a scoped Supabase Management API token with auth_config_read/auth_config_write permissions.');
  process.exit(1);
}

const endpoint = `https://api.supabase.com/v1/projects/${encodeURIComponent(PROJECT_REF)}/config/auth`;
const headers = {
  Authorization: `Bearer ${ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
};

const request = async (method, body) => {
  const response = await fetch(endpoint, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }

  if (!response.ok) {
    const details = typeof data === 'string' ? data : JSON.stringify(data);
    const error = new Error(`Supabase Management API returned HTTP ${response.status}: ${details}`);
    error.status = response.status;
    throw error;
  }
  return data;
};

try {
  const current = await request('GET');
  const enabled = current?.password_hibp_enabled === true;

  if (CHECK_ONLY) {
    console.log(JSON.stringify({
      project_ref: PROJECT_REF,
      password_hibp_enabled: enabled,
    }, null, 2));
    process.exit(enabled ? 0 : 2);
  }

  if (!enabled) {
    await request('PATCH', { password_hibp_enabled: true });
  }

  const verified = await request('GET');
  if (verified?.password_hibp_enabled !== true) {
    throw new Error('Leaked Password Protection was not enabled after the PATCH request.');
  }

  console.log('Supabase Leaked Password Protection is enabled.');
} catch (error) {
  const message = String(error?.message || error);
  if (/plan|billing|upgrade|not available|402|403/i.test(message)) {
    console.error('Unable to enable Leaked Password Protection. Confirm the project is on Supabase Pro or higher and that the token has auth_config_write permission.');
  }
  console.error(message);
  process.exit(1);
}
