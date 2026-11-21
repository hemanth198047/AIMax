import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { getDb } from '../db/index.js';

// Phase 25: DesignIQ — Unslop/pixelslop integration
const PIXELSLOP_BIN = join('D:', 'ProjectsPortfolio', 'pixelslop', 'bin', 'pixelslop.mjs');

export async function designiqRoutes(app: FastifyInstance) {
  app.get('/api/designiq/status', async () => {
    const available = existsSync(PIXELSLOP_BIN);
    return {
      available,
      pixelslop_path: PIXELSLOP_BIN,
      interface: 'pixelslop CLI',
      capabilities: available ? ['audit', 'scan', 'fix', 'compare', 'visual-regression'] : []
    };
  });

  // Design system memory
  app.get('/api/designiq/system', async (req) => {
    const { project_id } = req.query as Record<string, string>;
    const db = getDb();
    return db.prepare(`
      SELECT * FROM design_entries
      WHERE ${project_id ? 'project_id=?' : '1=1'}
      ORDER BY updated_at DESC`).all(...(project_id ? [project_id] : []));
  });

  app.post<{ Body: Record<string, unknown> }>('/api/designiq/system', async (req) => {
    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();
    const { project_id = null, type, name, value, notes = '', approved = 1 } = req.body as Record<string, unknown>;
    db.prepare('INSERT INTO design_entries VALUES(?,?,?,?,?,?,?,?)').run(id, project_id, type, name, value, notes, approved ? 1 : 0, now);
    return db.prepare('SELECT * FROM design_entries WHERE id=?').get(id);
  });

  app.delete<{ Params: { id: string } }>('/api/designiq/system/:id', async (req, reply) => {
    const r = getDb().prepare('DELETE FROM design_entries WHERE id=?').run(req.params.id);
    if (!r.changes) return reply.status(404).send({ error: 'Not found' });
    return { deleted: true };
  });

  // Run pixelslop audit on a URL
  app.post<{ Body: { url: string; project_id?: string } }>('/api/designiq/audit', async (req, reply) => {
    if (!existsSync(PIXELSLOP_BIN)) {
      return reply.status(503).send({ error: 'pixelslop not found at ' + PIXELSLOP_BIN });
    }
    const { url, project_id } = req.body;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('start', { url });

    try {
      // pixelslop is a Claude Code skill, invoke via node
      const proc = spawn('node', [PIXELSLOP_BIN, 'status'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      let output = '';
      proc.stdout.on('data', (c: Buffer) => { output += c.toString(); send('chunk', { text: c.toString() }); });
      proc.stderr.on('data', (c: Buffer) => send('chunk', { text: c.toString() }));
      proc.on('close', (code) => {
        send('done', { exitCode: code, output: output.slice(0, 5000) });
        reply.raw.end();
      });
    } catch (err) {
      send('error', { message: err instanceof Error ? err.message : String(err) });
      reply.raw.end();
    }
  });

  // Audit cache
  app.get('/api/designiq/audits', async (req) => {
    const { project_id } = req.query as Record<string, string>;
    const db = getDb();
    return db.prepare(`
      SELECT * FROM design_audits
      WHERE ${project_id ? 'project_id=?' : '1=1'}
      ORDER BY created_at DESC LIMIT 20`).all(...(project_id ? [project_id] : []));
  });

  app.post<{ Body: Record<string, unknown> }>('/api/designiq/audits', async (req) => {
    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();
    const { project_id = null, url, score, findings = '[]', screenshot_path = '' } = req.body as Record<string, unknown>;
    db.prepare('INSERT INTO design_audits VALUES(?,?,?,?,?,?,?)').run(
      id, project_id, url, score, typeof findings === 'string' ? findings : JSON.stringify(findings), screenshot_path, now
    );
    return db.prepare('SELECT * FROM design_audits WHERE id=?').get(id);
  });
}
