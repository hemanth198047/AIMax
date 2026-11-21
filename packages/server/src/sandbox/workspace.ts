import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../db/index.js';
import { SandboxError } from './guard.js';

export type SandboxMode = 'readonly' | 'temporary' | 'container' | 'direct';
export type WorkspaceKind = 'dir' | 'worktree' | 'copy' | 'source';

export const SANDBOXES_DIR = join(DATA_DIR, 'sandboxes');

/** Run git without trusting repo config: no hooks, no fsmonitor, no pager, fixed identity. */
export function git(dir: string, args: string[], timeoutMs = 20_000) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat',
      GIT_AUTHOR_NAME: 'AImax', GIT_AUTHOR_EMAIL: 'aimax@localhost', GIT_COMMITTER_NAME: 'AImax', GIT_COMMITTER_EMAIL: 'aimax@localhost' },
  });
  return { ok: r.status === 0, out: (r.stdout ?? '').toString(), err: (r.stderr ?? '').toString() };
}

export function isGitRepo(dir: string): boolean {
  return existsSync(dir) && git(dir, ['rev-parse', '--is-inside-work-tree']).out.trim() === 'true';
}
export function assertDir(p: string, label = 'source_path') {
  if (!p || !existsSync(p) || !statSync(p).isDirectory()) throw new SandboxError(`${label} does not exist or is not a directory`);
}

export interface Workspace { dir: string; kind: WorkspaceKind; sourcePath: string }

export function createWorkspace(id: string, mode: SandboxMode, sourcePath: string): Workspace {
  if (mode === 'readonly' || mode === 'direct') {
    assertDir(sourcePath);
    return { dir: sourcePath, kind: 'source', sourcePath };
  }
  const dir = join(SANDBOXES_DIR, id);
  mkdirSync(SANDBOXES_DIR, { recursive: true });
  if (!sourcePath) {
    mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q']);
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'aimax checkpoint: initial']);
    return { dir, kind: 'dir', sourcePath: '' };
  }
  assertDir(sourcePath);
  if (isGitRepo(sourcePath)) {
    const r = git(sourcePath, ['worktree', 'add', '--detach', dir]);
    if (!r.ok) throw new SandboxError(`git worktree failed: ${r.err.trim().slice(0, 200)}`, 500);
    return { dir, kind: 'worktree', sourcePath };
  }
  cpSync(sourcePath, dir, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'aimax checkpoint: initial copy']);
  return { dir, kind: 'copy', sourcePath };
}

export function destroyWorkspace(dir: string, kind: WorkspaceKind, sourcePath: string) {
  if (kind === 'source') return;                       // never touch the user's real project
  if (kind === 'worktree' && sourcePath && existsSync(sourcePath)) git(sourcePath, ['worktree', 'remove', '--force', dir]);
  if (existsSync(dir) && dir.startsWith(SANDBOXES_DIR)) rmSync(dir, { recursive: true, force: true });
  if (kind === 'worktree' && sourcePath && existsSync(sourcePath)) git(sourcePath, ['worktree', 'prune']);
}

export function gitStatus(dir: string) {
  if (!isGitRepo(dir)) return { isRepo: false, files: [] as { status: string; path: string }[] };
  const r = git(dir, ['status', '--porcelain=v1', '-uall']);
  const files = r.out.split('\n').filter(Boolean).map(l => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
  return { isRepo: true, files };
}
export function gitDiff(dir: string, maxBytes = 200_000) {
  if (!isGitRepo(dir)) return { isRepo: false, diff: '', truncated: false };
  let d = git(dir, ['diff', '--no-color', 'HEAD']).out;
  // New (untracked) files are invisible to `git diff HEAD`. Render them as additions with --no-index,
  // which reads files only and never touches the index (important in readonly/direct modes).
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard']).out.split('\n').filter(Boolean).slice(0, 50);
  const nul = process.platform === 'win32' ? 'NUL' : '/dev/null';
  for (const f of untracked) {
    if (d.length > maxBytes) break;
    d += git(dir, ['diff', '--no-color', '--no-index', '--', nul, f]).out;   // exit status 1 just means "differs"
  }
  return { isRepo: true, diff: d.slice(0, maxBytes), truncated: d.length > maxBytes };
}

const CP_PREFIX = 'aimax checkpoint: ';
export function createCheckpoint(dir: string, label: string) {
  git(dir, ['add', '-A']);
  const c = git(dir, ['commit', '-q', '--allow-empty', '-m', CP_PREFIX + label.replace(/[\r\n]+/g, ' ').slice(0, 120)]);
  if (!c.ok) throw new SandboxError(`checkpoint failed: ${c.err.trim().slice(0, 200)}`, 500);
  return git(dir, ['rev-parse', 'HEAD']).out.trim();
}
export function listCheckpoints(dir: string) {
  const r = git(dir, ['log', '--format=%H%x09%cI%x09%s', `--grep=^${CP_PREFIX}`, '-n', '100']);
  return r.out.split('\n').filter(Boolean).map(l => {
    const [sha, at, subject] = l.split('\t');
    return { sha, created_at: at, label: subject.replace(CP_PREFIX, '') };
  });
}
export function restoreCheckpoint(dir: string, sha: string) {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new SandboxError('Invalid checkpoint id');
  if (!listCheckpoints(dir).some(c => c.sha.startsWith(sha))) throw new SandboxError('Not a checkpoint of this sandbox', 404);
  const r = git(dir, ['reset', '--hard', sha]);
  if (!r.ok) throw new SandboxError(`restore failed: ${r.err.trim().slice(0, 200)}`, 500);
  git(dir, ['clean', '-fdq']);
}

export interface FileEntry { name: string; path: string; type: 'file' | 'directory'; size: number; modified: string; children?: FileEntry[] }
const HIDE = new Set(['.git', 'node_modules']);
/** `path` values are relative to the workspace root (never absolute host paths). */
export function listFiles(root: string, rel = '', maxDepth = 2, depth = 0): FileEntry[] {
  const out: FileEntry[] = [];
  const base = rel ? join(root, rel) : root;
  let names: string[] = [];
  try { names = readdirSync(base); } catch { return out; }
  for (const name of names) {
    if (HIDE.has(name)) continue;
    try {
      const st = statSync(join(base, name));
      const p = rel ? `${rel}/${name}` : name;
      const e: FileEntry = { name, path: p, type: st.isDirectory() ? 'directory' : 'file', size: st.size, modified: st.mtime.toISOString() };
      if (st.isDirectory() && depth < maxDepth) e.children = listFiles(root, p, maxDepth, depth + 1);
      out.push(e);
    } catch { /* unreadable entry */ }
  }
  return out.sort((a, b) => a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name));
}
