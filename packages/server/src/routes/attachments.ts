import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { createWriteStream, mkdirSync, statSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR, getDb } from '../db/index.js';
import { extractText } from '../attachments/extract.js';

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
    const ex = extractText(path, original, data.mimetype, size);
    getDb().prepare('INSERT INTO attachments(id,conversation_id,filename,mimetype,size,path,extracted_text) VALUES(?,?,?,?,?,?,?)')
      .run(id, null, original, data.mimetype, size, path, ex.text);
    return { id, filename: original, mimetype: data.mimetype, size, extracted: ex.extracted, truncated: ex.truncated, note: ex.reason ?? null, preview: ex.text.slice(0, 200) };
  });

  app.get<{ Params: { id: string } }>('/api/attachments/:id', async (req, reply) => {
    const a = getDb().prepare('SELECT id,filename,mimetype,size,conversation_id,created_at,length(extracted_text) as extracted_chars FROM attachments WHERE id=?').get(req.params.id);
    return a ?? reply.status(404).send({ error: 'Not found' });
  });
}
