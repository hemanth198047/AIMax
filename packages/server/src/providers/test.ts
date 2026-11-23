import type { ChatMessage } from './claude.js';

/**
 * Deterministic provider for automated tests ONLY. Reachable solely when AIMAX_TEST_PROVIDER=1 and the provider
 * id 'test' is requested explicitly — `auto` never selects it, and it is listed only while that flag is set.
 * It reports what it received so tests can assert on retrieval, attachments, guidance and scope.
 *   "[test:propose]" in the message → replies with an approval-gated aimax-run block
 *   "[test:slow]"    → streams slowly (for stop/abort tests)
 */
export const testProviderEnabled = () => process.env.AIMAX_TEST_PROVIDER === '1';

export async function testChat(messages: ChatMessage[], system: string, onChunk: (t: string) => void, signal?: AbortSignal): Promise<string> {
  const last = messages[messages.length - 1].content;
  const mem = /\[AImax memory[^\]]*\]\n([\s\S]*?)(?=\n\n\[AImax guidance|$)/.exec(last)?.[1];
  const text = [
    `TEST-PROVIDER reply to: ${last.split('\n')[0].slice(0, 120)}`,
    `memory-context: ${mem ? mem.replace(/\n---\n/g, ' | ') : 'none'}`,
    `attachments-seen: ${[...last.matchAll(/\[Attached file: ([^\]]*?)(?: —| \()/g)].map(m => m[1]).join(', ') || 'none'}`,
    `knowledge-seen: ${/\[Project knowledge/.test(last) ? last.slice(last.indexOf('\n---') > 0 ? last.indexOf('[Project knowledge') : 0, last.indexOf('[Project knowledge') + 400).replace(/\n/g, ' ') : 'none'}`,
    `links-seen: ${/\[Content fetched from links/.test(last) ? last.slice(last.indexOf('\n###') + 1, last.indexOf('\n###') + 420).replace(/\n/g, ' ') : 'none'}`,
    `history-messages: ${messages.length}`,
    `guidance: ${last.includes('[AImax guidance') ? 'yes' : 'no'}`,
    `run-protocol: ${system.includes('aimax-run') ? 'yes' : 'no'}`,
    `earlier-digest: ${system.includes('[Earlier in this conversation') ? system.slice(system.indexOf('[Earlier in this conversation')).replace(/\n/g, ' | ').slice(0, 600) : 'none'}`,
    `edit-protocol: ${system.includes('aimax-edit') ? 'yes' : 'no'}`,
    ...(last.includes('[test:edit]') ? ['I propose this change:', '```aimax-edit\nFILE: docs/hello.txt\n<<<<<<< SEARCH\n=======\nhello from an edit proposal\n>>>>>>> REPLACE\n```'] : []),
    ...(last.includes('[test:edit2]') ? ['And this one:', '```aimax-edit\nFILE: docs/hello.txt\n<<<<<<< SEARCH\nhello from an edit proposal\n=======\ngoodbye from an edit proposal\n>>>>>>> REPLACE\n```'] : []),
    ...(last.includes('[test:code]') ? ['Here is some code:', '```python\nprint("hi")\nfor i in range(2):\n    print(i)\n```', 'And **bold** text.'] : []),
    ...(last.includes('[test:propose]') ? ['I suggest running this in your sandbox:', '```aimax-run\necho proposed-ok; echo done-from-proposal\n```'] : []),
  ].join('\n\n');
  const slow = last.includes('[test:slow]');
  const parts = slow ? Array.from({ length: 60 }, (_, i) => `slow-${i} `) : (text.match(/.{1,40}/gs) ?? []);
  let out = '';
  for (const part of parts) {
    if (signal?.aborted) break;
    out += part; onChunk(part);
    await new Promise(r => setTimeout(r, slow ? 80 : 5));
  }
  return slow ? out : text;
}
