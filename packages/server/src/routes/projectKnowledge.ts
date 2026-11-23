import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getDb } from '../db/index.js';
import { extractAttachment } from '../attachments/extract.js';
import { addKnowledge, listKnowledge } from '../projects/knowledge.js';
import { readLink } from '../web/links.js';

/** Claude-style "project knowledge": files, notes and web pages that every chat in the project can draw on. Strictly per project. */
export async function projectKnowledgeRoutes(app: FastifyInstance) {
  const exists = (id: string) => !!getDb().prepare('SELECT 1 FROM projects WHERE id=?').get(id);

  app.get<{ Params: { id: string } }>('/api/projects/:id/knowledge', async (req, reply) => {
    if (!exists(req.params.id)) return reply.status(404).send({ error: 'Not found' });
    return listKnowledge(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/knowledge/file', async (req, reply) => {
    if (!exists(req.params.id)) return reply.status(404).send({ error: 'Not found' });
    const data = await req.file(); if (!data) return reply.status(400).send({ error: 'No file' });
    const original = basename(data.filename).slice(0, 200) || 'file';
    const dir = mkdtempSync(join(tmpdir(), 'aimax-pk-')); const path = join(dir, original.replace(/[^a-zA-Z0-9._-]/g, '_'));
    try {
      await pipeline(data.file, createWriteStream(path));
      if (data.file.truncated) return reply.status(413).send({ error: 'File too large (50 MB limit)' });
      const size = statSync(path).size; const ex = await extractAttachment(path, original, data.mimetype, size);
      if (!ex.extracted) return reply.status(422).send({ error: ex.reason ?? 'AImax cannot read text from this file type.' });
      const id = uuidv4(); const r = addKnowledge(req.params.id, { id, kind: 'file', title: original, mimetype: data.mimetype, size, text: ex.text });
      if (!r.ok) return reply.status(413).send({ error: r.error });
      return { id, title: original, chars: ex.text.length, truncated: ex.truncated, note: ex.truncated ? 'Only the first part of this file was readable and added.' : null };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  app.post<{ Params: { id: string }; Body: { title?: unknown; text?: unknown } }>('/api/projects/:id/knowledge/note', async (req, reply) => {
    if (!exists(req.params.id)) return reply.status(404).send({ error: 'Not found' });
    const { title, text } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) return reply.status(400).send({ error: 'Write some text first.' });
    if (text.length > 200_000) return reply.status(413).send({ error: 'A single note can be up to 200,000 characters.' });
    const id = uuidv4(); const r = addKnowledge(req.params.id, { id, kind: 'note', title: typeof title === 'string' && title.trim() ? title.trim() : text.trim().split('\n')[0].slice(0, 60), text });
    return r.ok ? { id } : reply.status(413).send({ error: r.error });
  });

  app.post<{ Params: { id: string }; Body: { url?: unknown } }>('/api/projects/:id/knowledge/link', async (req, reply) => {
    if (!exists(req.params.id)) return reply.status(404).send({ error: 'Not found' });
    const url = req.body?.url; if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return reply.status(400).send({ error: 'Enter a link starting with http:// or https://' });
    const res = await readLink(url);
    if (!res.ok || !res.text) return reply.status(422).send({ error: res.error ?? 'Could not read that link.' });
    const id = uuidv4(); const r = addKnowledge(req.params.id, { id, kind: 'link', title: res.title || new URL(res.finalUrl ?? url).hostname, source: res.finalUrl ?? url, text: res.text });
    return r.ok ? { id, title: res.title, chars: res.text.length, truncated: !!res.truncated } : reply.status(413).send({ error: r.error });
  });

  app.get<{ Params: { id: string; kid: string } }>('/api/projects/:id/knowledge/:kid', async (req, reply) => {
    const row = getDb().prepare('SELECT id, kind, title, source, text FROM project_knowledge WHERE id=? AND project_id=?').get(req.params.kid, req.params.id);
    return row ?? reply.status(404).send({ error: 'Not found' });
  });

  app.delete<{ Params: { id: string; kid: string } }>('/api/projects/:id/knowledge/:kid', async (req, reply) => {
    const r = getDb().prepare('DELETE FROM project_knowledge WHERE id=? AND project_id=?').run(req.params.kid, req.params.id);
    return r.changes ? { ok: true } : reply.status(404).send({ error: 'Not found' });
  });
}
