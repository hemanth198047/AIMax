export interface ImportedMessage { role: 'user' | 'assistant'; content: string; at?: string }
export interface ImportedConversation {
  /** Stable identity within its source (used for de-duplication and to re-read the session). */
  key: string;
  title: string;
  project?: string;            // where it was working (e.g. the folder), for display only
  createdAt?: string;
  updatedAt?: string;
  messages: ImportedMessage[];
  truncated?: boolean;
}
export interface ScanItem { id: string; title: string; messages: number; updatedAt: string; project: string; imported: boolean }

export const LIMITS = { messageChars: 100_000, messages: 2000, scanFiles: 500, fileBytes: 200 * 1024 * 1024, uploadBytes: 50 * 1024 * 1024 };

/** Merge consecutive same-role messages and drop empties, respecting size limits. */
export function normalize(msgs: ImportedMessage[]): { messages: ImportedMessage[]; truncated: boolean } {
  const out: ImportedMessage[] = [];
  for (const m of msgs) {
    const content = m.content.replace(/\r\n/g, '\n').trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + content;
    else out.push({ role: m.role, content, ...(m.at ? { at: m.at } : {}) });
  }
  let truncated = false;
  for (const m of out) if (m.content.length > LIMITS.messageChars) { m.content = m.content.slice(0, LIMITS.messageChars) + '\n…[truncated on import]'; truncated = true; }
  if (out.length > LIMITS.messages) { truncated = true; return { messages: out.slice(-LIMITS.messages), truncated }; }   // keep the most recent part
  return { messages: out, truncated };
}

export const isoOrUndefined = (v: unknown): string | undefined => {
  if (typeof v === 'number' && v > 0) { const d = new Date(v < 1e12 ? v * 1000 : v); return isNaN(+d) ? undefined : d.toISOString(); }
  if (typeof v === 'string' && v) { const d = new Date(v); return isNaN(+d) ? undefined : d.toISOString(); }
  return undefined;
};
