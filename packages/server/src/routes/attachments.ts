import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { createWriteStream, mkdirSync, statSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR, getDb } from '../db/index.js';
import { visibleConversation } from '../memory/projectScope.js';
import { extractAttachment } from '../attachments/extract.js';

export const UPLOADS_DIR = join(DATA_DIR, 'uploads');

export async function attachmentsRoutes(app: FastifyInstance) {
  mkdirSync(UPLOADS_DIR, { recursive: true });

  app.post('/api/attachments/upload', async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.status(400).send({ error: 'No file' });
    const id = uuidv4();
    const original = basename(data.filename).slice(0, 200) || 'file';
    const safeName = original.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = join(UPLOADS_DIR, `${id}-${safeName}`);
    await pipeline(data.file, createWriteStream(path));
    if (data.file.truncated) { rmSync(path, { force: true }); return reply.status(413).send({ error: 'File too large (50 MB limit)' }); }
    const size = statSync(path).size;
    const ex = await extractAttachment(path, original, data.mimetype, size);
    getDb().prepare('INSERT INTO attachments(id,conversation_id,filename,mimetype,size,path,extracted_text) VALUES(?,?,?,?,?,?,?)')
      .run(id, null, original, data.mimetype, size, path, ex.text);
    return { id, filename: original, mimetype: data.mimetype, size, extracted: ex.extracted, truncated: ex.truncated, note: ex.reason ?? null, kind: ex.kind ?? null, preview: ex.text.slice(0, 200) };
  });

  // Attachments bound to a conversation follow that conversation's visibility; unbound (just uploaded) ones are readable.
  const lookup = (id: string, q: Record<string, string>) => {
    const a = getDb().prepare('SELECT id,filename,mimetype,size,conversation_id,created_at,extracted_text FROM attachments WHERE id=?').get(id) as
      { id: string; conversation_id: string | null; extracted_text: string } & Record<string, unknown> | undefined;
    if (!a) return undefined;
    if (a.conversation_id && !visibleConversation(a.conversation_id, { projectId: q.project_id, personId: q.person_id })) return undefined;
    return a;
  };

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/attachments/:id', async (req, reply) => {
    const a = lookup(req.params.id, req.query);
    if (!a) return reply.status(404).send({ error: 'Not found' });
    const { extracted_text, ...meta } = a;
    return { ...meta, extracted_chars: extracted_text.length };
  });

  /** Text the model would be given for this file (for the preview in the UI). */
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/attachments/:id/text', async (req, reply) => {
    const a = lookup(req.params.id, req.query);
    if (!a) return reply.status(404).send({ error: 'Not found' });
    return { id: a.id, filename: a.filename, text: a.extracted_text, readable: a.extracted_text.length > 0 };
  });
}
