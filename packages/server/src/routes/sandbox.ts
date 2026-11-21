import type { FastifyInstance, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync, statSync } from 'node:fs';
import { getDb } from '../db/index.js';
import { SandboxError, resolveInside, isDestructive } from '../sandbox/guard.js';
import { startRun, cancelRun, dockerUsable, type RunResult } from '../sandbox/runner.js';
import {
  createWorkspace, destroyWorkspace, listFiles, gitStatus, gitDiff, createCheckpoint, listCheckpoints, restoreCheckpoint,
  type SandboxMode, type WorkspaceKind,
} from '../sandbox/workspace.js';

interface SandboxRow {
  id: string; name: string; project_id: string | null; mode: SandboxMode; working_dir: string; status: string;
  source_path: string; workspace_kind: WorkspaceKind; approved_at: string | null; container_image: string;
}
const MODES: SandboxMode[] = ['readonly', 'temporary', 'container', 'direct'];

function getSandbox(id: string): SandboxRow {
  const sb = getDb().prepare('SELECT * FROM sandboxes WHERE id=?').get(id) as SandboxRow | undefined;
  if (!sb) throw new SandboxError('Sandbox not found', 404);
  return sb;
}

/** Common pre-flight for anything that executes a command. */
function prepareExecution(sb: SandboxRow, command: unknown, confirm: unknown) {
  if (typeof command !== 'string' || !command.trim()) throw new SandboxError('command is required');
  if (command.length > 20_000) throw new SandboxError('command too long');
  if (sb.mode === 'readonly') throw new SandboxError('Sandbox is read-only: command execution is disabled', 403);
  if (sb.mode === 'direct') {
    if (!sb.approved_at) throw new SandboxError('Direct mode was never approved', 403);
    if (isDestructive(command) && confirm !== true) {
      throw Object.assign(new SandboxError('Destructive command in direct mode requires confirm:true', 409), { needsConfirmation: true });
    }
  }
}

function recordRun(sb: SandboxRow, command: string, runId: string) {
  const db = getDb();
  db.prepare('INSERT INTO sandbox_runs(id,sandbox_id,command,status,started_at) VALUES(?,?,?,?,?)').run(runId, sb.id, command, 'running', new Date().toISOString());
  db.prepare('UPDATE sandboxes SET last_used=? WHERE id=?').run(new Date().toISOString(), sb.id);
}
function finishRun(r: RunResult) {
  getDb().prepare('UPDATE sandbox_runs SET exit_code=?,status=?,truncated=?,duration_ms=? WHERE id=?')
    .run(r.exitCode, r.status, r.truncated ? 1 : 0, r.durationMs, r.runId);
}
const runOpts = (sb: SandboxRow) => sb.mode === 'container' ? { container: { image: sb.container_image } } : {};

export async function sandboxRoutes(app: FastifyInstance) {
  // A server restart orphans in-flight runs; do not leave them marked "running".
  getDb().prepare("UPDATE sandbox_runs SET status='error' WHERE status='running'").run();

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof SandboxError) {
      return reply.status(err.status).send({ error: err.message, ...((err as { needsConfirmation?: boolean }).needsConfirmation ? { needs_confirmation: true } : {}) });
    }
    reply.send(err);
  });

  // Honest report of what isolation is actually available.
  app.get('/api/sandbox/capabilities', async () => {
    const docker = dockerUsable();
    return {
      modes: {
        readonly:  { available: true, enforcement: 'API refuses command execution; files can be browsed and read (path-guarded)' },
        temporary: { available: true, enforcement: 'git worktree/copy as cwd, scrubbed environment, timeout + process-tree kill, output cap. NOT a security boundary: a command can still reach files the OS user can reach.' },
        container: { available: docker.available, detail: docker.detail, enforcement: 'docker run --network none, memory/cpu/pids limits, caps dropped, non-root, only the workspace mounted' },
        direct:    { available: true, enforcement: 'runs in the real project; requires explicit approval at creation; destructive commands need confirm:true' },
      },
      limits: { timeout_ms_default: 30_000, timeout_ms_max: 600_000, max_output_bytes: 1_000_000 },
      platform: process.platform,
    };
  });

  app.get('/api/sandbox', async () => getDb().prepare('SELECT * FROM sandboxes ORDER BY last_used DESC').all());
  app.get<{ Params: { id: string } }>('/api/sandbox/:id', async (req) => getSandbox(req.params.id));

  app.post<{ Body: { name?: string; project_id?: string; mode?: string; source_path?: string; approve_direct?: boolean; image?: string } }>('/api/sandbox', async (req) => {
    const db = getDb();
    const { name = 'Sandbox', project_id = null, mode = 'temporary', approve_direct = false, image = 'node:22-slim' } = req.body ?? {};
    if (!MODES.includes(mode as SandboxMode)) throw new SandboxError(`mode must be one of ${MODES.join(', ')}`);
    let source = req.body?.source_path ?? '';
    if (!source && project_id) {
      source = (db.prepare('SELECT repo_path FROM projects WHERE id=?').get(project_id) as { repo_path?: string } | undefined)?.repo_path ?? '';
    }
    if ((mode === 'readonly' || mode === 'direct') && !source) throw new SandboxError(`${mode} mode needs a source_path or a project with repo_path`);
    if (mode === 'direct' && approve_direct !== true) throw new SandboxError('Direct mode modifies your real project and needs approve_direct:true', 403);
    if (mode === 'container') {
      const d = dockerUsable();
      if (!d.available) throw new SandboxError(`Container mode unavailable: ${d.detail}`, 409);
      if (!/^[a-z0-9][a-z0-9._/:@-]{0,200}$/i.test(image)) throw new SandboxError('Invalid image name');
    }
    const id = uuidv4();
    const ws = createWorkspace(id, mode as SandboxMode, source);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO sandboxes(id,name,project_id,mode,working_dir,status,created_at,last_used,source_path,workspace_kind,approved_at,container_image)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, name, project_id, mode, ws.dir, 'ready', now, now, ws.sourcePath, ws.kind, mode === 'direct' ? now : null, mode === 'container' ? image : '');
    return getSandbox(id);
  });

  // Blocking execution (kept for simple clients / tests).
  app.post<{ Params: { id: string }; Body: { command: string; timeout?: number; confirm?: boolean } }>('/api/sandbox/:id/execute', async (req) => {
    const sb = getSandbox(req.params.id);
    prepareExecution(sb, req.body?.command, req.body?.confirm);
    const timeoutMs = Math.min(Math.max(Number(req.body.timeout) || 30_000, 1000), 600_000);
    const h = startRun({ command: req.body.command, cwd: sb.working_dir, timeoutMs, ...runOpts(sb) });
    recordRun(sb, req.body.command, h.runId);
    const r = await h.result;
    finishRun(r);
    return { ...r, timedOut: r.status === 'timeout', workingDir: sb.working_dir };
  });

  // Streaming execution over SSE; client disconnect cancels the run.
  app.post<{ Params: { id: string }; Body: { command: string; timeout?: number; confirm?: boolean } }>('/api/sandbox/:id/run', async (req, reply: FastifyReply) => {
    const sb = getSandbox(req.params.id);
    prepareExecution(sb, req.body?.command, req.body?.confirm);
    const timeoutMs = Math.min(Math.max(Number(req.body.timeout) || 30_000, 1000), 600_000);

    reply.hijack();
    const origin = req.headers.origin;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      ...(origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    });
    const send = (event: string, data: unknown) => { if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

    const h = startRun({ command: req.body.command, cwd: sb.working_dir, timeoutMs, ...runOpts(sb),
      onData: (text, stream) => send('chunk', { text, stream }) });
    recordRun(sb, req.body.command, h.runId);
    send('start', { runId: h.runId, sandboxId: sb.id });
    // Cancel only when the *client connection* drops (req 'close' fires as soon as the body is read).
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) h.cancel(); });

    const r = await h.result;
    finishRun(r);
    send('done', { runId: r.runId, exitCode: r.exitCode, status: r.status, truncated: r.truncated, durationMs: r.durationMs });
    reply.raw.end();
  });

  app.post<{ Params: { runId: string } }>('/api/sandbox/runs/:runId/cancel', async (req) => ({ cancelled: cancelRun(req.params.runId) }));

  app.get<{ Params: { id: string } }>('/api/sandbox/:id/runs', async (req) => {
    getSandbox(req.params.id);
    return getDb().prepare('SELECT * FROM sandbox_runs WHERE sandbox_id=? ORDER BY started_at DESC LIMIT 50').all(req.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { depth?: string } }>('/api/sandbox/:id/files', async (req) => {
    const sb = getSandbox(req.params.id);
    return listFiles(sb.working_dir, '', Math.min(Number(req.query.depth) || 2, 5));
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/sandbox/:id/file', async (req) => {
    const sb = getSandbox(req.params.id);
    const full = resolveInside(sb.working_dir, req.query.path ?? '');
    const st = statSync(full);
    if (!st.isFile()) throw new SandboxError('Not a file');
    if (st.size > 512 * 1024) return { path: req.query.path, size: st.size, tooLarge: true };
    const buf = readFileSync(full);
    if (buf.includes(0)) return { path: req.query.path, size: st.size, binary: true };
    return { path: req.query.path, size: st.size, content: buf.toString('utf8') };
  });

  app.get<{ Params: { id: string } }>('/api/sandbox/:id/git', async (req) => {
    const sb = getSandbox(req.params.id);
    return { status: gitStatus(sb.working_dir), ...gitDiff(sb.working_dir) };
  });

  app.get<{ Params: { id: string } }>('/api/sandbox/:id/checkpoints', async (req) => listCheckpoints(getSandbox(req.params.id).working_dir));

  // Checkpoints commit inside the sandbox workspace only; never onto the user's own branch.
  app.post<{ Params: { id: string }; Body: { label?: string } }>('/api/sandbox/:id/checkpoints', async (req) => {
    const sb = getSandbox(req.params.id);
    if (sb.workspace_kind === 'source') throw new SandboxError('Checkpoints are unavailable in readonly/direct mode (they would commit to your real repository)', 409);
    return { sha: createCheckpoint(sb.working_dir, req.body?.label || 'manual') };
  });

  app.post<{ Params: { id: string }; Body: { sha: string; confirm?: boolean } }>('/api/sandbox/:id/restore', async (req) => {
    const sb = getSandbox(req.params.id);
    if (sb.workspace_kind === 'source') throw new SandboxError('Restore is unavailable in readonly/direct mode', 409);
    if (req.body?.confirm !== true) throw Object.assign(new SandboxError('Restore discards uncommitted changes; send confirm:true', 409), { needsConfirmation: true });
    restoreCheckpoint(sb.working_dir, req.body.sha);
    return { restored: true };
  });

  app.delete<{ Params: { id: string } }>('/api/sandbox/:id', async (req) => {
    const sb = getSandbox(req.params.id);
    for (const r of getDb().prepare("SELECT id FROM sandbox_runs WHERE sandbox_id=? AND status='running'").all(sb.id) as { id: string }[]) cancelRun(r.id);
    destroyWorkspace(sb.working_dir, sb.workspace_kind, sb.source_path);
    getDb().prepare('DELETE FROM sandboxes WHERE id=?').run(sb.id);
    return { deleted: true };
  });
}
