/**
 * Promote: copy what changed in a sandbox workspace back into the user's real project — only on explicit approval,
 * only if the real project still matches what the sandbox started from (`git apply --check`), and undoable.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { getDb } from '../db/index.js';
import { SandboxError } from './guard.js';
import { git, createCheckpoint } from './workspace.js';

const MAX_PATCH = 5 * 1024 * 1024;
const EXCLUDES = [':(exclude)node_modules', ':(exclude)**/node_modules/**', ':(exclude).git'];

interface Sb { id: string; working_dir: string; workspace_kind: string; source_path: string; base_sha: string }

function gitApply(cwd: string, patch: string, args: string[]) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'apply', '--whitespace=nowarn', ...args, '-'], { cwd, input: patch, encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  return { ok: r.status === 0, err: ((r.stderr ?? '') + (r.error ? String(r.error) : '')).trim() };
}

export function sandboxPatch(sb: Sb): { patch: string; files: string[]; truncated: boolean } {
  if (sb.workspace_kind === 'source') throw new SandboxError('This sandbox edits your real project directly; there is nothing to promote', 409);
  if (!sb.base_sha) throw new SandboxError('This sandbox was created before promote support; create a new one', 409);
  git(sb.working_dir, ['add', '-A']);                       // stage in the sandbox repo only, so new files are included
  const patch = git(sb.working_dir, ['diff', '--cached', '--binary', '--no-color', sb.base_sha, '--', '.', ...EXCLUDES]).out;
  const files = git(sb.working_dir, ['diff', '--cached', '--name-only', sb.base_sha, '--', '.', ...EXCLUDES]).out.split('\n').filter(Boolean);
  return { patch, files, truncated: patch.length > MAX_PATCH };
}

export function promoteSandbox(sb: Sb): { id: string; files: string[] } {
  if (!sb.source_path || !existsSync(sb.source_path)) throw new SandboxError('This sandbox has no source project to apply to', 409);
  const { patch, files, truncated } = sandboxPatch(sb);
  if (!patch.trim()) throw new SandboxError('No changes to apply', 409);
  if (truncated) throw new SandboxError('Change set is larger than 5 MB; apply it manually', 413);
  const check = gitApply(sb.source_path, patch, ['--check']);
  if (!check.ok) throw new SandboxError(`Your project no longer matches what this sandbox started from, so nothing was applied: ${check.err.slice(0, 400)}`, 409);
  const applied = gitApply(sb.source_path, patch, []);
  if (!applied.ok) throw new SandboxError(`Apply failed: ${applied.err.slice(0, 400)}`, 500);
  const id = randomUUID();
  getDb().prepare('INSERT INTO sandbox_promotions(id,sandbox_id,applied_at,files,patch) VALUES(?,?,?,?,?)').run(id, sb.id, new Date().toISOString(), JSON.stringify(files), patch);
  // From now on the sandbox's baseline is "what is now in your project".
  const sha = createCheckpoint(sb.working_dir, 'promoted to project');
  getDb().prepare('UPDATE sandboxes SET base_sha=? WHERE id=?').run(sha, sb.id);
  return { id, files };
}

export function undoPromotion(sb: Sb, promotionId: string): { files: string[] } {
  const row = getDb().prepare('SELECT * FROM sandbox_promotions WHERE id=? AND sandbox_id=?').get(promotionId, sb.id) as { patch: string; files: string; undone_at: string | null } | undefined;
  if (!row) throw new SandboxError('Promotion not found', 404);
  if (row.undone_at) throw new SandboxError('Already undone', 409);
  const check = gitApply(sb.source_path, row.patch, ['-R', '--check']);
  if (!check.ok) throw new SandboxError(`Cannot undo: your project changed since this was applied (${check.err.slice(0, 300)})`, 409);
  const r = gitApply(sb.source_path, row.patch, ['-R']);
  if (!r.ok) throw new SandboxError(`Undo failed: ${r.err.slice(0, 300)}`, 500);
  getDb().prepare('UPDATE sandbox_promotions SET undone_at=? WHERE id=?').run(new Date().toISOString(), promotionId);
  return { files: JSON.parse(row.files) as string[] };
}
