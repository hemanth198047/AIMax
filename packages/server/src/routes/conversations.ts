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

  /**
   * Deterministic continuity summary (no model call): lets you or another assistant pick the work up elsewhere.
   * It only quotes what is stored — user asks, the latest answer, attachments, linked tasks — and says what it leaves out.
   */
  app.get<{ Params: { id: string } }>('/api/conversations/:id/handoff', async (req, reply) => {
    const conv = visibleConversation(req.params.id, ctxOf(req));
    if (!conv) return reply.status(404).send({ error: 'Not found' });
    const db = getDb();
    const msgs = db.prepare('SELECT role,content,provider,attachments,created_at FROM messages WHERE conversation_id=? ORDER BY created_at').all(conv.id) as
      { role: string; content: string; provider: string; attachments: string; created_at: string }[];
    const one = (t: string, n: number) => { const x = t.replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
    const users = msgs.filter(m => m.role === 'user'); const lastA = [...msgs].reverse().find(m => m.role === 'assistant');
    const files = new Map<string, number>();
    for (const m of users) { try { for (const a of JSON.parse(m.attachments || '[]') as { filename: string; size: number }[]) files.set(a.filename, a.size); } catch { /* ignore */ } }
    const tasks = db.prepare("SELECT title,status FROM tasks WHERE conversation_id=? ORDER BY created_at").all(conv.id) as { title: string; status: string }[];
    const providers = [...new Set(msgs.filter(m => m.role === 'assistant' && m.provider).map(m => m.provider))];
    const project = conv.project_id ? (db.prepare('SELECT name FROM projects WHERE id=?').get(conv.project_id) as { name: string } | undefined)?.name : undefined;
    const person = conv.person_id ? (db.prepare('SELECT display_name FROM people WHERE id=?').get(conv.person_id) as { display_name: string } | undefined)?.display_name : undefined;
    const SHOW = 12;
    const md = [
      `# Handoff: ${conv.title}`,
      `- Context: ${conv.scope}${project ? ` · project "${project}"` : ''}${person ? ` · person "${person}"` : ''}`,
      `- ${msgs.length} messages (${users.length} from you), last activity ${conv.updated_at}${providers.length ? ` · answered by ${providers.join(', ')}` : ''}`,
      '', '## What was asked (in order)',
      ...(users.length > SHOW ? [`- … ${users.length - SHOW} earlier requests omitted`] : []),
      ...users.slice(-SHOW).map(m => `- ${one(m.content, 240)}`),
      ...(lastA ? ['', '## Latest answer (excerpt)', `> ${one(lastA.content, 900)}`] : []),
      ...(files.size ? ['', '## Files attached', ...[...files].map(([n, sz]) => `- ${n} (${sz} bytes)`)] : []),
      ...(tasks.length ? ['', '## Tasks linked to this chat', ...tasks.map(t => `- [${t.status}] ${t.title}`)] : []),
      '', '---',
      'Generated from stored messages only, without a model. Decisions, command output and anything not typed in this chat are not included; verify before relying on it.',
    ].join('\n');
    return { conversation_id: conv.id, markdown: md, messages: msgs.length };
  });
}
