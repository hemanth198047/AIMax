import { claudeChat, checkClaudeAvailable, type ChatMessage } from './claude.js';
import { testChat, testProviderEnabled } from './test.js';
import { ollamaChat, checkOllamaAvailable, listOllamaModels } from './ollama.js';

export async function autoChat(
  messages: ChatMessage[],
  preferredProvider: string,
  onChunk: (text: string) => void
): Promise<{ text: string; provider: string; model: string }> {

  if (preferredProvider === 'test' && testProviderEnabled()) {
    return { text: await testChat(messages, onChunk), provider: 'test', model: 'deterministic' };
  }

  if (preferredProvider === 'claude' || preferredProvider === 'auto') {
    const available = await checkClaudeAvailable();
    if (available) {
      const text = await claudeChat(messages, onChunk);
      return { text, provider: 'claude', model: 'claude-code' };
    }
    if (preferredProvider === 'claude') {
      throw new Error('Claude Code CLI is not available. Ensure `claude` is in your PATH.');
    }
  }

  if (preferredProvider === 'ollama' || preferredProvider === 'auto') {
    const available = await checkOllamaAvailable();
    if (available) {
      const models = await listOllamaModels();
      if (models.length > 0) {
        const model = models[0].name;
        const ollamaMessages = messages.map(m => ({ role: m.role, content: m.content }));
        const text = await ollamaChat(model, ollamaMessages, onChunk);
        return { text, provider: 'ollama', model };
      }
    }
    if (preferredProvider === 'ollama') {
      throw new Error('Ollama is not running. Start it with: ollama serve');
    }
  }

  throw new Error(
    'No AI provider available. Claude Code CLI or Ollama must be running.\n' +
    '• Claude: ensure `claude` is in PATH and authenticated\n' +
    '• Ollama: run `ollama serve` to start'
  );
}
