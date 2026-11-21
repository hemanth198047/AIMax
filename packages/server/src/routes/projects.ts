import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { updateRow } from '../db/update.js';

export async function projectsRoutes(app: FastifyInstance) {
  app.get('/api/projects', async () => {
    return getDb().prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const p = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!p) return reply.status(404).send({ error: 'Not found' });
    return p;
  });

  app.post<{ Body: Record<string, unknown> }>('/api/projects', async (req) => {
    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();
    const b = req.body as Record<string, string>;
    const { name, description = '', category = 'software', status = 'active',
      priority = 'medium', repo_path = '', instructions = '', provider = 'auto', privacy = 'local_only' } = b;
    const tags = typeof b.tags === 'string' ? b.tags : JSON.stringify(b.tags ?? []);
    const tech_stack = typeof b.tech_stack === 'string' ? b.tech_stack : JSON.stringify(b.tech_stack ?? []);
    db.prepare(`INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, name, description, category, status, priority, tags, repo_path, tech_stack, instructions, provider, privacy, now, now
    );
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/projects/:id', async (req, reply) => {
    const row = updateRow('projects', req.params.id, req.body);
    if (row === 'empty') return reply.status(400).send({ error: 'No updatable fields supplied' });
    if (!row) return reply.status(404).send({ error: 'Not found' });
    return row;
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const r = getDb().prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    if (!r.changes) return reply.status(404).send({ error: 'Not found' });
    return { deleted: true };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/people', async (req) => {
    return getDb().prepare(`
      SELECT p.*, pp.role as project_role, pp.notes as project_notes
      FROM people p JOIN project_people pp ON pp.person_id = p.id
      WHERE pp.project_id = ?`).all(req.params.id);
  });

  app.post<{ Params: { id: string }; Body: { person_id: string; role?: string } }>('/api/projects/:id/people', async (req) => {
    const { person_id, role = 'contributor' } = req.body;
    getDb().prepare('INSERT OR REPLACE INTO project_people (id,project_id,person_id,role) VALUES (?,?,?,?)').run(uuidv4(), req.params.id, person_id, role);
    return { linked: true };
  });

  app.delete<{ Params: { id: string; person_id: string } }>('/api/projects/:id/people/:person_id', async (req) => {
    getDb().prepare('DELETE FROM project_people WHERE project_id=? AND person_id=?').run(req.params.id, req.params.person_id);
    return { unlinked: true };
  });
}
