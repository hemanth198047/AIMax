import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-pk-'));
const Fastify = (await import('fastify')).default; const multipart = (await import('@fastify/multipart')).default;
const { projectsRoutes } = await import('../src/routes/projects.js');
const { projectKnowledgeRoutes } = await import('../src/routes/projectKnowledge.js');
const { knowledgeBlock, KNOWLEDGE_CAP_CHARS } = await import('../src/projects/knowledge.js');
let app: Awaited<ReturnType<typeof Fastify>>;
before(async () => { app = Fastify(); await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); await app.register(projectsRoutes); await app.register(projectKnowledgeRoutes); await app.ready(); });
after(() => app.close());
const j = async (method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: object) => { const r = await app.inject({ method, url, payload }); return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }; };
const upload = async (pid: string, name: string, content: string, type = 'text/plain') => {
  const b = '----x'; const body = `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n${content}\r\n--${b}--\r\n`;
  const r = await app.inject({ method: 'POST', url: `/api/projects/${pid}/knowledge/file`, payload: body, headers: { 'content-type': `multipart/form-data; boundary=${b}` } });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};

test('project knowledge: add a note and a file, list with the meter, view, delete', async () => {
  const p = (await j('POST', '/api/projects', { name: 'K1' })).body;
  assert.equal((await j('POST', `/api/projects/${p.id}/knowledge/note`, { title: 'Style', text: 'Always use tabs, never spaces.' })).status, 200);
  const up = await upload(p.id, 'notes.txt', 'The deploy key rotates every 90 days.'); assert.equal(up.status, 200);
  const l = (await j('GET', `/api/projects/${p.id}/knowledge`)).body;
  assert.equal(l.items.length, 2); assert.equal(l.capChars, KNOWLEDGE_CAP_CHARS); assert.ok(l.usedChars > 50);
  assert.match((await j('GET', `/api/projects/${p.id}/knowledge/${up.body.id}`)).body.text, /deploy key/);
  assert.equal((await j('DELETE', `/api/projects/${p.id}/knowledge/${up.body.id}`)).status, 200);
  assert.equal((await j('GET', `/api/projects/${p.id}/knowledge`)).body.items.length, 1);
  assert.equal((await j('POST', `/api/projects/${p.id}/knowledge/note`, { text: '   ' })).status, 400);
  assert.equal((await j('GET', '/api/projects/nope/knowledge')).status, 404);
  assert.equal((await upload(p.id, 'x.bin', '\u0000\u0001\u0002', 'application/octet-stream')).status, 422);
  assert.equal((await j('POST', `/api/projects/${p.id}/knowledge/link`, { url: 'nope' })).status, 400);
});

test('knowledge is strictly per project: other projects cannot see, fetch or delete it, and chat context never mixes', async () => {
  const a = (await j('POST', '/api/projects', { name: 'KA' })).body; const b = (await j('POST', '/api/projects', { name: 'KB' })).body;
  const n = (await j('POST', `/api/projects/${a.id}/knowledge/note`, { title: 'Secret', text: 'The launch codename is ZEBRA-PRIME.' })).body;
  assert.equal((await j('GET', `/api/projects/${b.id}/knowledge/${n.id}`)).status, 404);
  assert.equal((await j('DELETE', `/api/projects/${b.id}/knowledge/${n.id}`)).status, 404);
  assert.deepEqual((await j('GET', `/api/projects/${b.id}/knowledge`)).body.items, []);
  assert.match(knowledgeBlock(a.id, ['what is the launch codename']).text, /ZEBRA-PRIME/);
  assert.equal(knowledgeBlock(b.id, ['what is the launch codename']).text, ''); assert.equal(knowledgeBlock(null, ['x']).text, '');
});

test('retrieval: small knowledge is included whole; large knowledge returns only matching chunks within the budget', async () => {
  const p = (await j('POST', '/api/projects', { name: 'K3' })).body;
  await j('POST', `/api/projects/${p.id}/knowledge/note`, { title: 'Small', text: 'tiny fact about hummingbirds' });
  assert.match(knowledgeBlock(p.id, ['unrelated question']).text, /hummingbirds/);
  const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} about generic things and filler words that mean nothing here, ${'lorem ipsum '.repeat(15)}`).join('\n\n');
  await j('POST', `/api/projects/${p.id}/knowledge/note`, { title: 'Big', text: `${filler}\n\nThe migration to postgres happens on Friday and needs a backup first.\n\n${filler}` });
  const r = knowledgeBlock(p.id, ['when is the postgres migration'], 3000);
  assert.match(r.text, /postgres happens on Friday/); assert.ok(r.used <= 3000); assert.ok(!r.text.includes('Paragraph 30'));
  assert.deepEqual(r.files.sort(), ['Big', 'Small']);
});

test('capacity: adding past the cap is refused with a clear message', async () => {
  const p = (await j('POST', '/api/projects', { name: 'K4' })).body;
  for (let i = 0; i < 3; i++) assert.equal((await j('POST', `/api/projects/${p.id}/knowledge/note`, { text: 'a'.repeat(199_000) })).status, 200);
  const r = await j('POST', `/api/projects/${p.id}/knowledge/note`, { text: 'b'.repeat(199_000) }); assert.equal(r.status, 413); assert.match(r.body.error, /full/);
});

test('deleting a project removes its knowledge', async () => {
  const { getDb } = await import('../src/db/index.js');
  const p = (await j('POST', '/api/projects', { name: 'K5' })).body; await j('POST', `/api/projects/${p.id}/knowledge/note`, { text: 'x y z' });
  getDb().prepare('DELETE FROM projects WHERE id=?').run(p.id);
  assert.equal((getDb().prepare('SELECT COUNT(*) n FROM project_knowledge WHERE project_id=?').get(p.id) as { n: number }).n, 0);
});
