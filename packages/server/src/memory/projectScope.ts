import type { MemoryContext } from './scope.js';

/**
 * Row-level visibility for project/person-bound knowledge tables
 * (decisions, solutions, failures, discoveries, tasks).
 * A NULL project_id means "global"; a project-bound row is visible only inside that project.
 * Without an active project, ONLY global rows are visible (never "everything").
 */
export function projectClause(ctx: MemoryContext, col = 'project_id'): { sql: string; args: unknown[] } {
  return ctx.projectId
    ? { sql: `(${col} IS NULL OR ${col}=?)`, args: [ctx.projectId] }
    : { sql: `${col} IS NULL`, args: [] };
}
export function personClause(ctx: MemoryContext, col = 'person_id'): { sql: string; args: unknown[] } {
  return ctx.personId
    ? { sql: `(${col} IS NULL OR ${col}=?)`, args: [ctx.personId] }
    : { sql: `${col} IS NULL`, args: [] };
}

/**
 * Visibility for rows that carry BOTH project_id and person_id (conversations, tasks, ...), mirroring memory scopes:
 * global (both NULL) is always visible; project-only rows need that project; person-only rows need that person;
 * project+person rows need both to be active.
 */
export function bothClause(ctx: MemoryContext, pcol = 'project_id', xcol = 'person_id'): { sql: string; args: unknown[] } {
  const parts = [`(${pcol} IS NULL AND ${xcol} IS NULL)`];
  const args: unknown[] = [];
  if (ctx.projectId) { parts.push(`(${pcol}=? AND ${xcol} IS NULL)`); args.push(ctx.projectId); }
  if (ctx.personId) { parts.push(`(${xcol}=? AND ${pcol} IS NULL)`); args.push(ctx.personId); }
  if (ctx.projectId && ctx.personId) { parts.push(`(${pcol}=? AND ${xcol}=?)`); args.push(ctx.projectId, ctx.personId); }
  return { sql: `(${parts.join(' OR ')})`, args };
}
