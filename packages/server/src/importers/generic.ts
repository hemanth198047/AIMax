/** Chats exported from other tools (FreeLLMAPI-style gateways, ChatGPT, Claude.ai, OpenAI-format JSON, markdown transcripts). */
import { createHash } from 'node:crypto';
import { isoOrUndefined, normalize, type ImportedConversation, type ImportedMessage } from './types.js';

const roleOf = (r: unknown): 'user' | 'assistant' | null => {
  const s = String(r ?? '').toLowerCase();
  return ['user', 'human', 'me'].includes(s) ? 'user' : ['assistant', 'ai', 'bot', 'model', 'claude', 'gpt', 'chatgpt'].includes(s) ? 'assistant' : null;
};
const contentOf = (c: unknown): string => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '').filter(Boolean).join('\n');
  if (c && typeof c === 'object') { const o = c as Record<string, unknown>; if (Array.isArray(o.parts)) return o.parts.filter(p => typeof p === 'string').join('\n'); if (typeof o.text === 'string') return o.text; }
  return '';
};
const keyOf = (seed: string) => 'file:' + createHash('sha256').update(seed).digest('hex').slice(0, 16);

function fromMessages(arr: unknown[], title: string, seed: string, at?: string): ImportedConversation | null {
  const msgs: ImportedMessage[] = [];
  for (const m of arr as Array<Record<string, any>>) {
    const role = roleOf(m?.role ?? m?.sender ?? m?.author?.role ?? m?.from); if (!role) continue;   // system/tool/unknown roles are skipped
    msgs.push({ role, content: contentOf(m.content ?? m.text ?? m.message ?? m.parts), at: isoOrUndefined(m.created_at ?? m.timestamp ?? m.create_time ?? m.createdAt) });
  }
  const { messages, truncated } = normalize(msgs);
  return messages.length ? { key: keyOf(seed), title: (title || messages.find(m => m.role === 'user')?.content.replace(/\s+/g, ' ').slice(0, 80) || 'Imported chat'), messages, truncated, createdAt: messages[0].at ?? at, updatedAt: messages[messages.length - 1].at ?? at } : null;
}

function fromChatGpt(c: any): ImportedConversation | null {
  const mapping = c.mapping as Record<string, any>; const path: any[] = [];
  let id = c.current_node ?? Object.keys(mapping).find(k => !(mapping[k].children?.length));
  for (let i = 0; id && i < 100_000; i++) { const n = mapping[id]; if (!n) break; path.push(n); id = n.parent; }
  return fromMessages(path.reverse().map(n => n.message).filter(Boolean), String(c.title ?? ''), JSON.stringify([c.id ?? c.conversation_id, c.title, c.create_time]), isoOrUndefined(c.create_time));
}

function parseTranscript(text: string, name: string): ImportedConversation | null {
  const re = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(User|Human|You|Assistant|AI|Claude|ChatGPT|Bot)(?:\*\*)?\s*:?\s*(?:\*\*)?\s*(.*)$/i;
  const msgs: ImportedMessage[] = []; let cur: ImportedMessage | null = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = re.exec(line); const isHeader = m && (line.includes(':') || /^\s*#{1,6}\s/.test(line));
    if (m && isHeader) { cur = { role: roleOf(m[1]) ?? 'assistant', content: m[2] }; msgs.push(cur); }
    else if (cur) cur.content += '\n' + line;
  }
  const { messages, truncated } = normalize(msgs);
  return messages.length >= 1 && msgs.length >= 2 ? { key: keyOf(text.slice(0, 5000)), title: name.replace(/\.[a-z0-9]+$/i, '') || 'Imported transcript', messages, truncated } : null;
}

/** Parse an exported chat file into one or more conversations. Throws a readable error if the format is not recognised. */
export function parseChatFile(text: string, filename: string): ImportedConversation[] {
  const name = filename.replace(/^.*[\\/]/, '');
  const trimmed = text.trim();
  if (!trimmed) throw new Error('File is empty');
  let data: any;
  if (/^[\[{]/.test(trimmed)) {
    try { data = JSON.parse(trimmed); }
    catch {   // maybe JSON Lines
      const rows = trimmed.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (rows.length) data = rows;
    }
  }
  const out: ImportedConversation[] = [];
  const push = (c: ImportedConversation | null) => { if (c) out.push(c); };
  if (data !== undefined) {
    const list: any[] = Array.isArray(data) ? data : [data];
    if (list.length && list.every(x => x && typeof x === 'object' && (x.role || x.sender) && ('content' in x || 'text' in x))) push(fromMessages(list, name.replace(/\.[a-z0-9]+$/i, ''), trimmed.slice(0, 5000)));   // plain OpenAI-style message list
    else for (const c of list) {
      if (c?.mapping && typeof c.mapping === 'object') push(fromChatGpt(c));                                                                   // ChatGPT export
      else if (Array.isArray(c?.chat_messages)) push(fromMessages(c.chat_messages, String(c.name ?? ''), JSON.stringify([c.uuid, c.name]), isoOrUndefined(c.created_at)));    // Claude.ai export
      else if (Array.isArray(c?.messages)) push(fromMessages(c.messages, String(c.title ?? c.name ?? name), JSON.stringify([c.id, c.title, c.messages.length, c.messages[0]]), isoOrUndefined(c.created_at ?? c.createdAt)));
      else if (Array.isArray(c?.conversation)) push(fromMessages(c.conversation, String(c.title ?? name), JSON.stringify(c.conversation).slice(0, 5000)));
    }
  } else push(parseTranscript(text, name));
  if (!out.length) throw new Error('Could not recognise this file as a chat export (supported: OpenAI-style messages JSON/JSONL, ChatGPT and Claude.ai exports, or a "User:/Assistant:" text/markdown transcript)');
  return out;
}
