import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-hard-'));
const Fastify = (await import('fastify')).default;
const { projectsRoutes } = await import('../src/routes/projects.js');
const { knowledgeRoutes } = await import('../src/routes/knowledge.js');
const { tasksRoutes } = await import('../src/routes/tasks.js');
const { mcpRoutes } = await import('../src/mcp/server.js');
const { getDb } = await import('../src/db/index.js');

let app: Awaited<ReturnType<typeof Fastify>>;
const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as object | undefined });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
before(async () => {
  app = Fastify();
  for (const r of [projectsRoutes, knowledgeRoutes, tasksRoutes, mcpRoutes]) await app.register(r);
  await app.ready();
});
after(() => app.close());

test('PATCH ignores unknown/hostile fields and cannot touch id or SQL', async () => {
  const p = (await call('POST', '/api/projects', { name: 'A' })).body;
  const r = await call('PATCH', `/api/projects/${p.id}`, { description: 'ok', 'name=?,id': 'hack', id: 'stolen', 'x; DROP TABLE projects; --': 1 });
  assert.equal(r.status, 200);
  assert.equal(r.body.description, 'ok'); assert.equal(r.body.id, p.id); assert.equal(r.body.name, 'A');
  assert.equal((getDb().prepare('SELECT COUNT(*) n FROM projects').get() as { n: number }).n, 1);
});
test('PATCH: empty update → 400, missing row → 404, arrays are stored as JSON', async () => {
  const p = (await call('POST', '/api/projects', { name: 'B' })).body;
  assert.equal((await call('PATCH', `/api/projects/${p.id}`, { bogus: 1 })).status, 400);
  assert.equal((await call('PATCH', '/api/projects/nope', { name: 'x' })).status, 404);
  assert.equal((await call('PATCH', '/api/tasks/nope', { title: 'x' })).status, 404);
  assert.equal((await call('PATCH', `/api/projects/${p.id}`, { tags: ['a', 'b'] })).body.tags, '["a","b"]');
});

test('knowledge is project-scoped: no project → only global rows; project → global + own', async () => {
  const P1 = (await call('POST', '/api/projects', { name: 'P1' })).body.id;
  const P2 = (await call('POST', '/api/projects', { name: 'P2' })).body.id;
  await call('POST', '/api/solutions', { problem: 'flaky widget', fix: 'global fix' });
  await call('POST', '/api/solutions', { project_id: P1, problem: 'flaky widget', fix: 'p1 fix' });
  await call('POST', '/api/solutions', { project_id: P2, problem: 'flaky widget', fix: 'p2 fix' });
  const fixes = (r: { body: { fix: string }[] }) => r.body.map(x => x.fix).sort();

  assert.deepEqual(fixes(await call('GET', '/api/solutions?q=flaky')), ['global fix']);
  assert.deepEqual(fixes(await call('GET', `/api/solutions?q=flaky&project_id=${P1}`)), ['global fix', 'p1 fix']);

  const mcp = async (name: string, args: object) =>
    JSON.parse((await call('POST' as 'POST', '/mcp/call', { name, arguments: args })).body.content[0].text);
  assert.deepEqual((await mcp('find_solution', { problem: 'flaky' })).map((x: { fix: string }) => x.fix), ['global fix']);
  assert.deepEqual((await mcp('find_solution', { problem: 'flaky', project_id: P2 })).map((x: { fix: string }) => x.fix).sort(), ['global fix', 'p2 fix']);

  const fp = (await call('POST', '/api/fingerprint', { intent: 'flaky widget', project_id: P1 })).body;
  const fpFix = fp.existing_work.filter((w: { source: string }) => w.source === 'solution').map((w: { content: string }) => w.content);
  assert.ok(!fpFix.includes('p2 fix')); assert.ok(fpFix.includes('p1 fix'));
});
