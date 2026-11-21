import { getDb } from './index.js';

/** Columns that PATCH endpoints may change. Anything else in the body is ignored (never interpolated into SQL). */
export const UPDATABLE = {
  projects: ['name','description','category','status','priority','tags','repo_path','tech_stack','instructions','provider','privacy'],
  people: ['display_name','preferred_name','role','organization','relationship','notes','tags','privacy'],
  tasks: ['title','description','project_id','person_id','conversation_id','status','priority','due_date'],
  conversations: ['title','scope','project_id','person_id','provider','model','pinned','archived'],
  decisions: ['title','rationale','alternatives','tradeoffs','status','supersedes','project_id','person_id'],
} as const;

type Table = keyof typeof UPDATABLE;
const HAS_UPDATED_AT: Table[] = ['projects', 'people', 'tasks', 'conversations'];

function toSqlValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** Returns the updated row, null if the row does not exist, or 'empty' if no allowed field was supplied. */
export function updateRow(table: Table, id: string, body: Record<string, unknown>): Record<string, unknown> | null | 'empty' {
  const db = getDb();
  const keys = UPDATABLE[table].filter(k => Object.prototype.hasOwnProperty.call(body ?? {}, k));
  if (!keys.length) return 'empty';
  const sets = keys.map(k => `${k}=?`);
  const vals = keys.map(k => toSqlValue(body[k]));
  if (HAS_UPDATED_AT.includes(table)) { sets.push('updated_at=?'); vals.push(new Date().toISOString()); }
  const r = db.prepare(`UPDATE ${table} SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
  if (!r.changes) return null;
  return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string, unknown>;
}
