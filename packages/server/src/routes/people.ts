import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';

export async function peopleRoutes(app: FastifyInstance) {
  app.get('/api/people', async () => getDb().prepare('SELECT * FROM people ORDER BY display_name').all());

  app.get<{ Params: { id: string } }>('/api/people/:id', async (req, reply) => {
    const p = getDb().prepare('SELECT * FROM people WHERE id=?').get(req.params.id);
    if (!p) return reply.status(404).send({ error: 'Not found' });
    return p;
  });

  app.post<{ Body: Record<string, string> }>('/api/people', async (req) => {
    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();
    const { display_name, preferred_name = '', role = '', organization = '',
      relationship = '', notes = '', privacy = 'local_only' } = req.body;
    const tags = typeof req.body.tags === 'string' ? req.body.tags : '[]';
    db.prepare(`INSERT INTO people VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, display_name, preferred_name, role, organization, relationship, notes, tags, privacy, now, now
    );
    return db.prepare('SELECT * FROM people WHERE id=?').get(id);
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/people/:id', async (req, reply) => {
    const db = getDb();
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    const keys = Object.keys(updates);
    if (!keys.length) return reply.status(400).send({ error: 'No fields' });
    db.prepare(`UPDATE people SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(updates), req.params.id);
    return db.prepare('SELECT * FROM people WHERE id=?').get(req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/api/people/:id', async (req, reply) => {
    const r = getDb().prepare('DELETE FROM people WHERE id=?').run(req.params.id);
    if (!r.changes) return reply.status(404).send({ error: 'Not found' });
    return { deleted: true };
  });

  app.get<{ Params: { id: string } }>('/api/people/:id/projects', async (req) => {
    return getDb().prepare(`
      SELECT p.*, pp.role as person_role FROM projects p
      JOIN project_people pp ON pp.project_id = p.id
      WHERE pp.person_id = ?`).all(req.params.id);
  });
}
