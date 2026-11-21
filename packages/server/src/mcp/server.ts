/**
 * Phase 17: Shared Local MCP Server
 * Exposes AImax engineering brain to Claude Code and other MCP clients.
 * Runs as an HTTP+SSE MCP server on port 3002.
 */
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { searchMemory } from '../memory/search.js';

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TOOLS: McpTool[] = [
  {
    name: 'search_memory',
    description: 'Search AImax MemoryVault for relevant knowledge, decisions, solutions, and notes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        scope: { type: 'string', enum: ['global', 'project', 'person', 'project_person'], description: 'Memory scope' },
        project_id: { type: 'string', description: 'Filter by project ID' },
        person_id: { type: 'string', description: 'Filter by person ID' },
        limit: { type: 'number', description: 'Max results (default 10)' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_project_context',
    description: 'Get full context for a project including decisions, solutions, failures, and memory.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID' },
        project_name: { type: 'string', description: 'Project name (fuzzy match if ID unknown)' }
      }
    }
  },
  {
    name: 'find_solution',
    description: 'Find a previously verified solution for a problem.',
    inputSchema: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'Problem description to search for' },
        project_id: { type: 'string', description: 'Optional project filter' }
      },
      required: ['problem']
    }
  },
  {
    name: 'find_failed_approaches',
    description: 'Find approaches that have been tried and failed, to avoid repeating them.',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'Context or approach description' },
        project_id: { type: 'string', description: 'Optional project filter' }
      },
      required: ['context']
    }
  },
  {
    name: 'get_decisions',
    description: 'Get architectural decisions for a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID' },
        status: { type: 'string', enum: ['active', 'superseded'], description: 'Decision status' }
      }
    }
  },
  {
    name: 'list_projects',
    description: 'List all AImax projects.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_people',
    description: 'List all people in AImax.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'save_memory',
    description: 'Save a piece of knowledge to AImax MemoryVault.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Memory title' },
        content: { type: 'string', description: 'Memory content' },
        type: { type: 'string', enum: ['note', 'decision', 'solution', 'discovery', 'requirement', 'task'], description: 'Memory type' },
        scope: { type: 'string', enum: ['global', 'project', 'person'], description: 'Memory scope' },
        project_id: { type: 'string', description: 'Associated project ID' },
        person_id: { type: 'string', description: 'Associated person ID' },
        provenance: { type: 'string', enum: ['verified', 'source_backed', 'user_provided', 'inferred'] }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'save_solution',
    description: 'Save a verified solution to the Solution Replay store.',
    inputSchema: {
      type: 'object',
      properties: {
        problem: { type: 'string' },
        root_cause: { type: 'string' },
        fix: { type: 'string' },
        project_id: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['problem', 'fix']
    }
  },
  {
    name: 'save_failure',
    description: 'Record an approach that failed so it is not repeated.',
    inputSchema: {
      type: 'object',
      properties: {
        approach: { type: 'string' },
        reason: { type: 'string' },
        project_id: { type: 'string' }
      },
      required: ['approach', 'reason']
    }
  },
  {
    name: 'check_prior_work',
    description: 'Check if similar work has already been done before starting a new task.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'What you are about to do' },
        project_id: { type: 'string' }
      },
      required: ['intent']
    }
  }
];

function callTool(name: string, args: Record<string, unknown>): unknown {
  const db = getDb();

  switch (name) {
    case 'search_memory': {
      const { query, project_id, person_id, limit = 10 } = args as Record<string, string | number>;
      return searchMemory(String(query), { projectId: project_id as string, personId: person_id as string }, Number(limit));
    }

    case 'get_project_context': {
      const { project_id, project_name } = args as { project_id?: string; project_name?: string };
      let project;
      if (project_id) {
        project = db.prepare('SELECT * FROM projects WHERE id=?').get(project_id);
      } else if (project_name) {
        project = db.prepare('SELECT * FROM projects WHERE name LIKE ?').get(`%${project_name}%`);
      }
      if (!project) return { error: 'Project not found' };
      const pid = (project as { id: string }).id;
      return {
        project,
        decisions: db.prepare("SELECT * FROM decisions WHERE project_id=? AND status='active' ORDER BY created_at DESC LIMIT 10").all(pid),
        solutions: db.prepare('SELECT * FROM solutions WHERE project_id=? ORDER BY verified_at DESC LIMIT 5').all(pid),
        failures: db.prepare('SELECT * FROM failures WHERE project_id=? ORDER BY created_at DESC LIMIT 5').all(pid),
        people: db.prepare(`SELECT p.*, pp.role as project_role FROM people p JOIN project_people pp ON pp.person_id=p.id WHERE pp.project_id=?`).all(pid),
        recent_memory: db.prepare(`SELECT title, content, type FROM memory_entries WHERE project_id=? ORDER BY updated_at DESC LIMIT 10`).all(pid)
      };
    }

    case 'find_solution': {
      const { problem, project_id } = args as { problem: string; project_id?: string };
      let sql = 'SELECT * FROM solutions WHERE problem LIKE ? OR fix LIKE ?';
      const params: unknown[] = [`%${problem}%`, `%${problem}%`];
      if (project_id) { sql += ' AND project_id=?'; params.push(project_id); }
      sql += ' ORDER BY verified_at DESC LIMIT 5';
      return db.prepare(sql).all(...params);
    }

    case 'find_failed_approaches': {
      const { context, project_id } = args as { context: string; project_id?: string };
      let sql = 'SELECT * FROM failures WHERE approach LIKE ? OR reason LIKE ?';
      const params: unknown[] = [`%${context}%`, `%${context}%`];
      if (project_id) { sql += ' AND project_id=?'; params.push(project_id); }
      return db.prepare(sql).all(...params);
    }

    case 'get_decisions': {
      const { project_id, status = 'active' } = args as { project_id?: string; status?: string };
      let sql = 'SELECT * FROM decisions WHERE status=?';
      const params: unknown[] = [status];
      if (project_id) { sql += ' AND project_id=?'; params.push(project_id); }
      sql += ' ORDER BY created_at DESC LIMIT 20';
      return db.prepare(sql).all(...params);
    }

    case 'list_projects':
      return db.prepare('SELECT id, name, description, category, status FROM projects ORDER BY updated_at DESC').all();

    case 'list_people':
      return db.prepare('SELECT id, display_name, role, organization, relationship FROM people ORDER BY display_name').all();

    case 'save_memory': {
      const { v4: uuidv4 } = { v4: () => crypto.randomUUID() };
      const id = uuidv4();
      const now = new Date().toISOString();
      const { title, content, type = 'note', scope = 'global', project_id = null, person_id = null, provenance = 'user_provided' } = args as Record<string, unknown>;
      db.prepare('INSERT INTO memory_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        id, scope, project_id, person_id, type, title, content, provenance, 1.0, '[]', null, now, now
      );
      return { saved: true, id };
    }

    case 'save_solution': {
      const { v4: uuidv4 } = { v4: () => crypto.randomUUID() };
      const id = uuidv4();
      const { problem, root_cause = '', fix, project_id = null, tags = [] } = args as Record<string, unknown>;
      db.prepare('INSERT INTO solutions VALUES(?,?,?,?,?,?,?,?,?,?)').run(
        id, project_id, problem, root_cause, fix, '[]', '', '{}',
        Array.isArray(tags) ? JSON.stringify(tags) : '[]',
        new Date().toISOString()
      );
      return { saved: true, id };
    }

    case 'save_failure': {
      const { v4: uuidv4 } = { v4: () => crypto.randomUUID() };
      const id = uuidv4();
      const { approach, reason, project_id = null } = args as Record<string, unknown>;
      db.prepare('INSERT INTO failures VALUES(?,?,?,?,?,?,?)').run(
        id, project_id, approach, reason, '', '[]', new Date().toISOString()
      );
      return { saved: true, id };
    }

    case 'check_prior_work': {
      const { intent, project_id } = args as { intent: string; project_id?: string };
      const q = (intent as string).slice(0, 100);
      const mem = db.prepare(`SELECT title, content FROM memory_entries WHERE ${project_id ? 'project_id=? AND ' : ''}(title LIKE ? OR content LIKE ?) LIMIT 3`).all(...(project_id ? [project_id] : []), `%${q}%`, `%${q}%`);
      const sol = db.prepare(`SELECT problem, fix FROM solutions WHERE ${project_id ? 'project_id=? AND ' : ''}(problem LIKE ? OR fix LIKE ?) LIMIT 3`).all(...(project_id ? [project_id] : []), `%${q}%`, `%${q}%`);
      const fail = db.prepare(`SELECT approach, reason FROM failures WHERE ${project_id ? 'project_id=? AND ' : ''}(approach LIKE ?) LIMIT 2`).all(...(project_id ? [project_id] : []), `%${q}%`);
      return { intent, prior_work: { memory: mem, solutions: sol, failures: fail }, has_prior_work: mem.length + sol.length + fail.length > 0 };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function mcpRoutes(app: FastifyInstance) {
  // MCP server info endpoint
  app.get('/mcp/info', async () => ({
    name: 'aimax',
    version: '0.1.0',
    description: 'AImax engineering brain — memory, decisions, solutions, project context',
    tools: TOOLS.length,
    protocol: 'mcp-http'
  }));

  // List tools
  app.get('/mcp/tools', async () => ({ tools: TOOLS }));

  // Call tool
  app.post<{ Body: { name: string; arguments?: Record<string, unknown> } }>('/mcp/call', async (req, reply) => {
    const { name, arguments: args = {} } = req.body;
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) return reply.status(404).send({ error: `Tool '${name}' not found` });

    try {
      const result = callTool(name, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    } catch (err) {
      return reply.status(500).send({
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });

  // MCP SSE endpoint for streaming tool calls (MCP protocol)
  app.get('/mcp/sse', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    // Send server info
    reply.raw.write(`data: ${JSON.stringify({ type: 'server_info', name: 'aimax', tools: TOOLS.map(t => t.name) })}\n\n`);
    // Keep alive
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
    req.socket.on('close', () => clearInterval(ping));
  });

  // Generate CLAUDE.md MCP configuration snippet
  app.get('/mcp/config', async (req) => {
    const { format = 'json' } = req.query as { format?: string };
    const config = {
      mcpServers: {
        aimax: {
          command: 'node',
          args: ['-e', `
const http = require('http');
// AImax MCP proxy — forwards stdio MCP to HTTP
process.stdin.on('data', async (d) => {
  const req = JSON.parse(d);
  const body = JSON.stringify({ name: req.params?.name, arguments: req.params?.arguments });
  const res = await new Promise(r => {
    const o = http.request({ hostname: 'localhost', port: 3001, path: '/mcp/call', method: 'POST', headers: {'Content-Type':'application/json','Content-Length':body.length} }, r);
    o.write(body); o.end();
  });
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => process.stdout.write(data + '\\n'));
});
          `.trim()],
          description: 'AImax engineering brain — memory, decisions, solutions, project context'
        }
      }
    };
    if (format === 'yaml') {
      return `mcpServers:\n  aimax:\n    url: http://localhost:3001/mcp\n    description: "AImax engineering brain"`;
    }
    return config;
  });
}
