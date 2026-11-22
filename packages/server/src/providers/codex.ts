/**
 * ChatGPT/OpenAI chat through the official Codex CLI: `codex exec - --json --ephemeral --skip-git-repo-check -o <file>`.
 * Documented by OpenAI: `codex exec` is non-interactive, `-` reads the prompt from stdin, it runs in a read-only sandbox by default,
 * `--json` prints JSON Lines (a `turn.completed` event carries `usage.input_tokens/cached_input_tokens/output_tokens`), `-o` writes the final message to a file.
 * NOT documented / from memory and unverified: the `item.completed` / `agent_message` event used for live text, and `--skip-git-repo-check`.
 * The final answer is always taken from the `-o` file, so a different event shape only costs live streaming, not the answer.
 * Runs in an empty scratch folder, read-only; OPENAI_API_KEY / CODEX_API_KEY are removed (ChatGPT sign-in only) unless AIMAX_ALLOW_API_KEY=1.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../db/index.js';
import { killTree } from '../sandbox/runner.js';
import { ACCOUNTS, resolveBin } from '../accounts/cli.js';
import type { ChatMessage, ReportedUsage } from './claude.js';
import { formatPrompt } from './cursor.js';

export const codexBin = () => resolveBin(ACCOUNTS.find((a) => a.id === 'openai')!);
export const codexAvailable = () => codexBin() !== null;

export function codexChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'dumb', NO_COLOR: '1' };
  if (process.env.AIMAX_ALLOW_API_KEY !== '1') { delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; }
  return env;
}

export function parseCodexLine(line: string): { delta?: string; usage?: ReportedUsage; error?: string } {
  let j: any; try { j = JSON.parse(line); } catch { return {}; }
  if (j?.type === 'item.completed' && j.item?.type === 'agent_message' && typeof j.item.text === 'string') return { delta: j.item.text };
  if (j?.type === 'turn.completed' && j.usage) return { usage: { inputTokens: Number(j.usage.input_tokens ?? 0), outputTokens: Number(j.usage.output_tokens ?? 0), cacheReadTokens: Number(j.usage.cached_input_tokens ?? 0) } };
  if (j?.type === 'turn.failed' || j?.type === 'error') return { error: String(j.error?.message ?? j.message ?? 'Codex reported an error') };
  return {};
}

export function explainCodexError(msg: string): string {
  if (/not (logged|signed)[ -]?in|unauthorized|401|log ?in/i.test(msg)) return 'Codex is not signed in. Open Settings → OpenAI → Sign in (or run `codex login` in a terminal).';
  if (/usage limit|rate limit|quota|too many requests|429/i.test(msg)) return `Codex reported a usage limit: ${msg.slice(0, 200)}`;
  return msg.slice(0, 600);
}

export async function codexChat(messages: ChatMessage[], system: string, onChunk: (t: string) => void, opts: { signal?: AbortSignal } = {}): Promise<{ text: string; usage?: ReportedUsage }> {
  const file = codexBin(); if (!file) throw new Error('Codex CLI is not installed. Open Settings → OpenAI for the installer.');
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw new Error('No user message');
  const cwd = join(DATA_DIR, 'codex-scratch'); mkdirSync(cwd, { recursive: true });
  const outFile = join(DATA_DIR, `codex-last-${randomUUID()}.txt`);
  const args = ['exec', '-', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-o', outFile];
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  const q = (a: string) => (/\s/.test(a) ? `"${a}"` : a);

  return new Promise((resolve, reject) => {
    const proc = needsShell
      ? spawn(`"${file}" ${args.map(q).join(' ')}`, { shell: true, cwd, env: codexChildEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(file, args, { cwd, env: codexChildEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = ''; let streamed = ''; let usage: ReportedUsage | undefined; let cliErr = ''; let err = ''; let stderr = ''; let aborted = false; let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); fn(); };
    const onAbort = () => { aborted = true; killTree(proc.pid); };
    const timer = setTimeout(() => { err = 'Codex CLI timed out after 10 minutes'; killTree(proc.pid); }, 600_000);
    opts.signal?.addEventListener('abort', onAbort);
    const handle = (line: string) => { const p = parseCodexLine(line); if (p.delta) { streamed += (streamed ? '\n\n' : '') + p.delta; onChunk((streamed === p.delta ? '' : '\n\n') + p.delta); } if (p.usage) usage = p.usage; if (p.error) cliErr = p.error; };
    proc.stdout!.on('data', (d: Buffer) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } });
    proc.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
    proc.on('error', (e) => finish(() => reject(new Error(`Could not start the Codex CLI: ${e.message}`))));
    proc.on('close', (code) => finish(() => {
      if (buf.trim()) handle(buf.trim());
      let last = ''; try { last = readFileSync(outFile, 'utf8').trim(); } catch { /* not written */ } finally { rmSync(outFile, { force: true }); }
      if (aborted) return resolve({ text: streamed, usage });
      const failure = err || (!last && !streamed ? (cliErr || (code !== 0 ? (stderr.trim() || `Codex CLI exited with code ${code}`) : '')) : '');
      if (failure) return reject(new Error(explainCodexError(failure)));
      const final = last || streamed;
      if (!final) return reject(new Error('Codex returned no text.'));
      if (!streamed) onChunk(final);                       // no live events understood: deliver the file's text at once
      resolve({ text: final, usage });
    }));
    proc.stdin!.on('error', () => undefined); proc.stdin!.end(formatPrompt(messages, system));
  });
}
