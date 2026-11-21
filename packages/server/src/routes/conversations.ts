import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { updateRow } from '../db/update.js';
import { bothClause, visibleConversation } from '../memory/projectScope.js';

export async function conversationsRoutes(app: FastifyInstance) {
  app.get('/api/conversations', async (req) => {
    // Only conversations visible in the active context are listed (same rules as memory).
    const { project_id, person_id, q, archived } = req.query as Record<string, string>;
    const db = getDb();
    const c = bothClause({ projectId: project_id, personId: person_id }, 'c.project_id', 'c.person_id');
    const args: unknown[] = [...c.args];
    let sql = `SELECT c.* FROM conversations c WHERE c.archived=? AND ${c.sql}`;
    args.unshift(archived === '1' ? 1 : 0); // archived flag is the first placeholder
    if (q && q.trim()) {
      const like = `%${q.trim().slice(0, 100).replace(/[\\%_]/g, m => '\\' + m)}%`;
      sql += ` AND (c.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.content LIKE ? ESCAPE '\\'))`;
      args.push(like, like);
    }
    sql += ' ORDER BY c.pinned DESC, c.updated_at DESC LIMIT 200';
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

  // Every by-id route checks the conversation is visible in the caller's context (?project_id=&person_id=).
  const ctxOf = (req: { query: unknown }) => { const q = req.query as Record<string, string>; return { projectId: q.project_id, personId: q.person_id }; };

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/conversations/:id', async (req, reply) => {
    if (!visibleConversation(req.params.id, ctxOf(req))) return reply.status(404).send({ error: 'Not found' });
    const row = updateRow('conversations', req.params.id, req.body);
    if (row === 'empty') return reply.status(400).send({ error: 'No updatable fields supplied' });
    if (!row) return reply.status(404).send({ error: 'Not found' });
    return row;
  });

  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
    if (!visibleConversation(req.params.id, ctxOf(req))) return reply.status(404).send({ error: 'Not found' });
    getDb().prepare('DELETE FROM conversations WHERE id=?').run(req.params.id);
    return { deleted: true };
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/messages', async (req, reply) => {
    if (!visibleConversation(req.params.id, ctxOf(req))) return reply.status(404).send({ error: 'Not found' });
    return getDb().prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at').all(req.params.id);
  });
}
