import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { checkClaudeAvailable, claudeVersion } from '../providers/claude.js';
import { testProviderEnabled } from '../providers/test.js';
import { cursorAvailable } from '../providers/cursor.js';
import { checkOllamaAvailable, listOllamaModels } from '../providers/ollama.js';
import { getDb } from '../db/index.js';
import { buildReport } from '../providers/report.js';
import { activeCooldown, clearCooldown, getLimits, getSetting, sanitizeLimits, setSetting, usageCounts } from '../providers/usage.js';

/** Is an executable with this name on PATH? Detection only — it says nothing about whether AImax can drive it. */
function onPath(name: string): boolean {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean).some(d => exts.some(e => existsSync(join(d, name + e))));
}

const KNOWN = ['claude', 'ollama', 'cursor', 'codex', 'freellmapi'];

export async function providersRoutes(app: FastifyInstance) {
  app.get('/api/providers/status', async () => {
    const [claudeOk, ollamaOk] = await Promise.all([checkClaudeAvailable(), checkOllamaAvailable()]);
    const ollamaModels = ollamaOk ? await listOllamaModels() : [];
    const chosen = getSetting<string>('ollama_model', '');
    return {
      claude: { available: claudeOk, interface: 'claude-code-cli', version: claudeOk ? await claudeVersion() : '', paused: activeCooldown('claude') },
      ollama: { available: ollamaOk, interface: 'http-api', models: ollamaModels.map(m => m.name), selected: ollamaModels.some(m => m.name === chosen) ? chosen : (ollamaModels[0]?.name ?? ''), paused: activeCooldown('ollama') },
      // No adapter exists for these: they are never "available", whatever is installed.
      cursor: { available: cursorAvailable(), detected: cursorAvailable(), interface: 'cursor-cli', note: 'Experimental: built from Cursor docs, not yet verified against your CLI. Used only when you select it.' },
      codex: { available: false, detected: onPath('codex'), interface: 'codex-cli', note: 'No AImax adapter yet' },
      freellmapi: { available: false, interface: 'electron-app', note: 'No AImax adapter yet' },
      ...(testProviderEnabled() ? { test: { available: true, interface: 'deterministic (tests only)' } } : {}),
    };
  });

  app.get('/api/settings/providers', async () => ({ limits: getLimits(), ollama_model: getSetting<string>('ollama_model', '') }));

  app.put<{ Body: { limits?: unknown; ollama_model?: unknown } }>('/api/settings/providers', async (req, reply) => {
    const b = req.body ?? {};
    try {
      if (b.limits !== undefined) setSetting('provider_limits', sanitizeLimits(b.limits));
    } catch (e) { return reply.status(400).send({ error: e instanceof Error ? e.message : String(e) }); }
    if (b.ollama_model !== undefined) {
      if (typeof b.ollama_model !== 'string' || b.ollama_model.length > 200) return reply.status(400).send({ error: 'ollama_model must be a string' });
      setSetting('ollama_model', b.ollama_model);
    }
    return { limits: getLimits(), ollama_model: getSetting<string>('ollama_model', '') };
  });

  /** What AImax itself has sent to each provider (no message content). */
  app.get('/api/usage', async () => {
    const limits = getLimits();
    const providers = KNOWN.map(p => ({ provider: p, ...usageCounts(p), limit: limits[p] ?? null, paused: activeCooldown(p) }));
    const recent = getDb().prepare('SELECT ts,provider,model,input_chars,output_chars,duration_ms,ok,error FROM usage_events ORDER BY ts DESC LIMIT 20').all();
    return { providers, recent, note: 'Counts only requests sent through AImax. Your real plan quota is not visible here.' };
  });

  /** Token report with budgets and suggestions. Conversation titles are shown only for the caller's project/person context. */
  app.get('/api/usage/report', async (req) => {
    const q = req.query as Record<string, string>;
    return buildReport({ days: Number(q.days) || 30, ctx: { projectId: q.project_id, personId: q.person_id }, ollamaAvailable: await checkOllamaAvailable() });
  });

  app.post<{ Params: { provider: string } }>('/api/usage/:provider/resume', async (req, reply) => {
    if (!KNOWN.includes(req.params.provider)) return reply.status(404).send({ error: 'Unknown provider' });
    clearCooldown(req.params.provider); return { resumed: true };
  });
}
