/**
 * AImax MCP server over stdio (newline-delimited JSON-RPC), for Claude Code and other MCP clients.
 *   AIMAX_MCP_PROJECT_ID / AIMAX_MCP_PERSON_ID pin the scope. stdout carries protocol only; logs go to stderr.
 */
import { createInterface } from 'node:readline';
import { handleMessage } from './jsonrpc.js';
import { contextFromEnv } from './tools.js';

const ctx = contextFromEnv();
const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');
console.error(`[aimax-mcp] ready (project=${ctx.projectId ?? '-'} person=${ctx.personId ?? '-'})`);

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let msg: unknown;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const items = Array.isArray(msg) ? msg : [msg];
  for (const it of items) { const r = handleMessage(it, ctx); if (r) send(r); }
}).on('close', () => process.exit(0));
