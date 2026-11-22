import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { redact } from './redact.js';
import type { ImportedConversation } from './types.js';

export interface StoreOpts { source: string; projectId?: string | null; personId?: string | null; redact: boolean }
export type StoreResult =
  | { status: 'imported'; conversationId: string; messages: number; redactions: number; truncated: boolean }
  | { status: 'skipped'; conversationId: string; reason: string };

export const importKey = (source: string, key: string) => `${source}:${key}`;
export function importedKeys(source: string): Set<string> {
  return new Set((getDb().prepare('SELECT import_key FROM conversations WHERE import_source=?').all(source) as { import_key: string }[]).map(r => r.import_key));
}

/** Insert one imported conversation (messages are stored as data; nothing from them is ever executed). */
export function storeImported(conv: ImportedConversation, o: StoreOpts): StoreResult {
  const db = getDb(); const key = importKey(o.source, conv.key);
  const existing = db.prepare('SELECT id FROM conversations WHERE import_key=?').get(key) as { id: string } | undefined;
  if (existing) return { status: 'skipped', conversationId: existing.id, reason: 'Already imported (delete that conversation first to import again)' };

  const scope = o.projectId && o.personId ? 'project_person' : o.projectId ? 'project' : o.personId ? 'person' : 'global';
  let redactions = 0;
  const clean = (t: string) => { if (!o.redact) return t; const r = redact(t); redactions += r.count; return r.text; };
  const id = randomUUID(); const now = new Date().toISOString();
  const title = `Imported · ${clean(conv.title).slice(0, 100)}`;
  const base = Date.parse(conv.createdAt ?? '') || Date.now() - conv.messages.length * 1000;

  db.transaction(() => {
    db.prepare(`INSERT INTO conversations(id,title,scope,project_id,person_id,provider,created_at,updated_at,import_source,import_key) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(id, title, scope, o.projectId ?? null, o.personId ?? null, 'auto', new Date(base).toISOString(), now, o.source, key);
    const ins = db.prepare('INSERT INTO messages(id,conversation_id,role,content,provider,created_at) VALUES(?,?,?,?,?,?)');
    let prev = base - 1;
    conv.messages.forEach((m, i) => {
      const t = Date.parse(m.at ?? ''); const ts = Number.isFinite(t) && t > prev ? t : prev + 1;   // keep strictly increasing so order is stable
      prev = ts;
      ins.run(randomUUID(), id, m.role, clean(m.content), m.role === 'assistant' ? `imported:${o.source}` : '', new Date(ts).toISOString());
      void i;
    });
  })();
  return { status: 'imported', conversationId: id, messages: conv.messages.length, redactions, truncated: !!conv.truncated };
}
