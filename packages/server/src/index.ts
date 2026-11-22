import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';

import { projectsRoutes } from './routes/projects.js';
import { peopleRoutes } from './routes/people.js';
import { conversationsRoutes } from './routes/conversations.js';
import { memoryRoutes } from './routes/memory.js';
import { tasksRoutes } from './routes/tasks.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { agentRoutes } from './routes/agent.js';
import { importRoutes } from './routes/import.js';
import { chatRoutes } from './routes/chat.js';
import { providersRoutes } from './routes/providers.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { linkVaultRoutes } from './routes/linkvault.js';
import { designiqRoutes } from './routes/designiq.js';
import { mcpRoutes } from './mcp/server.js';
import { attachmentsRoutes } from './routes/attachments.js';

const PORT = parseInt(process.env.PORT ?? '3001');

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
await app.register(agentRoutes);
await app.register(importRoutes);
await app.register(chatRoutes);
await app.register(providersRoutes);
await app.register(knowledgeRoutes);
await app.register(linkVaultRoutes);
await app.register(designiqRoutes);
await app.register(mcpRoutes);
await app.register(attachmentsRoutes);

try {
  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`\n  AImax server running at http://localhost:${PORT}\n`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
