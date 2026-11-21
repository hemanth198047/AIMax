import { spawn } from 'child_process';
import { join } from 'path';
import { mkdirSync, readdirSync, statSync } from 'fs';
import { DATA_DIR } from '../db/index.js';

const SANDBOXES_DIR = join(DATA_DIR, 'sandboxes');

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  workingDir: string;
  durationMs: number;
}

export function getSandboxDir(sandboxId: string): string {
  const dir = join(SANDBOXES_DIR, sandboxId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function executeCommand(
  command: string,
  workingDir: string,
  timeoutMs = 30000,
  onData?: (chunk: string) => void
): Promise<ExecuteResult> {
  mkdirSync(workingDir, { recursive: true });
  const start = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn('powershell.exe', [
      '-NonInteractive',
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command', command
    ], {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, TERM: 'dumb' }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      onData?.(text);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      onData?.(`[stderr] ${text}`);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.slice(0, 50000),
        stderr: stderr.slice(0, 10000),
        exitCode: code ?? -1,
        timedOut,
        workingDir,
        durationMs: Date.now() - start
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: -1,
        timedOut: false,
        workingDir,
        durationMs: Date.now() - start
      });
    });
  });
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
  children?: FileEntry[];
}

export function listFiles(dir: string, maxDepth = 2, depth = 0): FileEntry[] {
  const entries: FileEntry[] = [];
  try {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      try {
        const stat = statSync(full);
        const entry: FileEntry = {
          name,
          path: full,
          type: stat.isDirectory() ? 'directory' : 'file',
          size: stat.size,
          modified: stat.mtime.toISOString()
        };
        if (stat.isDirectory() && depth < maxDepth) {
          entry.children = listFiles(full, maxDepth, depth + 1);
        }
        entries.push(entry);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
