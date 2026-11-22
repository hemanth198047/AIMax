import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { updateRow } from '../db/update.js';

export async function projectsRoutes(app: FastifyInstance) {
  app.get('/api/projects', async () => {
    return getDb().prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
  });

  /** One-screen summary of a project: activity, memory, tasks, decisions, people and 30-day token use. Project-scoped rows only. */
  app.get<{ Params: { id: string } }>('/api/projects/:id/overview', async (req, reply) => {
    const db = getDb(); const id = req.params.id;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!project) return reply.status(404).send({ error: 'Not found' });
    const n = (sql: string) => (db.prepare(sql).get(id) as { n: number }).n;
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    return {
      project,
      counts: {
        conversations: n("SELECT COUNT(*) n FROM conversations WHERE project_id=? AND archived=0"),
        messages: n("SELECT COUNT(*) n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id=?)"),
        memory: n("SELECT COUNT(*) n FROM memory_entries WHERE project_id=?"),
        decisions: n("SELECT COUNT(*) n FROM decisions WHERE project_id=?"),
      },
      tasks: db.prepare("SELECT status, COUNT(*) n FROM tasks WHERE project_id=? GROUP BY status").all(id),
      openTasks: db.prepare("SELECT id,title,priority,status,due_date FROM tasks WHERE project_id=? AND status NOT IN ('done','completed','cancelled') ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, due_date='' , due_date LIMIT 8").all(id),
      people: db.prepare("SELECT p.id, p.display_name AS name, pp.role FROM project_people pp JOIN people p ON p.id=pp.person_id WHERE pp.project_id=? ORDER BY p.display_name").all(id),
      recentConversations: db.prepare("SELECT id,title,provider,updated_at FROM conversations WHERE project_id=? AND archived=0 ORDER BY updated_at DESC LIMIT 5").all(id),
      recentDecisions: db.prepare("SELECT id,title,status FROM decisions WHERE project_id=? ORDER BY rowid DESC LIMIT 5").all(id),
      tokens30d: db.prepare("SELECT provider, COUNT(*) requests, SUM(COALESCE(reported_in, input_chars/4)) tokensIn, SUM(COALESCE(reported_out, output_chars/4)) tokensOut FROM usage_events WHERE project_id=? AND ok=1 AND ts>=? GROUP BY provider ORDER BY requests DESC").all(id, since),
    };
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
