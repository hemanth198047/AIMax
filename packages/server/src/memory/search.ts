import { getDb } from '../db/index.js';
import { memoryScopeClause, toFtsQuery, type MemoryContext } from './scope.js';

export interface MemoryRow {
  id: string; scope: string; project_id: string | null; person_id: string | null;
  type: string; title: string; content: string; provenance: string; confidence: number;
  tags: string; created_at: string; updated_at: string;
}

/** Ranked FTS search restricted to what `ctx` is allowed to see. */
export function searchMemory(query: string, ctx: MemoryContext, limit = 10): MemoryRow[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const sc = memoryScopeClause(ctx, 'm');
  return getDb().prepare(
    `SELECT m.* FROM memory_entries m JOIN memory_fts f ON f.rowid = m.rowid
     WHERE memory_fts MATCH ? AND ${sc.sql} ORDER BY rank LIMIT ?`
  ).all(fts, ...sc.args, Math.min(limit, 100)) as MemoryRow[];
}

/** Most recent entries visible to `ctx` (used when there is no query). */
export function listMemory(ctx: MemoryContext, limit = 20, type?: string): MemoryRow[] {
  const sc = memoryScopeClause(ctx, 'm');
  return getDb().prepare(
    `SELECT m.* FROM memory_entries m WHERE ${sc.sql} ${type ? 'AND m.type=?' : ''}
     ORDER BY m.updated_at DESC LIMIT ?`
  ).all(...sc.args, ...(type ? [type] : []), Math.min(limit, 100)) as MemoryRow[];
}
