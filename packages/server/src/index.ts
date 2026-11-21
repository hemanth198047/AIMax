import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { homedir } from 'os';

import { projectsRoutes } from './routes/projects.js';
import { peopleRoutes } from './routes/people.js';
import { conversationsRoutes } from './routes/conversations.js';
import { memoryRoutes } from './routes/memory.js';
import { tasksRoutes } from './routes/tasks.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { chatRoutes } from './routes/chat.js';
import { providersRoutes } from './routes/providers.js';

const PORT = parseInt(process.env.PORT ?? '3001');
const UPLOADS_DIR = join(homedir(), 'AppData', 'Roaming', 'aimax', 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

const app = Fastify({ logger: { level: 'info' } });

await app.register(cors, {
  origin: ['http://localhost:5173', 'http://localhost:4173', 'http://localhost:3001']
});
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

app.get('/api/health', async () => ({
  status: 'ok',
  version: '0.1.0',
  timestamp: new Date().toISOString()
}));

await app.register(projectsRoutes);
await app.register(peopleRoutes);
await app.register(conversationsRoutes);
await app.register(memoryRoutes);
await app.register(tasksRoutes);
await app.register(sandboxRoutes);
await app.register(chatRoutes);
await app.register(providersRoutes);

// File upload endpoint
app.post('/api/attachments/upload', async (req, reply) => {
  const data = await req.file();
  if (!data) return reply.status(400).send({ error: 'No file' });
  const { v4: uuidv4 } = await import('uuid');
  const id = uuidv4();
  const safeName = data.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = join(UPLOADS_DIR, `${id}-${safeName}`);
  const { createWriteStream } = await import('fs');
  const ws = createWriteStream(filePath);
  await new Promise<void>((resolve, reject) => {
    data.file.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
  return { id, filename: data.filename, path: filePath, mimetype: data.mimetype, size: data.file.bytesRead };
});

try {
  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`\n  AImax server running at http://localhost:${PORT}\n`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
