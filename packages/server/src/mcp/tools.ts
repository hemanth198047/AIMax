/**
 * AImax MCP tools. Pure functions over the database; no transport here.
 *
 * Scope model: every call runs under an effective context {projectId, personId}.
 *  - PINNED (the stdio server, launched with AIMAX_MCP_PROJECT_ID / AIMAX_MCP_PERSON_ID): the context is fixed
 *    by whoever started the server. Tool arguments can NOT widen or change it, so an agent cannot ask for
 *    another project's or person's private memory.
 *  - UNPINNED (legacy local HTTP endpoints): the caller names the context in the arguments.
 * Writes are always stored at exactly the active scope (never wider) and are marked provenance='inferred'
 * because an AI, not the user, authored them.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { searchMemory, listMemory } from '../memory/search.js';
import { projectClause, personClause } from '../memory/projectScope.js';
import type { MemoryContext } from '../memory/scope.js';

export interface ToolContext extends MemoryContext { pinned: boolean }
export interface McpTool { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] } }

const MAX_TEXT = 20_000;
const str = (v: unknown, name: string, required = true): string => {
  if (v === undefined || v === null || v === '') { if (required) throw new Error(`'${name}' is required`); return ''; }
  if (typeof v !== 'string') throw new Error(`'${name}' must be a string`);
  if (v.length > MAX_TEXT) throw new Error(`'${name}' is too long (max ${MAX_TEXT} characters)`);
  return v;
};

export function contextFromEnv(env: NodeJS.ProcessEnv = process.env): ToolContext {
  return { projectId: env.AIMAX_MCP_PROJECT_ID || null, personId: env.AIMAX_MCP_PERSON_ID || null, pinned: true };
}

function effective(ctx: ToolContext, args: Record<string, unknown>): MemoryContext {
  if (ctx.pinned) return { projectId: ctx.projectId ?? null, personId: ctx.personId ?? null };
  return { projectId: typeof args.project_id === 'string' && args.project_id ? args.project_id : (ctx.projectId ?? null),
           personId: typeof args.person_id === 'string' && args.person_id ? args.person_id : (ctx.personId ?? null) };
}

export function getTools(pinned: boolean): McpTool[] {
  const ids = pinned ? {} : { project_id: { type: 'string', description: 'Project ID' }, person_id: { type: 'string', description: 'Person ID' } };
  const t = (name: string, description: string, properties: Record<string, unknown>, required?: string[]): McpTool =>
    ({ name, description, inputSchema: { type: 'object', properties: { ...properties, ...ids }, ...(required ? { required } : {}) } });
  return [
    t('search_memory', 'Search AImax MemoryVault (notes, decisions, solutions) visible in the active project/person context.', { query: { type: 'string' }, limit: { type: 'number', description: 'Max results (default 10, max 50)' } }, ['query']),
    t('get_project_context', 'Get the active project: description, active decisions, solutions, failures, linked people, recent memory.', {}),
    t('find_solution', 'Find a previously recorded solution for a problem.', { problem: { type: 'string' } }, ['problem']),
    t('find_failed_approaches', 'Find approaches that were tried and failed, to avoid repeating them.', { context: { type: 'string' } }, ['context']),
    t('get_decisions', 'Get architectural decisions visible in the active context.', { status: { type: 'string', enum: ['active', 'superseded'] } }),
    t('list_projects', 'List the project(s) visible to this connection.', {}),
    t('list_people', 'List the people visible to this connection (only those linked to the active project, or the active person).', {}),
    t('save_memory', 'Save knowledge to AImax at exactly the active scope. Stored with provenance "inferred" until the user confirms it.', { title: { type: 'string' }, content: { type: 'string' }, type: { type: 'string', enum: ['note', 'decision', 'solution', 'discovery', 'requirement', 'task'] } }, ['title', 'content']),
    t('save_solution', 'Record a solution (stored in the active project, or globally if none).', { problem: { type: 'string' }, root_cause: { type: 'string' }, fix: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, ['problem', 'fix']),
    t('save_failure', 'Record an approach that failed so it is not repeated.', { approach: { type: 'string' }, reason: { type: 'string' } }, ['approach', 'reason']),
    t('check_prior_work', 'Check whether similar work was already done before starting a task.', { intent: { type: 'string' } }, ['intent']),
  ];
}

const MEMORY_TYPES = ['note', 'decision', 'solution', 'discovery', 'requirement', 'task'];

export function callTool(name: string, args: Record<string, unknown>, ctx: ToolContext): unknown {
  const db = getDb();
  const c = effective(ctx, args);
  const proj = projectClause(c);
  const pers = personClause(c);
  const like = (s: string) => `%${s.replace(/[\\%_]/g, m => '\\' + m)}%`;

  switch (name) {
    case 'search_memory': {
      const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 50);
      return searchMemory(str(args.query, 'query'), c, limit);
    }
    case 'get_project_context': {
      if (!c.projectId) return { error: 'No project is active for this connection' };
      const project = db.prepare('SELECT * FROM projects WHERE id=?').get(c.projectId);
      if (!project) return { error: 'Project not found' };
      return {
        project,
        decisions: db.prepare(`SELECT * FROM decisions WHERE project_id=? AND status='active' AND ${pers.sql} ORDER BY created_at DESC LIMIT 10`).all(c.projectId, ...pers.args),
        solutions: db.prepare('SELECT * FROM solutions WHERE project_id=? ORDER BY verified_at DESC LIMIT 5').all(c.projectId),
        failures: db.prepare('SELECT * FROM failures WHERE project_id=? ORDER BY created_at DESC LIMIT 5').all(c.projectId),
        people: c.personId
          ? db.prepare('SELECT p.id, p.display_name, pp.role AS project_role FROM people p JOIN project_people pp ON pp.person_id=p.id WHERE pp.project_id=? AND p.id=?').all(c.projectId, c.personId)
          : db.prepare('SELECT p.id, p.display_name, pp.role AS project_role FROM people p JOIN project_people pp ON pp.person_id=p.id WHERE pp.project_id=?').all(c.projectId),
        recent_memory: listMemory(c, 10).map(m => ({ title: m.title, content: m.content, type: m.type, scope: m.scope })),
      };
    }
    case 'find_solution': {
      const q = like(str(args.problem, 'problem'));
      return db.prepare(`SELECT * FROM solutions WHERE ${proj.sql} AND (problem LIKE ? ESCAPE '\\' OR fix LIKE ? ESCAPE '\\') ORDER BY verified_at DESC LIMIT 5`).all(...proj.args, q, q);
    }
    case 'find_failed_approaches': {
      const q = like(str(args.context, 'context'));
      return db.prepare(`SELECT * FROM failures WHERE ${proj.sql} AND (approach LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT 10`).all(...proj.args, q, q);
    }
    case 'get_decisions': {
      const status = args.status === 'superseded' ? 'superseded' : 'active';
      return db.prepare(`SELECT * FROM decisions WHERE status=? AND ${proj.sql} AND ${pers.sql} ORDER BY created_at DESC LIMIT 20`).all(status, ...proj.args, ...pers.args);
    }
    case 'list_projects': {
      if (ctx.pinned) return c.projectId ? db.prepare('SELECT id, name, description, category, status FROM projects WHERE id=?').all(c.projectId) : [];
      return db.prepare('SELECT id, name, description, category, status FROM projects ORDER BY updated_at DESC').all();
    }
    case 'list_people': {
      if (ctx.pinned) {
        if (c.personId) return db.prepare('SELECT id, display_name, role, organization FROM people WHERE id=?').all(c.personId);
        if (c.projectId) return db.prepare('SELECT p.id, p.display_name, p.role, p.organization FROM people p JOIN project_people pp ON pp.person_id=p.id WHERE pp.project_id=?').all(c.projectId);
        return [];
      }
      return db.prepare('SELECT id, display_name, role, organization FROM people ORDER BY display_name').all();
    }
    case 'save_memory': {
      const type = typeof args.type === 'string' && MEMORY_TYPES.includes(args.type) ? args.type : 'note';
      const scope = c.projectId && c.personId ? 'project_person' : c.projectId ? 'project' : c.personId ? 'person' : 'global';
      const id = randomUUID(); const now = new Date().toISOString();
      db.prepare(`INSERT INTO memory_entries(id,scope,project_id,person_id,type,title,content,provenance,confidence,tags,source_conversation_id,created_at,updated_at)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, scope, c.projectId ?? null, c.personId ?? null, type, str(args.title, 'title'), str(args.content, 'content'), 'inferred', 0.5, '[]', null, now, now);
      return { saved: true, id, scope, provenance: 'inferred' };
    }
    case 'save_solution': {
      const id = randomUUID();
      db.prepare('INSERT INTO solutions(id,project_id,problem,root_cause,fix,tags,verified_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, c.projectId ?? null, str(args.problem, 'problem'), str(args.root_cause, 'root_cause', false), str(args.fix, 'fix'),
          JSON.stringify(Array.isArray(args.tags) ? args.tags.filter(x => typeof x === 'string').slice(0, 20) : []), new Date().toISOString());
      return { saved: true, id, project_id: c.projectId ?? null };
    }
    case 'save_failure': {
      const id = randomUUID();
      db.prepare('INSERT INTO failures(id,project_id,approach,reason,created_at) VALUES(?,?,?,?,?)')
        .run(id, c.projectId ?? null, str(args.approach, 'approach'), str(args.reason, 'reason'), new Date().toISOString());
      return { saved: true, id, project_id: c.projectId ?? null };
    }
    case 'check_prior_work': {
      const intent = str(args.intent, 'intent'); const q = like(intent.slice(0, 100));
      const mem = searchMemory(intent, c, 3).map(m => ({ title: m.title, content: m.content }));
      const sol = db.prepare(`SELECT problem, fix FROM solutions WHERE ${proj.sql} AND (problem LIKE ? ESCAPE '\\' OR fix LIKE ? ESCAPE '\\') LIMIT 3`).all(...proj.args, q, q);
      const fail = db.prepare(`SELECT approach, reason FROM failures WHERE ${proj.sql} AND approach LIKE ? ESCAPE '\\' LIMIT 2`).all(...proj.args, q);
      return { intent, prior_work: { memory: mem, solutions: sol, failures: fail }, has_prior_work: mem.length + sol.length + fail.length > 0 };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
