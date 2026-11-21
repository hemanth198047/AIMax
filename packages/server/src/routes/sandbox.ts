import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { executeCommand, getSandboxDir, listFiles } from '../sandbox/executor.js';

export async function sandboxRoutes(app: FastifyInstance) {
  app.get('/api/sandbox', async () => {
    return getDb().prepare('SELECT * FROM sandboxes ORDER BY last_used DESC').all();
  });

  app.post<{ Body: { name: string; project_id?: string; mode?: string } }>('/api/sandbox', async (req) => {
    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();
    const { name, project_id = null, mode = 'temporary' } = req.body;
    const workingDir = getSandboxDir(id);
    db.prepare('INSERT INTO sandboxes VALUES(?,?,?,?,?,?,?,?)').run(id, name, project_id, mode, workingDir, 'running', now, now);
    return db.prepare('SELECT * FROM sandboxes WHERE id=?').get(id);
  });

  app.post<{ Params: { id: string }; Body: { command: string; timeout?: number } }>('/api/sandbox/:id/execute', async (req, reply) => {
    const db = getDb();
    const sandbox = db.prepare('SELECT * FROM sandboxes WHERE id=?').get(req.params.id) as { working_dir: string } | undefined;
    if (!sandbox) return reply.status(404).send({ error: 'Sandbox not found' });
    const { command, timeout = 30000 } = req.body;
    db.prepare('UPDATE sandboxes SET last_used=? WHERE id=?').run(new Date().toISOString(), req.params.id);
    return executeCommand(command, sandbox.working_dir, timeout);
  });

  app.get<{ Params: { id: string } }>('/api/sandbox/:id/files', async (req, reply) => {
    const sandbox = getDb().prepare('SELECT * FROM sandboxes WHERE id=?').get(req.params.id) as { working_dir: string } | undefined;
    if (!sandbox) return reply.status(404).send({ error: 'Not found' });
    return listFiles(sandbox.working_dir);
  });

  app.delete<{ Params: { id: string } }>('/api/sandbox/:id', async (req, reply) => {
    const r = getDb().prepare('DELETE FROM sandboxes WHERE id=?').run(req.params.id);
    if (!r.changes) return reply.status(404).send({ error: 'Not found' });
    return { deleted: true };
  });
}
