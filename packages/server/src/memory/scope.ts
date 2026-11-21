/**
 * Scope-aware memory access. Single source of truth for what an active
 * context (global / project / person / project+person) may read.
 *
 * Entry scopes: global | project | person | project_person
 * Rules (strict — no "NULL id matches everything" shortcuts):
 *   global context          -> global
 *   project P               -> global + project(P)
 *   person X                -> global + person(X)
 *   project P + person X    -> global + project(P) + person(X) + project_person(P,X)
 * A project/person private entry is NEVER visible outside its own context.
 */
export interface MemoryContext {
  projectId?: string | null;
  personId?: string | null;
}

export function memoryScopeClause(ctx: MemoryContext, alias = 'm'): { sql: string; args: unknown[] } {
  const a = alias ? `${alias}.` : '';
  const parts = [`${a}scope='global'`];
  const args: unknown[] = [];
  if (ctx.projectId) {
    parts.push(`(${a}scope='project' AND ${a}project_id=?)`);
    args.push(ctx.projectId);
  }
  if (ctx.personId) {
    parts.push(`(${a}scope='person' AND ${a}person_id=?)`);
    args.push(ctx.personId);
  }
  if (ctx.projectId && ctx.personId) {
    parts.push(`(${a}scope='project_person' AND ${a}project_id=? AND ${a}person_id=?)`);
    args.push(ctx.projectId, ctx.personId);
  }
  return { sql: `(${parts.join(' OR ')})`, args };
}

/** Turn free text into a safe FTS5 query (quoted terms, OR-joined). */
export function toFtsQuery(text: string): string {
  const terms = (text.match(/[\p{L}\p{N}_]{2,}/gu) ?? []).slice(0, 12);
  return terms.map(t => `"${t}"`).join(' OR ');
}
