import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { updateRow } from '../db/update.js';

export async function tasksRoutes(app: FastifyInstance) {
  app.get('/api/tasks', async (req) => {
    const { project_id, person_id, status } = req.query as Record<string, string>;
    const db = getDb();
    let sql = 'SELECT * FROM tasks WHERE 1=1';
    const args: unknown[] = [];
    if (project_id) { sql += ' AND project_id=?'; args.push(project_id); }
    if (person_id) { sql += ' AND person_id=?'; args.push(person_id); }
    if (status) { sql += ' AND status=?'; args.push(status); }
    sql += ' ORDER BY created_at DESC';
    return db.prepare(sql).all(...args);
  });

  app.post<{ Body: Record<string, unknown> }>('/api/tasks', async (req) => {
    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();
    const { title, description = '', project_id = null, person_id = null,
      conversation_id = null, status = 'pending', priority = 'medium', due_date = '' } = req.body as Record<string, unknown>;
    db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      id, title, description, project_id, person_id, conversation_id, status, priority, due_date, now, now
    );
    return db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/tasks/:id', async (req, reply) => {
    const row = updateRow('tasks', req.params.id, req.body);
    if (row === 'empty') return reply.status(400).send({ error: 'No updatable fields supplied' });
    if (!row) return reply.status(404).send({ error: 'Not found' });
    return row;
  });

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const r = getDb().prepare('DELETE FROM tasks WHERE id=?').run(req.params.id);
    if (!r.changes) return reply.status(404).send({ error: 'Not found' });
    return { deleted: true };
  });
}
