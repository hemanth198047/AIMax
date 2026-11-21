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
