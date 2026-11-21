import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';

// Phase 13: Discovery Ledger, DecisionVault, Solution Replay, Failure Memory, Task Fingerprinting

export async function knowledgeRoutes(app: FastifyInstance) {

  // ─── Discovery Ledger ───────────────────────────────────────────────
  app.get('/api/discoveries', async (req) => {
    const { project_id, type, q } = req.query as Record<string, string>;
    const db = getDb();
    let sql = 'SELECT * FROM discoveries WHERE 1=1';
    const args: unknown[] = [];
    if (project_id) { sql += ' AND project_id=?'; args.push(project_id); }
    if (type) { sql += ' AND type=?'; args.push(type); }
    if (q) { sql += ' AND (name LIKE ? OR description LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
    sql += ' ORDER BY updated_at DESC LIMIT 100';
    return db.prepare(sql).all(...args);
  });

  app.post<{ Body: Record<string, unknown> }>('/api/discoveries', async (req) => {
    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();
    const { project_id, type = 'feature', name, description = '', location = '', metadata = '{}' } = req.body as Record<string, unknown>;
    db.prepare('INSERT INTO discoveries VALUES(?,?,?,?,?,?,?,?)').run(id, project_id ?? null, type, name, description, location, typeof metadata === 'string' ? metadata : JSON.stringify(metadata), now);
    return db.prepare('SELECT * FROM discoveries WHERE id=?').get(id);
  });

  app.delete<{ Params: { id: string } }>('/api/discoveries/:id', async (req, reply) => {
    const r = getDb().prepare('DELETE FROM discoveries WHERE id=?').run(req.params.id);
    if (!r.changes) return reply.status(404).send({ error: 'Not found' });
    return { deleted: true };
  });

  // ─── DecisionVault ──────────────────────────────────────────────────
  app.get('/api/decisions', async (req) => {
    const { project_id, status, q } = req.query as Record<string, string>;
    const db = getDb();
    let sql = 'SELECT * FROM decisions WHERE 1=1';
    const args: unknown[] = [];
    if (project_id) { sql += ' AND project_id=?'; args.push(project_id); }
    if (status) { sql += ' AND status=?'; args.push(status); }
    if (q) { sql += ' AND (title LIKE ? OR rationale LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
    sql += ' ORDER BY created_at DESC LIMIT 100';
    return db.prepare(sql).all(...args);
  });

  app.post<{ Body: Record<string, unknown> }>('/api/decisions', async (req) => {
    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();
    const { project_id = null, person_id = null, title, rationale = '', alternatives = '[]',
      tradeoffs = '', status = 'active', supersedes = null } = req.body as Record<string, unknown>;
    db.prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      id, project_id, person_id, title, rationale,
      typeof alternatives === 'string' ? alternatives : JSON.stringify(alternatives),
      tradeoffs, status, supersedes ?? null, now
    );
    if (supersedes) {
      db.prepare("UPDATE decisions SET status='superseded' WHERE id=?").run(supersedes);
    }
    return db.prepare('SELECT * FROM decisions WHERE id=?').get(id);
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/decisions/:id', async (req) => {
    const db = getDb();
    const updates = { ...req.body };
    const keys = Object.keys(updates);
    if (keys.length) db.prepare(`UPDATE decisions SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(updates), req.params.id);
    return db.prepare('SELECT * FROM decisions WHERE id=?').get(req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/api/decisions/:id', async (req, reply) => {
    const r = getDb().prepare('DELETE FROM decisions WHERE id=?').run(req.params.id);
    if (!r.changes) return reply.status(404).send({ error: 'Not found' });
    return { deleted: true };
  });

  // ─── Solution Replay ────────────────────────────────────────────────
  app.get('/api/solutions', async (req) => {
    const { project_id, q } = req.query as Record<string, string>;
    const db = getDb();
    let sql = 'SELECT * FROM solutions WHERE 1=1';
    const args: unknown[] = [];
    if (project_id) { sql += ' AND project_id=?'; args.push(project_id); }
    if (q) { sql += ' AND (problem LIKE ? OR fix LIKE ? OR tags LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    sql += ' ORDER BY verified_at DESC LIMIT 50';
    return db.prepare(sql).all(...args);
  });

  app.post<{ Body: Record<string, unknown> }>('/api/solutions', async (req) => {
    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();
    const { project_id = null, problem, root_cause = '', fix, files_changed = '[]',
      test_evidence = '', environment = '{}', tags = '[]' } = req.body as Record<string, unknown>;
    db.prepare('INSERT INTO solutions VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      id, project_id,
      problem, root_cause, fix,
      typeof files_changed === 'string' ? files_changed : JSON.stringify(files_changed),
      test_evidence,
      typeof environment === 'string' ? environment : JSON.stringify(environment),
      typeof tags === 'string' ? tags : JSON.stringify(tags),
      now
    );
    return db.prepare('SELECT * FROM solutions WHERE id=?').get(id);
  });

  app.delete<{ Params: { id: string } }>('/api/solutions/:id', async (req, reply) => {
    const r = getDb().prepare('DELETE FROM solutions WHERE id=?').run(req.params.id);
    if (!r.changes) return reply.status(404).send({ error: 'Not found' });
    return { deleted: true };
  });

  // ─── Failure Memory ─────────────────────────────────────────────────
  app.get('/api/failures', async (req) => {
    const { project_id, q } = req.query as Record<string, string>;
    const db = getDb();
    let sql = 'SELECT * FROM failures WHERE 1=1';
    const args: unknown[] = [];
    if (project_id) { sql += ' AND project_id=?'; args.push(project_id); }
    if (q) { sql += ' AND (approach LIKE ? OR reason LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
    sql += ' ORDER BY created_at DESC LIMIT 50';
    return db.prepare(sql).all(...args);
  });

  app.post<{ Body: Record<string, unknown> }>('/api/failures', async (req) => {
    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();
    const { project_id = null, approach, reason, context = '', tags = '[]' } = req.body as Record<string, unknown>;
    db.prepare('INSERT INTO failures VALUES(?,?,?,?,?,?,?)').run(
      id, project_id ?? null, approach, reason, context,
      typeof tags === 'string' ? tags : JSON.stringify(tags),
      now
    );
    return db.prepare('SELECT * FROM failures WHERE id=?').get(id);
  });

  // ─── Task Fingerprinting (check for duplicate/similar tasks) ────────
  app.post<{ Body: { intent: string; project_id?: string } }>('/api/fingerprint', async (req) => {
    const db = getDb();
    const { intent, project_id } = req.body;
    const q = intent.slice(0, 100);

    // FTS search across memory, solutions, decisions
    const memMatches = db.prepare(`
      SELECT 'memory' as source, title, content FROM memory_entries
      WHERE ${project_id ? "project_id=? AND " : ""}(title LIKE ? OR content LIKE ?)
      LIMIT 3`).all(...(project_id ? [project_id] : []), `%${q}%`, `%${q}%`) as Array<{ source: string; title: string; content: string }>;

    const solMatches = db.prepare(`
      SELECT 'solution' as source, problem as title, fix as content FROM solutions
      WHERE ${project_id ? "project_id=? AND " : ""}(problem LIKE ? OR fix LIKE ?)
      LIMIT 3`).all(...(project_id ? [project_id] : []), `%${q}%`, `%${q}%`) as Array<{ source: string; title: string; content: string }>;

    const failMatches = db.prepare(`
      SELECT 'failure' as source, approach as title, reason as content FROM failures
      WHERE ${project_id ? "project_id=? AND " : ""}(approach LIKE ? OR reason LIKE ?)
      LIMIT 2`).all(...(project_id ? [project_id] : []), `%${q}%`, `%${q}%`) as Array<{ source: string; title: string; content: string }>;

    return {
      query: intent,
      existing_work: [...memMatches, ...solMatches, ...failMatches],
      has_prior_work: memMatches.length + solMatches.length + failMatches.length > 0
    };
  });
}
