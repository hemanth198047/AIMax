/**
 * HTTP surface for MCP. The real protocol lives in jsonrpc.ts (POST /mcp, JSON-RPC) and stdio.ts (what Claude Code launches).
 * Legacy REST helpers (/mcp/call etc.) remain for the UI and are UNPINNED local endpoints.
 */
import type { FastifyInstance } from 'fastify';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTools, callTool, type ToolContext } from './tools.js';
import { handleMessage } from './jsonrpc.js';
import { DATA_DIR } from '../db/index.js';

const unpinned: ToolContext = { projectId: null, personId: null, pinned: false };
const STDIO_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), 'stdio.ts');

export async function mcpRoutes(app: FastifyInstance) {
  app.get('/mcp/info', async () => ({ name: 'aimax', version: '0.1.0', tools: getTools(false).length, protocol: 'mcp (JSON-RPC 2.0) via stdio and POST /mcp' }));
  app.get('/mcp/tools', async () => ({ tools: getTools(false) }));

  // Real MCP over HTTP (single JSON response per POST). Unpinned: the caller names project/person in tool arguments.
  app.post('/mcp', async (req, reply) => {
    const body = req.body;
    const items = Array.isArray(body) ? body : [body];
    const out = items.map(i => handleMessage(i, unpinned)).filter(Boolean);
    if (!out.length) return reply.status(202).send();
    return Array.isArray(body) ? out : out[0];
  });

  app.post<{ Body: { name: string; arguments?: Record<string, unknown> } }>('/mcp/call', async (req, reply) => {
    const { name, arguments: args = {} } = req.body ?? {} as never;
    if (!getTools(false).some(t => t.name === name)) return reply.status(404).send({ error: `Tool '${name}' not found` });
    try { return { content: [{ type: 'text', text: JSON.stringify(callTool(name, args, unpinned), null, 2) }] }; }
    catch (err) { return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) }); }
  });

  // Config for Claude Code: a stdio server pinned to the chosen scope.  ?project_id=&person_id=
  app.get<{ Querystring: { project_id?: string; person_id?: string } }>('/mcp/config', async (req) => {
    const env: Record<string, string> = { AIMAX_DATA_DIR: DATA_DIR };
    if (req.query.project_id) env.AIMAX_MCP_PROJECT_ID = req.query.project_id;
    if (req.query.person_id) env.AIMAX_MCP_PERSON_ID = req.query.person_id;
    return {
      mcpServers: { aimax: { command: 'npx', args: ['tsx', STDIO_ENTRY], env } },
      note: 'Pinned to this project/person scope; the connected agent cannot change it. Not yet verified against a real Claude Code install.',
    };
  });
}
