import { claudeChat, checkClaudeAvailable, type ChatMessage } from './claude.js';
import { ollamaChat, checkOllamaAvailable, listOllamaModels } from './ollama.js';
import { testChat, testProviderEnabled } from './test.js';

export interface ChatRequest {
  messages: ChatMessage[];
  system: string;
  provider: string;
  claudeSessionId?: string | null;
  signal?: AbortSignal;
}
export interface ChatOutcome { text: string; provider: string; model: string; claudeSessionId?: string | null; resumed?: boolean }

export async function autoChat(req: ChatRequest, onChunk: (text: string) => void): Promise<ChatOutcome> {
  const { messages, system, provider: preferred, signal } = req;

  if (preferred === 'test' && testProviderEnabled()) {
    return { text: await testChat(messages, system, onChunk, signal), provider: 'test', model: 'deterministic' };
  }

  if (preferred === 'claude' || preferred === 'auto') {
    if (await checkClaudeAvailable()) {
      const r = await claudeChat(messages, system, onChunk, { sessionId: req.claudeSessionId, signal });
      return { text: r.text, provider: 'claude', model: 'claude-code', claudeSessionId: r.sessionId, resumed: r.resumed };
    }
    if (preferred === 'claude') throw new Error('Claude Code CLI is not available. Ensure `claude` is in your PATH (or set AIMAX_CLAUDE_BIN).');
  }

  if (preferred === 'ollama' || preferred === 'auto') {
    if (await checkOllamaAvailable()) {
      const models = await listOllamaModels();
      if (models.length > 0) {
        const model = models[0].name;
        const text = await ollamaChat(model, [{ role: 'system', content: system }, ...messages], onChunk, signal);
        return { text, provider: 'ollama', model };
      }
    }
    if (preferred === 'ollama') throw new Error('Ollama is not running. Start it with: ollama serve');
  }

  throw new Error('No AI provider available. Claude Code CLI or Ollama must be running.\n• Claude: ensure `claude` is in PATH and authenticated\n• Ollama: run `ollama serve` to start');
}
