import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';

export async function memoryRoutes(app: FastifyInstance) {
  app.get('/api/memory', async (req) => {
    const { q, scope, project_id, person_id, type, limit = '20' } = req.query as Record<string, string>;
    const db = getDb();
    const lim = Math.min(parseInt(limit) || 20, 100);

    if (q) {
      let sql = `SELECT m.* FROM memory_entries m
        JOIN memory_fts f ON f.rowid = m.rowid
        WHERE memory_fts MATCH ?`;
      const args: unknown[] = [q];
      if (scope) { sql += ' AND m.scope=?'; args.push(scope); }
      if (project_id) { sql += ' AND (m.project_id IS NULL OR m.project_id=?)'; args.push(project_id); }
      if (person_id) { sql += ' AND (m.person_id IS NULL OR m.person_id=?)'; args.push(person_id); }
      sql += ' ORDER BY rank LIMIT ?';
      args.push(lim);
      return db.prepare(sql).all(...args);
    }

    let sql = 'SELECT * FROM memory_entries WHERE 1=1';
    const args: unknown[] = [];
    if (scope) { sql += ' AND scope=?'; args.push(scope); }
    if (project_id) { sql += ' AND project_id=?'; args.push(project_id); }
    if (person_id) { sql += ' AND person_id=?'; args.push(person_id); }
    if (type) { sql += ' AND type=?'; args.push(type); }
    sql += ' ORDER BY updated_at DESC LIMIT ?';
    args.push(lim);
    return db.prepare(sql).all(...args);
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
    db.prepare('INSERT INTO memory_fts(rowid,title,content,tags) SELECT rowid,title,content,tags FROM memory_entries WHERE id=?').run(id);
    return db.prepare('SELECT * FROM memory_entries WHERE id=?').get(id);
  });

  app.delete<{ Params: { id: string } }>('/api/memory/:id', async (req, reply) => {
    const db = getDb();
    const entry = db.prepare('SELECT rowid FROM memory_entries WHERE id=?').get(req.params.id) as { rowid: number } | undefined;
    if (!entry) return reply.status(404).send({ error: 'Not found' });
    db.prepare(`INSERT INTO memory_fts(memory_fts,rowid,title,content,tags) VALUES('delete',?,?,?,?)`).run(entry.rowid, '', '', '');
    db.prepare('DELETE FROM memory_entries WHERE id=?').run(req.params.id);
    return { deleted: true };
  });
}
