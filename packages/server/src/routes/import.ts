import type { FastifyInstance } from 'fastify';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { LIMITS, type ImportedConversation, type ScanItem } from '../importers/types.js';
import { defaultClaudeDir, scanClaudeCode, loadClaudeCode } from '../importers/claudeCode.js';
import { defaultCursorDir, scanCursor, loadCursor } from '../importers/cursor.js';
import { parseChatFile } from '../importers/generic.js';
import { redact } from '../importers/redact.js';
import { importKey, importedKeys, storeImported } from '../importers/store.js';

const SOURCES = ['claude-code', 'cursor', 'file'] as const;
type Source = typeof SOURCES[number];

class ImportError extends Error { constructor(m: string, public status = 400) { super(m); } }

// Parsed uploads are held briefly in memory so the user can pick conversations from a multi-chat export.
const uploads = new Map<string, { at: number; convs: ImportedConversation[]; filename: string }>();
const TTL = 30 * 60_000;
function gcUploads() { const now = Date.now(); for (const [k, v] of uploads) if (now - v.at > TTL) uploads.delete(k); while (uploads.size > 5) uploads.delete(uploads.keys().next().value!); }

function resolveDir(source: Source, dir?: string): string {
  const d = dir?.trim() || (source === 'claude-code' ? defaultClaudeDir() : defaultCursorDir());
  if (!isAbsolute(d)) throw new ImportError('Folder must be an absolute path');
  if (!existsSync(d) || !statSync(d).isDirectory()) throw new ImportError(`Folder not found: ${d}`, 404);
  return d;
}

async function loadOne(source: Source, dir: string | undefined, importId: string | undefined, id: string): Promise<ImportedConversation> {
  if (source === 'claude-code') return loadClaudeCode(resolveDir(source, dir), id);
  if (source === 'cursor') return loadCursor(resolveDir(source, dir), id);
  const u = importId ? uploads.get(importId) : undefined;
  if (!u) throw new ImportError('Upload expired — choose the file again', 410);
  const c = u.convs.find(x => x.key === id); if (!c) throw new ImportError('Conversation not in this file', 404);
  return c;
}

export async function importRoutes(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ImportError) return reply.status(err.status).send({ error: err.message });
    reply.send(err);
  });

  app.get('/api/import/sources', async () => [
    { id: 'claude-code', label: 'Claude Code sessions', defaultDir: defaultClaudeDir(), exists: existsSync(defaultClaudeDir()) },
    { id: 'cursor', label: 'Cursor chats', defaultDir: defaultCursorDir(), exists: existsSync(defaultCursorDir()) },
    { id: 'file', label: 'Exported chat file (FreeLLMAPI, ChatGPT, Claude.ai, JSON, markdown)', defaultDir: '', exists: true },
  ]);

  app.post<{ Body: { source?: string; dir?: string } }>('/api/import/scan', async (req) => {
    const source = req.body?.source as Source;
    if (source !== 'claude-code' && source !== 'cursor') throw new ImportError('source must be claude-code or cursor (use /api/import/file for files)');
    const dir = resolveDir(source, req.body?.dir);
    const r = source === 'claude-code' ? await scanClaudeCode(dir) : scanCursor(dir);
    const done = importedKeys(source);
    return { dir, diagnostics: r.diagnostics, items: r.items.map(i => ({ ...i, imported: done.has(importKey(source, i.id)) })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  });

  app.post('/api/import/file', async (req) => {
    const part = await req.file({ limits: { fileSize: LIMITS.uploadBytes } });
    if (!part) throw new ImportError('No file uploaded');
    const buf = await part.toBuffer();
    if ((part as { file: { truncated?: boolean } }).file.truncated) throw new ImportError(`File is larger than ${LIMITS.uploadBytes >> 20} MB`, 413);
    let convs: ImportedConversation[];
    try { convs = parseChatFile(buf.toString('utf8'), part.filename); } catch (e) { throw new ImportError(e instanceof Error ? e.message : String(e), 422); }
    gcUploads();
    const importId = randomUUID(); uploads.set(importId, { at: Date.now(), convs, filename: part.filename });
    const done = importedKeys('file');
    const items: ScanItem[] = convs.map(c => ({ id: c.key, title: c.title.slice(0, 100), messages: c.messages.length, updatedAt: c.updatedAt ?? c.createdAt ?? '', project: '', imported: done.has(importKey('file', c.key)) }));
    return { importId, filename: part.filename, items, diagnostics: [`${convs.length} conversation(s) recognised`] };
  });

  /** A short look at what would be imported (after redaction, if enabled). */
  app.post<{ Body: { source?: string; dir?: string; importId?: string; id?: string; redact?: boolean } }>('/api/import/preview', async (req) => {
    const b = req.body ?? {}; if (!SOURCES.includes(b.source as Source) || !b.id) throw new ImportError('source and id are required');
    const c = await loadOne(b.source as Source, b.dir, b.importId, b.id).catch(e => { throw e instanceof ImportError ? e : new ImportError(e instanceof Error ? e.message : String(e), 422); });
    const pick = c.messages.length > 6 ? [...c.messages.slice(0, 4), ...c.messages.slice(-2)] : c.messages;
    let redactions = 0;
    const show = (t: string) => { const s = t.slice(0, 400) + (t.length > 400 ? '…' : ''); if (b.redact === false) return s; const r = redact(s); redactions += r.count; return r.text; };
    return { title: c.title, project: c.project ?? '', messages: c.messages.length, truncated: !!c.truncated, sample: pick.map(m => ({ role: m.role, content: show(m.content) })), redactionsInSample: redactions };
  });

  app.post<{ Body: { source?: string; dir?: string; importId?: string; ids?: string[]; project_id?: string | null; person_id?: string | null; redact?: boolean } }>('/api/import/run', async (req) => {
    const b = req.body ?? {};
    if (!SOURCES.includes(b.source as Source)) throw new ImportError('Invalid source');
    if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 100) throw new ImportError('ids: choose between 1 and 100 conversations');
    const db = getDb();
    if (b.project_id && !db.prepare('SELECT 1 FROM projects WHERE id=?').get(b.project_id)) throw new ImportError('Project not found', 404);
    if (b.person_id && !db.prepare('SELECT 1 FROM people WHERE id=?').get(b.person_id)) throw new ImportError('Person not found', 404);
    const results = [];
    for (const id of b.ids) {
      try {
        const conv = await loadOne(b.source as Source, b.dir, b.importId, String(id));
        results.push({ id, title: conv.title, ...storeImported(conv, { source: b.source!, projectId: b.project_id ?? null, personId: b.person_id ?? null, redact: b.redact !== false }) });
      } catch (e) { results.push({ id, status: 'error' as const, reason: e instanceof Error ? e.message : String(e) }); }
    }
    return { results, imported: results.filter(r => r.status === 'imported').length };
  });
}
