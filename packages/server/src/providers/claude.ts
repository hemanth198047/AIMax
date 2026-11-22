import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../db/index.js';
import { killTree } from '../sandbox/runner.js';

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
/** Token numbers the CLI itself reported in its final `result` event (shape taken from memory — UNVERIFIED against a real CLI). */
export interface ReportedUsage { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd?: number }
export interface ClaudeResult { text: string; sessionId: string | null; resumed: boolean; usage?: ReportedUsage }

const IS_WIN = process.platform === 'win32';
/** The chat assistant must never touch the host: every Claude Code tool is denied. */
export const DENIED_TOOLS = 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,Read,Glob,Grep,TodoWrite,Agent';

export function resolveClaudeBin(): { file: string; shell: boolean } {
  const override = process.env.AIMAX_CLAUDE_BIN;
  if (override) return { file: override, shell: /\.(cmd|bat)$/i.test(override) };
  if (IS_WIN) {
    const r = spawnSync('where', ['claude'], { encoding: 'utf8', windowsHide: true });
    const found = (r.stdout ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const exe = found.find(f => /\.exe$/i.test(f)); if (exe) return { file: exe, shell: false };
    const cmd = found.find(f => /\.(cmd|bat)$/i.test(f)); if (cmd) return { file: cmd, shell: true };
  }
  return { file: 'claude', shell: false };
}

export function buildClaudeArgs(opts: { systemFile: string; sessionId?: string | null }): string[] {
  const q = (p: string) => (IS_WIN && /\s/.test(p) ? `"${p}"` : p);   // only matters when a .cmd shim needs a shell
  return ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--append-system-prompt-file', q(opts.systemFile), '--disallowedTools', DENIED_TOOLS,
    ...(opts.sessionId ? ['--resume', opts.sessionId] : [])];
}

function formatHistory(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1];
  const history = messages.slice(0, -1);
  if (!history.length) return last.content;
  return `Previous conversation:\n${history.map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`).join('\n\n')}\n\nHuman: ${last.content}`;
}

interface RunOutcome { text: string; sessionId: string | null; error?: string; usage?: ReportedUsage }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
export function parseReportedUsage(ev: any): ReportedUsage | undefined {
  const u = ev?.usage; const cost = typeof ev?.total_cost_usd === 'number' && ev.total_cost_usd >= 0 ? ev.total_cost_usd : undefined;
  if (!u || typeof u !== 'object') return cost === undefined ? undefined : { costUsd: cost };
  const r: ReportedUsage = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheReadTokens: num(u.cache_read_input_tokens), costUsd: cost };
  return r.inputTokens === undefined && r.outputTokens === undefined && cost === undefined ? undefined : r;
}

function runOnce(prompt: string, system: string, sessionId: string | null, onChunk: (t: string) => void, signal?: AbortSignal, timeoutMs = 300_000): Promise<RunOutcome> {
  const runDir = join(DATA_DIR, 'claude-run'); const cwd = join(runDir, 'cwd');
  mkdirSync(cwd, { recursive: true });                       // empty working dir: nothing of the host to read
  const systemFile = join(runDir, `${randomUUID()}.system.txt`);
  writeFileSync(systemFile, system, 'utf8');
  const { file, shell } = resolveClaudeBin();

  return new Promise((resolve) => {
    let proc: ChildProcess;
    let settled = false; let buf = ''; let stderr = '';
    let text = ''; let sawDelta = false; let session: string | null = sessionId; let final: string | null = null; let error: string | undefined; let usage: ReportedUsage | undefined;
    const finish = () => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      killTree(proc?.pid); rmSync(systemFile, { force: true });
      resolve({ text: final ?? text, sessionId: session, error, usage });
    };
    const onAbort = () => { error = 'aborted'; killTree(proc?.pid); };
    const timer = setTimeout(() => { error = 'Claude CLI timed out'; killTree(proc?.pid); }, timeoutMs);
    try {
      proc = spawn(file, buildClaudeArgs({ systemFile, sessionId }), { cwd, shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !IS_WIN,
        env: { ...process.env, TERM: 'dumb' } });
    } catch (e) { error = `Failed to spawn claude: ${e instanceof Error ? e.message : e}`; return finish(); }
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort);

    const handle = (line: string) => {
      let ev: any; try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id && typeof ev.session_id === 'string') session = ev.session_id;
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
        sawDelta = true; text += ev.event.delta.text; onChunk(ev.event.delta.text);
      } else if (ev.type === 'assistant' && !sawDelta) {
        for (const c of ev.message?.content ?? []) if (c.type === 'text' && c.text) { text += c.text; onChunk(c.text); }
      } else if (ev.type === 'result') {
        usage = parseReportedUsage(ev);
        if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) error = String(ev.result ?? ev.subtype ?? 'Claude returned an error');
        else if (typeof ev.result === 'string') final = ev.result;
      }
    };
    proc.stdout!.on('data', (d: Buffer) => { buf += d.toString(); let i: number; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) handle(l); } });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', (e) => { error = `Failed to spawn claude: ${e.message}`; finish(); });
    proc.on('close', (code) => {
      if (buf.trim()) handle(buf.trim());
      if (!error && code !== 0 && !text && final === null) error = `Claude CLI error (code ${code}): ${stderr.slice(0, 300)}`;
      finish();
    });
    proc.stdin!.on('error', () => { /* process exited early */ });
    proc.stdin!.end(prompt);                                   // prompt on stdin: no quoting or command-line length limits
  });
}

/**
 * Real streaming Claude Code adapter. With a valid `sessionId` only the NEW turn is sent (the CLI already holds
 * the history), which is the main token saver; if resuming fails it transparently retries with the full history.
 */
export async function claudeChat(messages: ChatMessage[], system: string, onChunk: (t: string) => void,
  opts: { sessionId?: string | null; signal?: AbortSignal } = {}): Promise<ClaudeResult> {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') throw new Error('No user message');

  if (opts.sessionId) {
    const r = await runOnce(last.content, system, opts.sessionId, onChunk, opts.signal);
    if (!r.error) return { text: r.text, sessionId: r.sessionId, resumed: true, usage: r.usage };
    if (r.error === 'aborted') return { text: r.text, sessionId: r.sessionId, resumed: true, usage: r.usage };
    if (r.text) throw new Error(r.error);                       // partial output already streamed: do not duplicate
    // fall through: session could not be resumed → fresh run with full history
  }
  const r = await runOnce(formatHistory(messages), system, null, onChunk, opts.signal);
  if (r.error && r.error !== 'aborted') throw new Error(r.error);
  return { text: r.text, sessionId: r.sessionId, resumed: false, usage: r.usage };
}

let cache: { at: number; ok: boolean; version: string } | null = null;
async function probeClaude(): Promise<{ ok: boolean; version: string }> {
  if (cache && Date.now() - cache.at < 30_000) return cache;
  const { file, shell } = resolveClaudeBin();
  const r = await new Promise<{ ok: boolean; version: string }>((resolve) => {
    try {
      const p = spawn(file, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], shell, windowsHide: true });
      let out = '';
      p.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
      const t = setTimeout(() => { p.kill(); resolve({ ok: false, version: '' }); }, 5000);
      p.on('close', (c) => { clearTimeout(t); resolve({ ok: c === 0, version: out.trim().split(/\r?\n/)[0].slice(0, 60) }); });
      p.on('error', () => { clearTimeout(t); resolve({ ok: false, version: '' }); });
    } catch { resolve({ ok: false, version: '' }); }
  });
  cache = { at: Date.now(), ...r };
  return r;
}
export async function checkClaudeAvailable(): Promise<boolean> { return (await probeClaude()).ok; }
/** The version the installed CLI reports (empty if unavailable) — never a hard-coded guess. */
export async function claudeVersion(): Promise<string> { return (await probeClaude()).version; }
export const _resetClaudeCache = () => { cache = null; };
export const claudeBinExists = () => existsSync(resolveClaudeBin().file);
