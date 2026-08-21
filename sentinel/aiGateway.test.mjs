import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const monitor = fs.readFileSync(path.join(process.cwd(), 'sentinel', 'monitor.mjs'), 'utf8');
const workflows = [
  '.github/workflows/lestra-sentinel-monitor.yml',
  '.github/workflows/lestra-sentinel-weekly.yml',
  '.github/workflows/lestra-sentinel-command.yml',
].map((file) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')).join('\n');

test('Sentinel usa exclusivamente Vercel AI Gateway para IA automática', () => {
  assert.match(monitor, /https:\/\/ai-gateway\.vercel\.sh\/v1\/responses/);
  assert.doesNotMatch(monitor, /api\.openai\.com/);
  assert.doesNotMatch(workflows, /LESTRA_SENTINEL_OPENAI_API_KEY/);
});

test('Sentinel mantiene fallback local ante presupuesto agotado', () => {
  assert.match(monitor, /response\.status === 402/);
  assert.match(monitor, /free_budget_exhausted/);
  assert.match(monitor, /return null/);
});

test('modelo por defecto es ligero y configurable', () => {
  assert.match(monitor, /LESTRA_SENTINEL_AI_MODEL/);
  assert.match(monitor, /google\/gemini-3\.5-flash-lite/);
});
