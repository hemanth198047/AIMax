import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
let proc: ChildProcess | null = null;

/** Start the real AImax server against `dataDir` (test provider enabled). Resolves when /api/health answers. */
export async function startServer(dataDir: string) {
  const tsx = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  proc = spawn(tsx, ['packages/server/src/index.ts'], {
    cwd: ROOT, shell: process.platform === 'win32',
    env: { ...process.env, PORT: '3001', AIMAX_DATA_DIR: dataDir, AIMAX_TEST_PROVIDER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout?.on('data', d => (log += d)); proc.stderr?.on('data', d => (log += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch('http://127.0.0.1:3001/api/health')).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('AImax server did not start:\n' + log.slice(-2000));
}

export async function stopServer() {
  const p = proc; proc = null;
  if (!p?.pid) return;
  await new Promise<void>(resolve => {
    p.once('exit', () => resolve());
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F']);
    else p.kill('SIGTERM');
    setTimeout(resolve, 3000);
  });
  // wait for the port to free up
  for (let i = 0; i < 50; i++) {
    try { await fetch('http://127.0.0.1:3001/api/health'); } catch { return; }
    await new Promise(r => setTimeout(r, 100));
  }
}
