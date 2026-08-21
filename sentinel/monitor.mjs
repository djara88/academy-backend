import { readFile, appendFile } from 'node:fs/promises';

const STATUS_ISSUE = Number(process.env.SENTINEL_STATUS_ISSUE || 81);
const MEMORY_ISSUE = Number(process.env.SENTINEL_MEMORY_ISSUE || 82);
const FRONTEND_URL = process.env.LESTRA_FRONTEND_URL || 'https://www.lestra.app';
const DEPORTIVO_URL = process.env.LESTRA_DEPORTIVO_URL || 'https://deportivo.lestra.app';
const BACKEND_HEALTH_URL = process.env.LESTRA_BACKEND_HEALTH_URL || 'https://academy-backend-kqsv.onrender.com/health';
const FRONTEND_REPO = process.env.LESTRA_FRONTEND_REPO || 'djara88/academy-frontend';
const MODE = process.env.SENTINEL_MODE || 'monitor';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const CROSS_REPO_TOKEN = process.env.LESTRA_GITHUB_READ_TOKEN || GITHUB_TOKEN;
const OPENAI_API_KEY = process.env.LESTRA_SENTINEL_OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.LESTRA_SENTINEL_OPENAI_MODEL || 'gpt-5-mini';

const currentRepo = process.env.GITHUB_REPOSITORY || 'djara88/academy-backend';
const githubApi = 'https://api.github.com';

const icon = {
  healthy: '🟢',
  warning: '🟠',
  critical: '🔴',
  unknown: '⚪',
  ok: '🟢',
  failed: '🔴',
  skipped: '⚪',
};

function nowChile() {
  return new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    dateStyle: 'medium',
    timeStyle: 'long',
  }).format(new Date());
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkHttp(name, url, timeoutMs = 20_000) {
  const started = Date.now();
  try {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'lestra-sentinel/1.0' },
    }, timeoutMs);
    return {
      name,
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - started,
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      status: 0,
      durationMs: Date.now() - started,
      observedAt: new Date().toISOString(),
      error: error?.name === 'AbortError' ? 'timeout' : 'network_error',
    };
  }
}

async function gh(path, { method = 'GET', body, token = GITHUB_TOKEN } = {}) {
  if (!token) throw new Error('GitHub token no disponible');
  const response = await fetchWithTimeout(`${githubApi}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'lestra-sentinel/1.0',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, 20_000);

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(`GitHub API ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function latestWorkflow(repo, workflowName, token) {
  try {
    const encoded = encodeURIComponent(repo);
    const data = await gh(`/repos/${encoded}/actions/runs?branch=main&per_page=30`, { token });
    const run = (data?.workflow_runs || []).find((item) => item.name === workflowName && item.status === 'completed');
    if (!run) return { available: true, state: 'unknown', conclusion: null };
    return {
      available: true,
      state: run.conclusion === 'success' ? 'ok' : 'failed',
      conclusion: run.conclusion,
      updatedAt: run.updated_at,
      htmlUrl: run.html_url,
    };
  } catch (error) {
    if ([403, 404].includes(error?.status)) return { available: false, state: 'unknown', conclusion: null };
    return { available: false, state: 'unknown', conclusion: null };
  }
}

export function assessSnapshot(snapshot) {
  const findings = [];
  const recommendations = [];
  let overall = 'healthy';

  const critical = (message, recommendation) => {
    findings.push({ severity: 'critical', message });
    recommendations.push(recommendation);
    overall = 'critical';
  };

  const warning = (message, recommendation) => {
    findings.push({ severity: 'warning', message });
    recommendations.push(recommendation);
    if (overall !== 'critical') overall = 'warning';
  };

  if (!snapshot.backend?.ok) {
    critical(
      `Backend no respondió correctamente (${snapshot.backend?.status || snapshot.backend?.error || 'sin respuesta'}).`,
      'Revisar último deploy y logs de Render; no cambiar configuración hasta confirmar causa.'
    );
  }

  if (!snapshot.frontend?.ok) {
    critical(
      `Frontend principal no respondió correctamente (${snapshot.frontend?.status || snapshot.frontend?.error || 'sin respuesta'}).`,
      'Revisar deployment de producción en Vercel y errores runtime; mantener rollback como primera opción.'
    );
  }

  if (!snapshot.deportivo?.ok) {
    warning(
      `Sitio deportivo no respondió correctamente (${snapshot.deportivo?.status || snapshot.deportivo?.error || 'sin respuesta'}).`,
      'Revisar alias/deployment de deportivo.lestra.app sin tocar el frontend principal.'
    );
  }

  for (const [label, ci] of Object.entries(snapshot.ci || {})) {
    if (ci?.available && ci.state === 'failed') {
      warning(
        `CI ${label} terminó con ${ci.conclusion || 'fallo'}.`,
        `Revisar el workflow ${label}; no fusionar cambios dependientes hasta dejar CI verde.`
      );
    }
  }

  if (findings.length === 0) {
    findings.push({ severity: 'healthy', message: 'No se detectaron fallos en los controles disponibles.' });
    recommendations.push('Sin intervención requerida. Mantener observación y revisar tendencias en el informe semanal.');
  }

  return { overall, findings, recommendations };
}

export function parseState(body = '') {
  const match = String(body).match(/<!-- sentinel-state:(.*?) -->/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function stateVector(snapshot, assessment) {
  return {
    version: 1,
    overall: assessment.overall,
    backend: snapshot.backend?.ok ? 'ok' : 'failed',
    frontend: snapshot.frontend?.ok ? 'ok' : 'failed',
    deportivo: snapshot.deportivo?.ok ? 'ok' : 'failed',
    backendCi: snapshot.ci?.backend?.state || 'unknown',
    frontendCi: snapshot.ci?.frontend?.state || 'unknown',
    observedAt: snapshot.observedAt,
  };
}

export function detectTransitions(previous, current) {
  if (!previous || previous.status === 'initializing') return [{ key: 'baseline', from: 'initializing', to: current.overall }];
  const keys = ['overall', 'backend', 'frontend', 'deportivo', 'backendCi', 'frontendCi'];
  return keys
    .filter((key) => previous[key] !== undefined && previous[key] !== current[key])
    .map((key) => ({ key, from: previous[key], to: current[key] }));
}

export function formatStateMarker(state) {
  return `<!-- sentinel-state:${JSON.stringify(state)} -->`;
}

async function readInstructions() {
  try {
    return await readFile(new URL('./instructions.md', import.meta.url), 'utf8');
  } catch {
    return 'Eres Lestra Sentinel. Solo observa, explica y recomienda. No ejecutes cambios en producción.';
  }
}

function extractResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

async function recentMemoryComments(limit = 12) {
  try {
    const data = await gh(`/repos/${currentRepo}/issues/${MEMORY_ISSUE}/comments?per_page=${Math.min(limit, 50)}`);
    return (data || []).slice(-limit).map((item) => ({
      createdAt: item.created_at,
      body: String(item.body || '').slice(0, 1200),
    }));
  } catch {
    return [];
  }
}

async function aiRecommendation(snapshot, assessment, transitions) {
  if (!OPENAI_API_KEY) return null;
  const instructions = await readInstructions();
  const memory = await recentMemoryComments();
  const safePayload = {
    snapshot,
    assessment,
    transitions,
    recentOperationalMemory: memory,
  };

  try {
    const response = await fetchWithTimeout('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        instructions,
        input: `Analiza este snapshot técnico sin PII ni secretos. Devuelve Markdown breve con: severidad, evidencia, diagnóstico probable, recomendación, riesgo y verificación. No propongas ejecutar cambios automáticamente.\n\n${JSON.stringify(safePayload)}`,
        max_output_tokens: 900,
      }),
    }, 45_000);

    if (!response.ok) return null;
    return extractResponseText(await response.json()) || null;
  } catch {
    return null;
  }
}

function checkRow(label, check) {
  if (!check) return `| ${label} | ⚪ | No disponible | — |`;
  const state = check.ok ? 'healthy' : 'critical';
  const detail = check.ok ? `HTTP ${check.status}` : (check.error || `HTTP ${check.status || 0}`);
  return `| ${label} | ${icon[state]} | ${detail} | ${check.durationMs ?? '—'} ms |`;
}

function ciRow(label, ci) {
  if (!ci?.available) return `| ${label} | ⚪ | Sin token/permiso para consultar |`;
  const state = ci.state === 'ok' ? 'ok' : ci.state === 'failed' ? 'failed' : 'unknown';
  return `| ${label} | ${icon[state]} | ${ci.conclusion || 'sin ejecución completada'} |`;
}

function statusBody(snapshot, assessment, aiText, state) {
  const aiMode = OPENAI_API_KEY ? (aiText ? 'IA activa' : 'IA disponible; fallback determinístico en esta ejecución') : 'Reglas seguras; IA aún no conectada';
  return `# Lestra Sentinel — Estado operativo\n\n` +
    `> **Modo:** Observer / solo lectura sobre producción. Sentinel solo escribe en estos issues de control.\n\n` +
    `**Última revisión:** ${nowChile()}  \n` +
    `**Estado global:** ${icon[assessment.overall]} **${assessment.overall.toUpperCase()}**  \n` +
    `**Motor de análisis:** ${aiMode}\n\n` +
    `## Disponibilidad\n\n` +
    `| Componente | Estado | Respuesta | Latencia |\n|---|---|---|---|\n` +
    `${checkRow('Backend Render', snapshot.backend)}\n` +
    `${checkRow('www.lestra.app', snapshot.frontend)}\n` +
    `${checkRow('deportivo.lestra.app', snapshot.deportivo)}\n\n` +
    `## CI\n\n| Flujo | Estado | Resultado |\n|---|---|---|\n` +
    `${ciRow('Backend CI', snapshot.ci?.backend)}\n` +
    `${ciRow('Frontend CI', snapshot.ci?.frontend)}\n\n` +
    `## Hallazgos\n\n${assessment.findings.map((item) => `- ${icon[item.severity] || '•'} ${item.message}`).join('\n')}\n\n` +
    `## Recomendaciones\n\n${assessment.recommendations.map((item) => `- ${item}`).join('\n')}\n\n` +
    (aiText ? `## Análisis de IA\n\n${aiText}\n\n` : '') +
    `## Límites actuales\n\n` +
    `- No usa \`SUPABASE_SERVICE_ROLE_KEY\`.\n` +
    `- Métricas profundas de Vercel/Render y lectura cruzada del frontend se activan solo con tokens dedicados de solo lectura.\n` +
    `- No modifica base de datos, variables, deploys, roles, pagos ni ramas.\n\n` +
    `${formatStateMarker(state)}`;
}

async function postComment(issue, body) {
  return gh(`/repos/${currentRepo}/issues/${issue}/comments`, { method: 'POST', body: { body } });
}

async function updateStatusIssue(body) {
  return gh(`/repos/${currentRepo}/issues/${STATUS_ISSUE}`, { method: 'PATCH', body: { body } });
}

async function recordTransitions(transitions, snapshot, assessment) {
  if (!transitions.length) return;
  const lines = transitions.map((item) => `- \`${item.key}\`: **${item.from} → ${item.to}**`).join('\n');
  const message = `## Evento Sentinel — ${nowChile()}\n\n${lines}\n\nEstado global: **${assessment.overall.toUpperCase()}**.\n\nNo se ejecutaron cambios en producción.`;
  await postComment(MEMORY_ISSUE, message);

  if (transitions.some((item) => item.key === 'overall' && item.to === 'critical')) {
    await postComment(STATUS_ISSUE, `🚨 **Sentinel detectó una transición a CRITICAL** (${nowChile()}). Revisa el estado actualizado arriba. No se ejecutó ninguna acción automática.`);
  }
  if (transitions.some((item) => item.key === 'overall' && item.from === 'critical' && item.to !== 'critical')) {
    await postComment(STATUS_ISSUE, `✅ **Sentinel detectó recuperación** (${nowChile()}). Estado actual: **${assessment.overall.toUpperCase()}**.`);
  }
}

async function weeklyComment(snapshot, assessment, aiText) {
  const comments = await recentMemoryComments(50);
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekEvents = comments.filter((item) => Date.parse(item.createdAt || '') >= since);
  const body = `# Informe semanal Lestra Sentinel — ${nowChile()}\n\n` +
    `- Estado actual: ${icon[assessment.overall]} **${assessment.overall.toUpperCase()}**\n` +
    `- Eventos registrados en memoria (7 días): **${weekEvents.length}**\n` +
    `- Backend: **${snapshot.backend?.ok ? 'OK' : 'FALLA'}**\n` +
    `- Frontend principal: **${snapshot.frontend?.ok ? 'OK' : 'FALLA'}**\n` +
    `- Deportivo: **${snapshot.deportivo?.ok ? 'OK' : 'FALLA'}**\n\n` +
    `## Recomendaciones\n${assessment.recommendations.map((item) => `- ${item}`).join('\n')}\n\n` +
    (aiText ? `## Análisis de IA\n${aiText}\n\n` : '') +
    `> Informe generado en modo observador. Sin cambios automáticos en producción.`;
  await postComment(STATUS_ISSUE, body);
}

async function writeStepSummary(snapshot, assessment) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  await appendFile(path, `# Lestra Sentinel\n\nEstado: ${icon[assessment.overall]} **${assessment.overall.toUpperCase()}**\n\nBackend: ${snapshot.backend?.ok ? 'OK' : 'FAIL'} · Frontend: ${snapshot.frontend?.ok ? 'OK' : 'FAIL'} · Deportivo: ${snapshot.deportivo?.ok ? 'OK' : 'FAIL'}\n`);
}

export async function run() {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN es obligatorio para actualizar el estado de Sentinel.');

  const [backend, frontend, deportivo, backendCi, frontendCi] = await Promise.all([
    checkHttp('backend', BACKEND_HEALTH_URL, 60_000),
    checkHttp('frontend', FRONTEND_URL, 20_000),
    checkHttp('deportivo', DEPORTIVO_URL, 20_000),
    latestWorkflow(currentRepo, 'Backend CI', GITHUB_TOKEN),
    latestWorkflow(FRONTEND_REPO, 'Frontend CI', CROSS_REPO_TOKEN),
  ]);

  const snapshot = {
    observedAt: new Date().toISOString(),
    backend,
    frontend,
    deportivo,
    ci: { backend: backendCi, frontend: frontendCi },
  };
  const assessment = assessSnapshot(snapshot);

  let existingBody = '';
  try {
    const issue = await gh(`/repos/${currentRepo}/issues/${STATUS_ISSUE}`);
    existingBody = issue?.body || '';
  } catch {
    existingBody = '';
  }

  const previousState = parseState(existingBody);
  const currentState = stateVector(snapshot, assessment);
  const transitions = detectTransitions(previousState, currentState);
  const shouldUseAi = Boolean(OPENAI_API_KEY) && (MODE === 'weekly' || transitions.length > 0 || assessment.overall !== 'healthy');
  const aiText = shouldUseAi ? await aiRecommendation(snapshot, assessment, transitions) : null;

  await updateStatusIssue(statusBody(snapshot, assessment, aiText, currentState));
  await recordTransitions(transitions, snapshot, assessment);
  if (MODE === 'weekly') await weeklyComment(snapshot, assessment, aiText);
  await writeStepSummary(snapshot, assessment);

  console.log(JSON.stringify({
    event: 'sentinel_complete',
    mode: MODE,
    overall: assessment.overall,
    transitions: transitions.length,
    aiUsed: Boolean(aiText),
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(JSON.stringify({ event: 'sentinel_failed', error: error?.message || 'unknown_error' }));
    process.exitCode = 1;
  });
}
