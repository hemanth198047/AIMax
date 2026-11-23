import type { FastifyInstance } from 'fastify';
import { browserState, captureCurrentPage, closeSignIn, forgetBrowserProfile, openSignIn } from '../web/browser.js';
import { clearCaptures } from '../web/captures.js';

/** Sign-in browser controls. Every action needs the UI header and is started by a click in AImax. */
export async function webRoutes(app: FastifyInstance) {
  const guard = (req: { headers: Record<string, unknown> }) => req.headers['x-aimax-ui'] === '1';
  app.get('/api/web/signin', async () => browserState());
  app.post<{ Body: { url?: unknown } }>('/api/web/signin', async (req, reply) => {
    if (!guard(req)) return reply.status(403).send({ error: 'Must be started from the AImax UI' });
    if (typeof req.body?.url !== 'string') return reply.status(400).send({ error: 'url is required' });
    try { return await openSignIn(req.body.url); } catch (e) { return reply.status(500).send({ error: e instanceof Error ? e.message : String(e) }); }
  });
  app.post<{ Body: { url?: unknown } }>('/api/web/signin/capture', async (req, reply) => {
    if (!guard(req)) return reply.status(403).send({ error: 'Must be started from the AImax UI' });
    if (typeof req.body?.url !== 'string') return reply.status(400).send({ error: 'url is required' });
    try { return await captureCurrentPage(req.body.url); } catch (e) { return reply.status(422).send({ error: e instanceof Error ? e.message : String(e) }); }
  });
  app.delete('/api/web/signin', async (req, reply) => { if (!guard(req)) return reply.status(403).send({ error: 'Must be started from the AImax UI' }); await closeSignIn(); return { ok: true }; });
  app.delete('/api/web/profile', async (req, reply) => {
    if (!guard(req)) return reply.status(403).send({ error: 'Must be started from the AImax UI' });
    return { forgotSignIns: forgetBrowserProfile(), removedCapturedPages: clearCaptures() };
  });
}
