/**
 * Cursor chat through the official Cursor CLI in print mode: `agent -p --output-format stream-json`.
 * Built from Cursor's public docs (print mode, --output-format, stream-json `assistant` / `result` events) and NOT yet run against the real CLI:
 *  - the prompt is sent on STDIN (never on the command line, so no shell quoting / injection problem on Windows .cmd shims);
 *    if your CLI wants it as an argument, set AIMAX_CURSOR_PROMPT_MODE=arg (macOS/Linux/.exe only);
 *  - it runs in an empty scratch folder with no --force, so it cannot change your files;
 *  - CURSOR_API_KEY is removed from the environment (subscription login only) unless AIMAX_ALLOW_API_KEY=1.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../db/index.js';
import { killTree } from '../sandbox/runner.js';
import { ACCOUNTS, resolveBin } from '../accounts/cli.js';
import type { ChatMessage, ReportedUsage } from './claude.js';

const def = () => ACCOUNTS.find((a) => a.id === 'cursor')!;
export const cursorBin = () => resolveBin(def());
export const cursorAvailable = () => cursorBin() !== null;

export function cursorChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'dumb', NO_COLOR: '1' };
  if (process.env.AIMAX_ALLOW_API_KEY !== '1') delete env.CURSOR_API_KEY;
  return env;
}

export function formatPrompt(messages: ChatMessage[], system: string): string {
  const last = messages[messages.length - 1];
  const hist = messages.slice(0, -1).map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`).join('\n\n');
  return `${system}\n\nAnswer in chat only. Do not read, edit or create files and do not run commands.\n\n${hist ? `Previous conversation:\n${hist}\n\n` : ''}Human: ${last.content}`;
}

/** One stream-json line → text to show, final result, usage. Tolerant: unknown shapes are ignored. */
export function parseCursorLine(line: string): { delta?: string; result?: string; usage?: ReportedUsage; error?: string } {
  let j: any; try { j = JSON.parse(line); } catch { return {}; }
  if (j?.type === 'assistant') {
    const parts = Array.isArray(j.message?.content) ? j.message.content : [];
    const text = parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
    // With partial output on, a buffered flush repeats deltas; we do not enable it, so every assistant event is new text.
    return text ? { delta: text } : {};
  }
  if (j?.type === 'result') {
    const u = j.usage; const usage: ReportedUsage | undefined = u && (typeof u.inputTokens === 'number' || typeof u.input_tokens === 'number')
      ? { inputTokens: Number(u.inputTokens ?? u.input_tokens ?? 0), outputTokens: Number(u.outputTokens ?? u.output_tokens ?? 0), cacheReadTokens: Number(u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0) } : undefined;
    if (j.is_error || j.subtype === 'error') return { error: String(j.result ?? j.error ?? 'Cursor reported an error'), usage };
    return { result: typeof j.result === 'string' ? j.result : undefined, usage };
  }
  return {};
}

export function explainCursorError(msg: string): string {
  if (/not (logged|signed)[ -]?in|unauthenticated|authentication required|login/i.test(msg)) return 'Cursor is not signed in. Open Settings → Cursor → Sign in (or run `agent login` in a terminal).';
  if (/usage limit|rate limit|quota|too many requests/i.test(msg)) return `Cursor reported a usage limit: ${msg.slice(0, 200)}`;
  return msg.slice(0, 600);
}

export async function cursorChat(messages: ChatMessage[], system: string, onChunk: (t: string) => void, opts: { signal?: AbortSignal } = {}): Promise<{ text: string; usage?: ReportedUsage }> {
  const file = cursorBin(); if (!file) throw new Error('Cursor CLI is not installed. Open Settings → Cursor for the installer.');
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw new Error('No user message');
  const prompt = formatPrompt(messages, system);
  const argMode = process.env.AIMAX_CURSOR_PROMPT_MODE === 'arg';
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  if (argMode && needsShell) throw new Error('AIMAX_CURSOR_PROMPT_MODE=arg is not allowed with a .cmd launcher (shell quoting is unsafe). Use the default stdin mode.');
  const cwd = join(DATA_DIR, 'cursor-scratch'); mkdirSync(cwd, { recursive: true });
  const args = ['-p', '--output-format', 'stream-json', ...(argMode ? [prompt] : [])];

  return new Promise((resolve, reject) => {
    const proc = needsShell
      ? spawn(`"${file}" ${args.join(' ')}`, { shell: true, cwd, env: cursorChildEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(file, args, { cwd, env: cursorChildEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = ''; let text = ''; let result: string | undefined; let usage: ReportedUsage | undefined; let err = ''; let cliErr = ''; let aborted = false; let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); fn(); };
    const onAbort = () => { aborted = true; killTree(proc.pid); };
    const timer = setTimeout(() => { err = 'Cursor CLI timed out after 10 minutes'; killTree(proc.pid); }, 600_000);
    opts.signal?.addEventListener('abort', onAbort);
    const handle = (line: string) => {
      const p = parseCursorLine(line);
      if (p.delta) { text += p.delta; onChunk(p.delta); }
      if (p.result !== undefined) result = p.result; if (p.usage) usage = p.usage; if (p.error) cliErr = p.error;
    };
    proc.stdout!.on('data', (d: Buffer) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } });
    let stderr = ''; proc.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
    proc.on('error', (e) => finish(() => reject(new Error(`Could not start the Cursor CLI: ${e.message}`))));
    proc.on('close', (code) => finish(() => {
      if (buf.trim()) handle(buf.trim());
      if (aborted) return resolve({ text, usage });
      const failure = err || cliErr || (code !== 0 && !text && !result ? (stderr.trim() || `Cursor CLI exited with code ${code}`) : '');
      if (failure) return reject(new Error(explainCursorError(failure)));
      const final = text || result || '';
      if (!text && result) onChunk(result);
      if (!final) return reject(new Error(`Cursor returned no text.${stderr.trim() ? ` ${stderr.trim().slice(0, 300)}` : ''}`));
      resolve({ text: final, usage });
    }));
    if (!argMode) { proc.stdin!.on('error', () => undefined); proc.stdin!.end(prompt); } else proc.stdin!.end();
  });
}
