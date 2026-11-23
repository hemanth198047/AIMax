import type { FastifyInstance } from 'fastify';
import { clearCaptures, putCapture } from '../web/captures.js';

/**
 * Pages the USER copied from their own browser (where they are already signed in) and pasted into AImax.
 * AImax never controls a browser, never sees a login, and only stores what the user explicitly pasted (24 h, local).
 */
export async function webRoutes(app: FastifyInstance) {
  const guard = (req: { headers: Record<string, unknown> }) => req.headers['x-aimax-ui'] === '1';
  app.post<{ Body: { url?: unknown; text?: unknown; title?: unknown } }>('/api/web/capture', async (req, reply) => {
    if (!guard(req)) return reply.status(403).send({ error: 'Must be started from the AImax UI' });
    const { url, text, title } = req.body ?? {};
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return reply.status(400).send({ error: 'url must be an http(s) link' });
    if (typeof text !== 'string' || text.trim().length < 40) return reply.status(422).send({ error: 'There is almost no text. On the page press Ctrl+A then Ctrl+C, then paste here.' });
    const clean = text.replace(/\u0000/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 200_000);
    putCapture([url], typeof title === 'string' ? title.slice(0, 200) : '', clean);
    return { ok: true, chars: clean.length };
  });
  app.delete('/api/web/captures', async (req, reply) => {
    if (!guard(req)) return reply.status(403).send({ error: 'Must be started from the AImax UI' });
    return { removedCapturedPages: clearCaptures() };
  });
}
