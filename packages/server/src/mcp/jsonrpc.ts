/** Minimal MCP (JSON-RPC 2.0) handler: initialize, ping, tools/list, tools/call. Transport-agnostic. */
import { getTools, callTool, type ToolContext } from './tools.js';

export const SERVER_INFO = { name: 'aimax', version: '0.1.0' };
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

type Id = string | number | null;
interface Req { jsonrpc?: string; id?: Id; method?: string; params?: Record<string, unknown> }
export interface Res { jsonrpc: '2.0'; id: Id; result?: unknown; error?: { code: number; message: string } }

const ok = (id: Id, result: unknown): Res => ({ jsonrpc: '2.0', id, result });
const fail = (id: Id, code: number, message: string): Res => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Returns the response, or null for notifications (which must not be answered). */
export function handleMessage(msg: unknown, ctx: ToolContext): Res | null {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail(null, -32600, 'Invalid Request');
  const m = msg as Req;
  const isNotification = m.id === undefined;
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return isNotification ? null : fail(m.id ?? null, -32600, 'Invalid Request');
  const id = m.id ?? null;

  switch (m.method) {
    case 'initialize': {
      const asked = typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '';
      return ok(id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: ctx.pinned
          ? 'AImax engineering memory. This connection is pinned to one project/person scope chosen by the user; tool arguments cannot change it. Saved items are marked "inferred" until the user confirms them.'
          : 'AImax engineering memory.',
      });
    }
    case 'ping': return ok(id, {});
    case 'tools/list': return ok(id, { tools: getTools(ctx.pinned) });
    case 'tools/call': {
      const name = m.params?.name; const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== 'string' || !getTools(ctx.pinned).some(t => t.name === name)) return fail(id, -32602, `Unknown tool: ${String(name)}`);
      if (typeof args !== 'object' || Array.isArray(args)) return fail(id, -32602, 'arguments must be an object');
      try {
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(callTool(name, args, ctx), null, 2) }] });
      } catch (err) {
        // Tool failures are results with isError, not protocol errors, so the model can see and react to them.
        return ok(id, { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] });
      }
    }
    default:
      if (m.method.startsWith('notifications/')) return null;
      return isNotification ? null : fail(id, -32601, `Method not found: ${m.method}`);
  }
}
