import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

const DIR = mkdtempSync(join(tmpdir(), 'aimax-mcp-'));
process.env.AIMAX_DATA_DIR = DIR;
const { getDb } = await import('../src/db/index.js');
const STDIO = join(dirname(fileURLToPath(import.meta.url)), '../src/mcp/stdio.ts');

class Client {
  proc: ChildProcessWithoutNullStreams; n = 0; waiting = new Map<number, (r: any) => void>(); raw: string[] = []; stderr = '';
  constructor(env: Record<string, string>) {
    this.proc = spawn(process.execPath, ['--import', 'tsx', STDIO], { env: { ...process.env, AIMAX_DATA_DIR: DIR, ...env } });
    createInterface({ input: this.proc.stdout }).on('line', l => { this.raw.push(l); const m = JSON.parse(l); this.waiting.get(m.id)?.(m); });
    this.proc.stderr.on('data', d => this.stderr += d);
  }
  req(method: string, params?: object): Promise<any> {
    const id = ++this.n;
    return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`timeout ${method}\n${this.stderr}`)), 15000); this.waiting.set(id, r => { clearTimeout(t); res(r); }); this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  }
  notify(method: string) { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); }
  async call(name: string, args: object = {}) { const r = await this.req('tools/call', { name, arguments: args }); return r.result?.isError ? { error: r.result.content[0].text } : r.result ? JSON.parse(r.result.content[0].text) : r; }
  close() { this.proc.kill(); }
}

const add = (id: string, scope: string, project: string | null, person: string | null, title: string, content: string) => {
  const now = new Date().toISOString();
  getDb().prepare('INSERT INTO memory_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, scope, project, person, 'note', title, content, 'user_provided', 1, '[]', null, now, now);
};
const clients: Client[] = [];
const open = (env: Record<string, string>) => { const c = new Client(env); clients.push(c); return c; };

before(() => {
  const db = getDb(); db.pragma('foreign_keys = OFF');
  const now = new Date().toISOString();
  for (const [id, name] of [['P1', 'Proj One'], ['P2', 'Proj Two']]) db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(id, name, now, now);
  for (const [id, name] of [['X', 'Xena'], ['Y', 'Yuri']]) db.prepare('INSERT INTO people(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run(id, name, now, now);
  db.prepare('INSERT INTO project_people(project_id,person_id,role) VALUES(?,?,?)').run('P1', 'X', 'dev');
  add('g', 'global', null, null, 'Global', 'mango global');
  add('p1', 'project', 'P1', null, 'P1 note', 'mango project-one');
  add('p2', 'project', 'P2', null, 'P2 secret', 'mango project-two');
  add('x', 'person', null, 'X', 'X private', 'mango xena-private');
  add('p1x', 'project_person', 'P1', 'X', 'P1X private', 'mango p1-xena');
  db.prepare('INSERT INTO solutions(id,project_id,problem,fix) VALUES(?,?,?,?)').run('s1', 'P1', 'mango crash', 'fix one');
  db.prepare('INSERT INTO solutions(id,project_id,problem,fix) VALUES(?,?,?,?)').run('s2', 'P2', 'mango crash two', 'fix two');
});
after(() => clients.forEach(c => c.close()));

test('stdio handshake: initialize, notification is not answered, tools/list, ping, unknown method', async () => {
  const c = open({ AIMAX_MCP_PROJECT_ID: 'P1' });
  const init = await c.req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.equal(init.result.serverInfo.name, 'aimax');
  assert.ok(init.result.capabilities.tools);
  c.notify('notifications/initialized');
  const list = await c.req('tools/list');
  assert.ok(list.result.tools.length >= 10);
  assert.ok(list.result.tools.every((t: any) => t.inputSchema.type === 'object'));
  assert.ok(list.result.tools.every((t: any) => !('project_id' in t.inputSchema.properties)), 'pinned server must not advertise scope args');
  assert.deepEqual((await c.req('ping')).result, {});
  assert.equal((await c.req('nope/method')).error.code, -32601);
  assert.equal((await c.req('tools/call', { name: 'does_not_exist' })).error.code, -32602);
  assert.equal(c.raw.length, 5, 'exactly one response per request — the notification got none');
  assert.ok(c.raw.every(l => JSON.parse(l).jsonrpc === '2.0'), 'stdout carries protocol only');
});

test('pinned to project P1: sees global + P1 only; cannot be widened by arguments', async () => {
  const c = open({ AIMAX_MCP_PROJECT_ID: 'P1' });
  await c.req('initialize', { protocolVersion: '2025-06-18' });
  const titles = (await c.call('search_memory', { query: 'mango' })).map((m: any) => m.title).sort();
  assert.deepEqual(titles, ['Global', 'P1 note']);
  const hijack = (await c.call('search_memory', { query: 'mango', project_id: 'P2', person_id: 'X', scope: 'person' })).map((m: any) => m.title).sort();
  assert.deepEqual(hijack, ['Global', 'P1 note'], 'argument overrides are ignored');
  assert.deepEqual((await c.call('find_solution', { problem: 'mango', project_id: 'P2' })).map((s: any) => s.id), ['s1']);
  assert.deepEqual((await c.call('list_projects')).map((p: any) => p.id), ['P1']);
  assert.deepEqual((await c.call('list_people')).map((p: any) => p.id), ['X']);
  const ctx = await c.call('get_project_context', { project_id: 'P2' });
  assert.equal(ctx.project.id, 'P1');
  assert.ok(!JSON.stringify(ctx).includes('xena'), 'person-private memory not in project-only context');
  assert.ok(!JSON.stringify(ctx).includes('project-two'));
});

test('pinned to P1 + person X: also sees the private entries; person-only and unpinned-global stay isolated', async () => {
  const px = open({ AIMAX_MCP_PROJECT_ID: 'P1', AIMAX_MCP_PERSON_ID: 'X' });
  await px.req('initialize');
  assert.deepEqual((await px.call('search_memory', { query: 'mango' })).map((m: any) => m.title).sort(), ['Global', 'P1 note', 'P1X private', 'X private']);
  const only = open({ AIMAX_MCP_PERSON_ID: 'X' });
  await only.req('initialize');
  assert.deepEqual((await only.call('search_memory', { query: 'mango' })).map((m: any) => m.title).sort(), ['Global', 'X private']);
  const none = open({});
  await none.req('initialize');
  assert.deepEqual((await none.call('search_memory', { query: 'mango' })).map((m: any) => m.title), ['Global']);
  assert.deepEqual(await none.call('list_projects'), []);
  assert.deepEqual(await none.call('list_people'), []);
  assert.deepEqual((await none.call('find_solution', { problem: 'mango' })), [], 'no project → only global solutions');
});

test('writes land at exactly the active scope, marked inferred, and validate input', async () => {
  const c = open({ AIMAX_MCP_PROJECT_ID: 'P1', AIMAX_MCP_PERSON_ID: 'X' });
  await c.req('initialize');
  const saved = await c.call('save_memory', { title: 'Agent note', content: 'kumquat finding', scope: 'global', project_id: 'P2', provenance: 'verified' });
  assert.equal(saved.scope, 'project_person'); assert.equal(saved.provenance, 'inferred');
  const row = getDb().prepare('SELECT * FROM memory_entries WHERE id=?').get(saved.id) as any;
  assert.deepEqual([row.scope, row.project_id, row.person_id, row.provenance], ['project_person', 'P1', 'X', 'inferred']);
  const g = open({}); await g.req('initialize');
  assert.deepEqual(await g.call('search_memory', { query: 'kumquat' }), [], 'not visible outside its scope');
  assert.match((await c.call('save_memory', { title: 'x' })).error, /content.*required/);
  assert.match((await c.call('save_memory', { title: 'x', content: 'y'.repeat(30000) })).error, /too long/);
  assert.match((await c.call('search_memory', { query: 5 })).error, /string/);
  const sol = await c.call('save_solution', { problem: 'p', fix: 'f', tags: ['a', 3] });
  assert.equal(getDb().prepare('SELECT project_id, tags FROM solutions WHERE id=?').get(sol.id)!['project_id' as never], 'P1');
});

test('HTTP /mcp and /mcp/config', async () => {
  const { default: Fastify } = await import('fastify');
  const { mcpRoutes } = await import('../src/mcp/server.js');
  const app = Fastify(); await app.register(mcpRoutes); await app.ready();
  const r = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.ok(r.json().result.tools.some((t: any) => t.inputSchema.properties.project_id), 'unpinned HTTP names scope in args');
  assert.equal((await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', method: 'notifications/initialized' } })).statusCode, 202);
  const cfg = (await app.inject({ url: '/mcp/config?project_id=P1&person_id=X' })).json();
  assert.equal(cfg.mcpServers.aimax.env.AIMAX_MCP_PROJECT_ID, 'P1');
  assert.equal(cfg.mcpServers.aimax.env.AIMAX_MCP_PERSON_ID, 'X');
  assert.match(cfg.mcpServers.aimax.args[1], /stdio\.ts$/);
  await app.close();
});
