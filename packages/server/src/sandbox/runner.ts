import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { scrubEnv } from './guard.js';

export interface RunOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** When set, run inside `docker run` with the network disabled and resource limits. */
  container?: { image: string; memory?: string; cpus?: string; pids?: number; network?: 'none' | 'bridge' };
  onData?: (text: string, stream: 'stdout' | 'stderr') => void;
}
export interface RunResult {
  runId: string; stdout: string; stderr: string; exitCode: number;
  status: 'done' | 'timeout' | 'cancelled' | 'error'; truncated: boolean; durationMs: number;
}
export interface RunHandle { runId: string; pid?: number; shell?: string; cancel: () => void; result: Promise<RunResult>; }

const active = new Map<string, () => void>();
export const cancelRun = (runId: string) => { const c = active.get(runId); if (c) { c(); return true; } return false; };
export const activeRunIds = () => [...active.keys()];

const IS_WIN = process.platform === 'win32';

export function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-pid, 'SIGKILL');           // whole process group (spawned detached)
  } catch { /* already gone */ }
}

/** Windows PowerShell can wrap errors in "#< CLIXML <Objs>…" when its output is piped; turn that back into the readable message. */
export function cleanClixml(text: string): string {
  if (!text.startsWith('#< CLIXML')) return text;
  const parts = [...text.matchAll(/<S S="(?:Error|error)">([\s\S]*?)<\/S>/g)].map((m) => m[1]);
  const decoded = parts.join('').replace(/_x000D__x000A_/g, '\n').replace(/_x000A_/g, '\n').replace(/_x000D_/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  return decoded;
}

export const shellName = () => (IS_WIN ? 'Windows PowerShell' : 'bash');

export function startRun(opts: RunOptions): RunHandle {
  const runId = randomUUID();
  const { command, cwd, timeoutMs = 30_000, maxOutputBytes = 1_000_000, container, onData } = opts;
  const started = Date.now();

  let file: string; let args: string[]; let env: NodeJS.ProcessEnv;
  if (container) {
    const name = `aimax-${runId.slice(0, 12)}`;
    file = 'docker';
    args = ['run', '--rm', '--name', name, '--network', container.network ?? 'none',
      '--memory', container.memory ?? '1g', '--cpus', container.cpus ?? '2', '--pids-limit', String(container.pids ?? 256),
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
      '-v', `${cwd}:/work`, '-w', '/work', container.image, 'sh', '-c', command];
    env = { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST };
  } else if (IS_WIN) {
    // -EncodedCommand avoids every quoting problem (quotes, &, |, $ in the command). The preamble silences progress bars (which otherwise
    // become XML noise on stderr) and asks for UTF-8 output; setting the console encoding can throw when no console is attached, hence try/catch.
    const script = `$ProgressPreference='SilentlyContinue'; try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; ${command}`;
    file = 'powershell.exe';
    args = ['-NoLogo', '-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    env = scrubEnv(cwd);
  } else {
    file = 'bash'; args = ['-c', command]; env = scrubEnv(cwd);
  }

  let stdout = '', stderr = '', size = 0, truncated = false;
  let status: RunResult['status'] = 'done';
  let settled = false;

  const result = new Promise<RunResult>((resolveRun) => {
    const proc = spawn(file, args, { cwd: container ? undefined : cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !IS_WIN });

    const stop = (why: 'timeout' | 'cancelled') => {
      if (settled) return;
      status = why;
      if (container) spawnSync('docker', ['kill', `aimax-${runId.slice(0, 12)}`]);
      killTree(proc.pid);
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    active.set(runId, () => stop('cancelled'));

    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (size >= maxOutputBytes) { truncated = true; return; }
      let text = cleanClixml(chunk.toString());
      if (!text) return;
      if (size + text.length > maxOutputBytes) { text = text.slice(0, maxOutputBytes - size); truncated = true; }
      size += text.length;
      if (stream === 'stdout') stdout += text; else stderr += text;
      onData?.(text, stream);
      if (truncated) killTree(proc.pid);           // runaway output: stop the process
    };
    proc.stdout.on('data', collect('stdout'));
    proc.stderr.on('data', collect('stderr'));

    const finish = (code: number | null, err?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.delete(runId);
      if (err) { status = 'error'; const msg = `Could not start ${file}: ${err}\n`; stderr += msg; onData?.(msg, 'stderr'); }
      killTree(proc.pid);                           // reap stragglers (background children)
      resolveRun({ runId, stdout, stderr, exitCode: code ?? -1, status, truncated, durationMs: Date.now() - started });
    };
    proc.on('close', (code) => finish(code));
    // A background child that inherits the pipes can keep 'close' from firing; once the shell itself has exited, don't wait forever.
    proc.on('exit', (code) => { setTimeout(() => finish(code), 1500).unref(); });
    proc.on('error', (e) => finish(-1, e.message));
  });

  return { runId, pid: undefined as number | undefined, shell: container ? 'docker' : shellName(), cancel: () => cancelRun(runId), result };
}

export function dockerUsable(): { available: boolean; detail: string } {
  try {
    const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) return { available: true, detail: `docker ${r.stdout.trim()}` };
    return { available: false, detail: (r.stderr || 'docker daemon not reachable').trim().slice(0, 120) };
  } catch (e) {
    return { available: false, detail: e instanceof Error ? e.message : 'docker not found' };
  }
}
