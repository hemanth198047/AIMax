import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { searchMemory, listMemory } from '../memory/search.js';

export async function memoryRoutes(app: FastifyInstance) {
  app.get('/api/memory', async (req) => {
    const { q, project_id, person_id, type, limit = '20' } = req.query as Record<string, string>;
    const ctx = { projectId: project_id || null, personId: person_id || null };
    const lim = parseInt(limit) || 20;
    return q ? searchMemory(q, ctx, lim) : listMemory(ctx, lim, type || undefined);
  });

  app.post<{ Body: Record<string, unknown> }>('/api/memory', async (req) => {
    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();
    const { scope = 'global', project_id = null, person_id = null, type = 'note',
      title, content, provenance = 'user_provided', confidence = 1.0 } = req.body as Record<string, unknown>;
    const tags = typeof req.body.tags === 'string' ? req.body.tags : JSON.stringify(req.body.tags ?? []);
    db.prepare(`INSERT INTO memory_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, scope, project_id, person_id, type, title, content, provenance, confidence, tags, null, now, now
    );
    return db.prepare('SELECT * FROM memory_entries WHERE id=?').get(id);
  });

  app.delete<{ Params: { id: string } }>('/api/memory/:id', async (req, reply) => {
    const r = getDb().prepare('DELETE FROM memory_entries WHERE id=?').run(req.params.id);
    if (!r.changes) return reply.status(404).send({ error: 'Not found' });
    return { deleted: true };
  });
}
