import { claudeChat, checkClaudeAvailable, type ChatMessage, type ReportedUsage } from './claude.js';
import { codexChat, codexAvailable } from './codex.js';
import { cursorChat, cursorAvailable } from './cursor.js';
import { ollamaChat, checkOllamaAvailable, listOllamaModels } from './ollama.js';
import { testChat, testProviderEnabled } from './test.js';
import { budgetCheck, recordUsage, looksRateLimited, setCooldown, getSetting } from './usage.js';

export interface ChatRequest {
  messages: ChatMessage[];
  system: string;
  provider: string;
  claudeSessionId?: string | null;
  signal?: AbortSignal;
  /** Routing notes for the activity strip. */
  onRoute?: (detail: string) => void;
  meta?: { conversationId?: string; projectId?: string | null };
}
export interface ChatOutcome { text: string; provider: string; model: string; claudeSessionId?: string | null; resumed?: boolean }

const COOLDOWN_MINUTES = 60;

async function tracked<T extends { text: string; usage?: ReportedUsage }>(provider: string, model: string, req: ChatRequest, run: () => Promise<T>): Promise<T> {
  const t0 = Date.now(); const inChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
  const base = { provider, model, conversationId: req.meta?.conversationId, projectId: req.meta?.projectId, inputChars: inChars };
  try {
    const r = await run();
    recordUsage({ ...base, outputChars: r.text.length, durationMs: Date.now() - t0, ok: true, reported: r.usage });
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recordUsage({ ...base, durationMs: Date.now() - t0, ok: false, error: msg });
    if (provider !== 'ollama' && looksRateLimited(msg)) { setCooldown(provider, COOLDOWN_MINUTES, msg); req.onRoute?.(`${provider} reported a limit — paused for ${COOLDOWN_MINUTES} min`); }
    throw e;
  }
}

export async function autoChat(req: ChatRequest, onChunk: (text: string) => void): Promise<ChatOutcome> {
  const { messages, system, provider: preferred, signal } = req;

  if (preferred === 'test' && testProviderEnabled()) {
    return { text: await testChat(messages, system, onChunk, signal), provider: 'test', model: 'deterministic' };
  }

  let lastReason = '';
  if (preferred === 'claude' || preferred === 'auto') {
    if (await checkClaudeAvailable()) {
      const b = budgetCheck('claude');
      if (b.ok) {
        const r = await tracked('claude', 'claude-code', req, () => claudeChat(messages, system, onChunk, { sessionId: req.claudeSessionId, signal }));
        return { text: r.text, provider: 'claude', model: 'claude-code', claudeSessionId: r.sessionId, resumed: r.resumed };
      }
      lastReason = b.reason;
      if (preferred === 'claude') throw new Error(`${b.reason}. AImax will not call it again until then (zero-overage guard).`);
      req.onRoute?.(`${b.reason} — routing to another provider`);
    } else if (preferred === 'claude') throw new Error('Claude Code CLI is not available. Ensure `claude` is in your PATH (or set AIMAX_CLAUDE_BIN).');
  }

  // Cursor is only used when you pick it explicitly (never as an automatic fallback), so it cannot consume your Cursor plan unasked.
  if (preferred === 'cursor') {
    if (!cursorAvailable()) throw new Error('Cursor CLI is not installed. Open Settings → Cursor for the installer.');
    const b = budgetCheck('cursor'); if (!b.ok) throw new Error(`${b.reason}. AImax will not call it again until then (zero-overage guard).`);
    const r = await tracked('cursor', 'cursor-agent', req, () => cursorChat(messages, system, onChunk, { signal }));
    return { text: r.text, provider: 'cursor', model: 'cursor-agent' };
  }

  if (preferred === 'codex') {
    if (!codexAvailable()) throw new Error('Codex CLI is not installed. Open Settings → OpenAI for the installer.');
    const b = budgetCheck('codex'); if (!b.ok) throw new Error(`${b.reason}. AImax will not call it again until then (zero-overage guard).`);
    const r = await tracked('codex', 'codex', req, () => codexChat(messages, system, onChunk, { signal }));
    return { text: r.text, provider: 'codex', model: 'codex' };
  }

  if (preferred === 'ollama' || preferred === 'auto') {
    if (await checkOllamaAvailable()) {
      const models = await listOllamaModels();
      if (models.length > 0) {
        const chosen = getSetting<string>('ollama_model', '');
        const model = models.some(m => m.name === chosen) ? chosen : models[0].name;
        const b = budgetCheck('ollama');
        if (!b.ok) throw new Error(b.reason);
        const text = (await tracked('ollama', model, req, async () => ({ text: await ollamaChat(model, [{ role: 'system', content: system }, ...messages], onChunk, signal) }))).text;
        return { text, provider: 'ollama', model };
      }
    }
    if (preferred === 'ollama') throw new Error('Ollama is not running. Start it with: ollama serve');
  }

  throw new Error(`No AI provider available.${lastReason ? ` (${lastReason})` : ''}\n• Claude: ensure \`claude\` is in PATH and authenticated\n• Ollama: run \`ollama serve\` to start`);
}
