import type { FastifyInstance } from 'fastify';
import { checkClaudeAvailable } from '../providers/claude.js';
import { testProviderEnabled } from '../providers/test.js';
import { checkOllamaAvailable, listOllamaModels } from '../providers/ollama.js';

export async function providersRoutes(app: FastifyInstance) {
  app.get('/api/providers/status', async () => {
    const [claudeOk, ollamaOk] = await Promise.all([
      checkClaudeAvailable(),
      checkOllamaAvailable()
    ]);
    const ollamaModels = ollamaOk ? await listOllamaModels() : [];
    return {
      claude: { available: claudeOk, interface: 'claude-code-cli', version: '2.1.330' },
      cursor: { available: false, interface: 'cursor-cli', version: '3.27.22' },
      ollama: { available: ollamaOk, interface: 'http-api', models: ollamaModels.map(m => m.name) },
      freellmapi: { available: false, interface: 'electron-app', port: 31415 },
      ...(testProviderEnabled() ? { test: { available: true, interface: 'deterministic (tests only)' } } : {})
    };
  });
}
