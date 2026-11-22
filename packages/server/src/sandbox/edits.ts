/**
 * Edit proposals: the model (any provider) proposes file changes as SEARCH/REPLACE blocks; nothing is written until
 * the user approves. All-or-nothing, exact-match-once, confined to the sandbox workspace.
 *
 *   FILE: src/app.ts
 *   <<<<<<< SEARCH
 *   old text
 *   =======
 *   new text
 *   >>>>>>> REPLACE
 *
 * An empty SEARCH creates a new file (it must not exist yet).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SandboxError, resolveInside } from './guard.js';

export interface EditOp { path: string; search: string; replace: string }
export interface EditPreview { path: string; kind: 'create' | 'modify'; ok: boolean; error?: string; diff: string }
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_EDITS = 50;

export function parseEdits(text: string): EditOp[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const ops: EditOp[] = [];
  let file = ''; let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const f = /^FILE:\s*(.+?)\s*$/.exec(l);
    if (f) { file = f[1].replace(/^["'`]|["'`]$/g, ''); i++; continue; }
    if (/^<{7} SEARCH\s*$/.test(l)) {
      if (!file) throw new SandboxError('Edit block has no FILE: line before it');
      const search: string[] = []; const replace: string[] = []; i++;
      while (i < lines.length && !/^={7}\s*$/.test(lines[i])) search.push(lines[i++]);
      if (i >= lines.length) throw new SandboxError('Edit block is missing the ======= separator');
      i++;
      while (i < lines.length && !/^>{7} REPLACE\s*$/.test(lines[i])) replace.push(lines[i++]);
      if (i >= lines.length) throw new SandboxError('Edit block is missing the >>>>>>> REPLACE terminator');
      i++;
      ops.push({ path: file, search: search.join('\n'), replace: replace.join('\n') });
      if (ops.length > MAX_EDITS) throw new SandboxError(`Too many edits in one proposal (max ${MAX_EDITS})`);
      continue;
    }
    i++;
  }
  if (!ops.length) throw new SandboxError('No SEARCH/REPLACE edits found');
  return ops;
}

function checkPath(root: string, rel: string): string {
  if (!rel || rel.length > 500) throw new SandboxError('Invalid file path');
  if (rel.split(/[\\/]/).some(seg => seg === '.git')) throw new SandboxError('Editing .git is not allowed');
  return resolveInside(root, rel);
}

function readText(abs: string): string {
  const st = statSync(abs);
  if (!st.isFile()) throw new SandboxError('Not a regular file');
  if (st.size > MAX_FILE_BYTES) throw new SandboxError(`File is larger than ${MAX_FILE_BYTES >> 20} MB`);
  const buf = readFileSync(abs);
  if (buf.includes(0)) throw new SandboxError('Binary file');
  return buf.toString('utf8');
}

function hunk(path: string, before: string, search: string, replace: string, at: number): string {
  const startLine = before.slice(0, at).split('\n').length;       // 1-based line of the match
  const lines = before.split('\n'); const sl = search === '' ? [] : search.split('\n'); const rl = replace === '' ? [] : replace.split('\n');
  const ctxBefore = lines.slice(Math.max(0, startLine - 1 - 3), startLine - 1);
  const ctxAfter = lines.slice(startLine - 1 + sl.length, startLine - 1 + sl.length + 3);
  const from = startLine - ctxBefore.length;
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -${from},${ctxBefore.length + sl.length + ctxAfter.length} +${from},${ctxBefore.length + rl.length + ctxAfter.length} @@`,
    ...ctxBefore.map(x => ' ' + x), ...sl.map(x => '-' + x), ...rl.map(x => '+' + x), ...ctxAfter.map(x => ' ' + x)].join('\n');
}

interface Plan { previews: EditPreview[]; files: Map<string, string> }

function plan(root: string, ops: EditOp[]): Plan {
  const files = new Map<string, string>();          // abs path → content after the edits so far (in-memory)
  const original = new Set<string>();
  const previews: EditPreview[] = [];
  for (const op of ops) {
    const pv: EditPreview = { path: op.path, kind: op.search === '' ? 'create' : 'modify', ok: false, diff: '' };
    previews.push(pv);
    try {
      const abs = checkPath(root, op.path);
      if (op.search === '') {
        if (files.has(abs) || existsSync(abs)) throw new SandboxError('File already exists — give a SEARCH block to modify it');
        if (Buffer.byteLength(op.replace) > MAX_FILE_BYTES) throw new SandboxError('New file too large');
        files.set(abs, op.replace); original.add(abs);
        pv.diff = [`--- /dev/null`, `+++ b/${op.path}`, `@@ -0,0 +1,${op.replace.split('\n').length} @@`, ...op.replace.split('\n').map(x => '+' + x)].join('\n');
        pv.ok = true; continue;
      }
      if (!files.has(abs)) { if (!existsSync(abs)) throw new SandboxError('File does not exist'); files.set(abs, readText(abs)); }
      let content = files.get(abs)!;
      const crlf = content.includes('\r\n');
      const norm = (t: string) => (crlf ? t.replace(/\n/g, '\r\n') : t);
      const search = norm(op.search); const replace = norm(op.replace);
      const first = content.indexOf(search);
      if (first < 0) throw new SandboxError('SEARCH text not found (it must match the file exactly, including whitespace)');
      if (content.indexOf(search, first + 1) >= 0) throw new SandboxError('SEARCH text matches more than once — include more surrounding lines');
      pv.diff = hunk(op.path, content.replace(/\r\n/g, '\n'), op.search, op.replace, content.slice(0, first).replace(/\r\n/g, '\n').length);
      content = content.slice(0, first) + replace + content.slice(first + search.length);
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new SandboxError('Result would exceed the file size limit');
      files.set(abs, content); pv.ok = true;
    } catch (e) { pv.error = e instanceof Error ? e.message : String(e); }
  }
  return { previews, files };
}

export function previewEdits(root: string, text: string): { ok: boolean; edits: EditPreview[] } {
  const { previews } = plan(root, parseEdits(text));
  return { ok: previews.every(p => p.ok), edits: previews };
}

/** Validates everything first; writes only if every edit is valid. */
export function applyEdits(root: string, text: string): { files: string[]; edits: EditPreview[] } {
  const { previews, files } = plan(root, parseEdits(text));
  const bad = previews.find(p => !p.ok);
  if (bad) throw new SandboxError(`Nothing was changed. ${bad.path}: ${bad.error}`, 422);
  for (const [abs, content] of files) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content, 'utf8'); }
  return { files: [...new Set(previews.map(p => p.path))], edits: previews };
}
