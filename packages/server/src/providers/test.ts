import type { ChatMessage } from './claude.js';

/**
 * Deterministic provider for automated tests ONLY. It is reachable solely when AIMAX_TEST_PROVIDER=1
 * and an explicit provider id 'test' is requested — `auto` never selects it, and it is listed only
 * while that flag is set. It reports what it received so tests can assert on retrieval/attachments/scope.
 */
export const testProviderEnabled = () => process.env.AIMAX_TEST_PROVIDER === '1';

export async function testChat(messages: ChatMessage[], onChunk: (t: string) => void): Promise<string> {
  const ctx = messages.find(m => m.content.startsWith('Context from AImax memory:'));
  const last = messages[messages.length - 1];
  const text = [
    `TEST-PROVIDER reply to: ${last.content.split('\n')[0].slice(0, 120)}`,
    `memory-context: ${ctx ? ctx.content.replace(/^Context from AImax memory:\n/, '').split('\n\nUse this')[0].replace(/\n---\n/g, ' | ') : 'none'}`,
    `attachments-seen: ${[...last.content.matchAll(/\[Attached file: ([^\]]*?)(?: —| \()/g)].map(m => m[1]).join(', ') || 'none'}`,
    `history-messages: ${messages.length}`,
  ].join('\n\n');
  for (const part of text.match(/.{1,40}/gs) ?? []) { onChunk(part); await new Promise(r => setTimeout(r, 5)); }
  return text;
}
