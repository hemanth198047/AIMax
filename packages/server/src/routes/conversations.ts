import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { updateRow } from '../db/update.js';

export async function conversationsRoutes(app: FastifyInstance) {
  app.get('/api/conversations', async (req) => {
    const { project_id, person_id, scope } = req.query as Record<string, string>;
    const db = getDb();
    let sql = 'SELECT * FROM conversations WHERE archived=0';
    const args: unknown[] = [];
    if (scope) { sql += ' AND scope=?'; args.push(scope); }
    if (project_id) { sql += ' AND project_id=?'; args.push(project_id); }
    if (person_id) { sql += ' AND person_id=?'; args.push(person_id); }
    sql += ' ORDER BY pinned DESC, updated_at DESC';
    return db.prepare(sql).all(...args);
  });

  app.post<{ Body: Record<string, string | null> }>('/api/conversations', async (req) => {
    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();
    const { title = 'New Conversation', scope = 'global', project_id = null, person_id = null, provider = 'auto' } = req.body;
    db.prepare('INSERT INTO conversations(id,title,scope,project_id,person_id,provider,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(
      id, title, scope, project_id, person_id, provider, now, now
    );
    return db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/conversations/:id', async (req, reply) => {
    const row = updateRow('conversations', req.params.id, req.body);
    if (row === 'empty') return reply.status(400).send({ error: 'No updatable fields supplied' });
    if (!row) return reply.status(404).send({ error: 'Not found' });
    return row;
  });

  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
    const r = getDb().prepare('DELETE FROM conversations WHERE id=?').run(req.params.id);
    if (!r.changes) return reply.status(404).send({ error: 'Not found' });
    return { deleted: true };
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/messages', async (req) => {
    return getDb().prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at').all(req.params.id);
  });
}
