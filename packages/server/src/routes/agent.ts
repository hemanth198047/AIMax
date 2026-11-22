import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { SandboxError } from '../sandbox/guard.js';
import { createCheckpoint, gitStatus } from '../sandbox/workspace.js';
import { previewEdits, applyEdits } from '../sandbox/edits.js';
import { sandboxPatch, promoteSandbox, undoPromotion } from '../sandbox/promote.js';
import { AGENTS } from '../agent/claudeAgent.js';
import { budgetCheck, recordUsage, looksRateLimited, setCooldown } from '../providers/usage.js';
import { getSandbox, type SandboxRow } from './sandbox.js';

const busy = new Set<string>();   // one agent per sandbox at a time

/** Editing is allowed in temporary/container workspaces; in direct mode only after the explicit direct approval; never read-only. */
function assertEditable(sb: SandboxRow) {
  if (sb.mode === 'readonly') throw new SandboxError('Sandbox is read-only: editing is disabled', 403);
  if (sb.mode === 'direct' && !sb.approved_at) throw new SandboxError('Direct mode was never approved', 403);
}

export async function agentRoutes(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof SandboxError) return reply.status(err.status).send({ error: err.message });
    reply.send(err);
  });

  // ── AI-proposed edits (any provider): preview, then apply on approval ──
  app.post<{ Params: { id: string }; Body: { edits?: string } }>('/api/sandbox/:id/edits/preview', async (req) => {
    const sb = getSandbox(req.params.id); assertEditable(sb);
    if (typeof req.body?.edits !== 'string' || req.body.edits.length > 500_000) throw new SandboxError('edits (text) is required');
    try { return previewEdits(sb.working_dir, req.body.edits); }
    catch (e) { if (e instanceof SandboxError) return { ok: false, edits: [], error: e.message }; throw e; }
  });

  app.post<{ Params: { id: string }; Body: { edits?: string } }>('/api/sandbox/:id/edits/apply', async (req) => {
    const sb = getSandbox(req.params.id); assertEditable(sb);
    if (typeof req.body?.edits !== 'string' || req.body.edits.length > 500_000) throw new SandboxError('edits (text) is required');
    let checkpoint: string | null = null;
    if (sb.workspace_kind !== 'source') {
      const preview = previewEdits(sb.working_dir, req.body.edits);
      if (preview.ok) checkpoint = createCheckpoint(sb.working_dir, `before edit: ${preview.edits.map(e => e.path).join(', ')}`.slice(0, 100));
    }
    const r = applyEdits(sb.working_dir, req.body.edits);
    getDb().prepare('UPDATE sandboxes SET last_used=? WHERE id=?').run(new Date().toISOString(), sb.id);
    return { applied: true, files: r.files, checkpoint };
  });

  // ── Review & promote ──
  app.get<{ Params: { id: string } }>('/api/sandbox/:id/changes', async (req) => {
    const sb = getSandbox(req.params.id);
    if (sb.workspace_kind === 'source') return { promotable: false, reason: 'This sandbox edits your real project directly', files: [], patch: '' };
    const p = sandboxPatch(sb);
    return { promotable: !!sb.source_path, reason: sb.source_path ? '' : 'Sandbox has no source project (it was created empty)', files: p.files, patch: p.patch.slice(0, 400_000), truncated: p.patch.length > 400_000,
      promotions: getDb().prepare('SELECT id,applied_at,files,undone_at FROM sandbox_promotions WHERE sandbox_id=? ORDER BY applied_at DESC LIMIT 20').all(sb.id) };
  });

  app.post<{ Params: { id: string }; Body: { confirm?: boolean } }>('/api/sandbox/:id/promote', async (req, reply) => {
    const sb = getSandbox(req.params.id);
    if (req.body?.confirm !== true) return reply.status(409).send({ error: 'Applying changes to your real project needs confirm:true', needs_confirmation: true });
    return promoteSandbox(sb);
  });

  app.post<{ Params: { id: string; pid: string } }>('/api/sandbox/:id/promotions/:pid/undo', async (req) => undoPromotion(getSandbox(req.params.id), req.params.pid));

  // ── CLI agent run (SSE) ──
  app.get('/api/agent/adapters', async () => Promise.all(Object.values(AGENTS).map(async a => ({ id: a.id, label: a.label, available: await a.available() }))));

  app.get<{ Params: { id: string } }>('/api/sandbox/:id/agent-runs', async (req) =>
    getDb().prepare('SELECT id,provider,task,status,summary,files,error,started_at,finished_at,checkpoint_before FROM agent_runs WHERE sandbox_id=? ORDER BY started_at DESC LIMIT 20').all(getSandbox(req.params.id).id));

  app.post<{ Body: { sandboxId?: string; task?: string; provider?: string } }>('/api/agent/run', async (req, reply: FastifyReply) => {
    const { sandboxId, task, provider = 'claude' } = req.body ?? {};
    const adapter = AGENTS[provider];
    if (!adapter) throw new SandboxError(`No agent adapter for '${provider}'. Available: ${Object.keys(AGENTS).join(', ')}`, 404);
    if (typeof task !== 'string' || !task.trim() || task.length > 20_000) throw new SandboxError('task is required (max 20000 characters)');
    const sb = getSandbox(String(sandboxId));
    if (sb.mode !== 'temporary' && sb.mode !== 'container') throw new SandboxError(`Agents only work in a temporary or container sandbox copy, never in ${sb.mode} mode (that would edit your real project without a review step)`, 403);
    if (busy.has(sb.id)) throw new SandboxError('An agent is already running in this sandbox', 409);
    if (!(await adapter.available())) throw new SandboxError(`${adapter.label} CLI is not available`, 409);
    const budget = budgetCheck(provider);
    if (!budget.ok) throw new SandboxError(`${budget.reason}. AImax will not call it (zero-overage guard).`, 429);

    busy.add(sb.id);
    reply.hijack();
    const origin = req.headers.origin;
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      ...(origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? { 'Access-Control-Allow-Origin': origin } : {}) });
    const send = (event: string, data: unknown) => { if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

    const db = getDb(); const runId = randomUUID(); const t0 = Date.now(); const ctrl = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) ctrl.abort(); });
    let checkpoint = '';
    try {
      checkpoint = createCheckpoint(sb.working_dir, `before agent: ${task.replace(/\s+/g, ' ').slice(0, 60)}`);
      db.prepare('INSERT INTO agent_runs(id,sandbox_id,provider,task,status,checkpoint_before,started_at) VALUES(?,?,?,?,?,?,?)').run(runId, sb.id, provider, task, 'running', checkpoint, new Date().toISOString());
      send('start', { runId, sandboxId: sb.id, provider, checkpoint });

      const r = await adapter.run({ cwd: sb.working_dir, task, signal: ctrl.signal, onEvent: e => send(e.type === 'text' ? 'chunk' : 'tool', e.type === 'text' ? { text: e.text } : { name: e.name, target: e.target }) });
      const stopped = ctrl.signal.aborted;
      const failed = !!r.error && r.error !== 'aborted';
      const files = gitStatus(sb.working_dir).files.map(f => f.path);
      recordUsage({ provider, model: 'agent', conversationId: undefined, inputChars: task.length, outputChars: r.text.length, durationMs: Date.now() - t0, ok: !failed, error: failed ? r.error : '' });
      if (failed && looksRateLimited(r.error!)) { setCooldown(provider, 60, r.error!); send('activity', { detail: `${provider} reported a limit — paused for 60 min` }); }
      db.prepare('UPDATE agent_runs SET status=?,summary=?,files=?,error=?,finished_at=? WHERE id=?')
        .run(failed ? 'error' : stopped ? 'cancelled' : 'done', r.text.slice(0, 20_000), JSON.stringify(files), failed ? r.error : '', new Date().toISOString(), runId);
      db.prepare('UPDATE sandboxes SET last_used=? WHERE id=?').run(new Date().toISOString(), sb.id);
      if (failed) send('error', { message: r.error });
      send('done', { runId, stopped, error: failed ? r.error : null, files, tools: r.tools, summary: r.text, checkpoint, durationMs: Date.now() - t0 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      db.prepare("UPDATE agent_runs SET status='error',error=?,finished_at=? WHERE id=?").run(msg, new Date().toISOString(), runId);
      send('error', { message: msg }); send('done', { runId, stopped: false, error: msg, files: [], tools: 0, summary: '', checkpoint, durationMs: Date.now() - t0 });
    } finally {
      busy.delete(sb.id); reply.raw.end();
    }
  });
}
