import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-vis-'));
const { default: Fastify } = await import('fastify');
const { getDb } = await import('../src/db/index.js');
const { conversationsRoutes } = await import('../src/routes/conversations.js');
const { tasksRoutes } = await import('../src/routes/tasks.js');
const { knowledgeRoutes } = await import('../src/routes/knowledge.js');

test('conversations, tasks and decisions obey the same scope rules as memory', async () => {
  const db = getDb(); db.pragma('foreign_keys = OFF');
  const now = new Date().toISOString();
  const conv = (id: string, p: string | null, x: string | null) => db.prepare('INSERT INTO conversations(id,title,project_id,person_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, id, p, x, now, now);
  const task = (id: string, p: string | null, x: string | null) => db.prepare('INSERT INTO tasks(id,title,project_id,person_id) VALUES(?,?,?,?)').run(id, id, p, x);
  const dec = (id: string, p: string | null, x: string | null) => db.prepare('INSERT INTO decisions(id,title,project_id,person_id) VALUES(?,?,?,?)').run(id, id, p, x);
  for (const f of [conv, task, dec]) { f('g', null, null); f('p1', 'P1', null); f('p2', 'P2', null); f('x', null, 'X'); f('p1x', 'P1', 'X'); }

  const app = Fastify(); await app.register(conversationsRoutes); await app.register(tasksRoutes); await app.register(knowledgeRoutes); await app.ready();
  const ids = async (path: string, q: string) => ((await app.inject({ url: `${path}?${q}` })).json() as { id: string }[]).map(r => r.id).sort();

  for (const path of ['/api/conversations', '/api/tasks']) {
    assert.deepEqual(await ids(path, ''), ['g'], `${path}: no context → global only`);
    assert.deepEqual(await ids(path, 'project_id=P1'), ['g', 'p1']);
    assert.deepEqual(await ids(path, 'person_id=X'), ['g', 'x']);
    assert.deepEqual(await ids(path, 'project_id=P1&person_id=X'), ['g', 'p1', 'p1x', 'x']);
    assert.deepEqual(await ids(path, 'project_id=P2&person_id=X'), ['g', 'p2', 'x'], 'P1+X private rows not visible under P2+X');
  }
  assert.deepEqual(await ids('/api/decisions', ''), ['g']);
  assert.deepEqual(await ids('/api/decisions', 'project_id=P1'), ['g', 'p1']);
  assert.deepEqual(await ids('/api/decisions', 'project_id=P1&person_id=X'), ['g', 'p1', 'p1x', 'x']);
  await app.close();
});

test('conversation list: search (title + message text), pin order, archive, LIKE wildcards are literal', async () => {
  const db = getDb(); db.pragma('foreign_keys = OFF');
  const t = (n: number) => new Date(Date.now() + n * 1000).toISOString();
  const conv = (id: string, title: string, o: { pinned?: number; archived?: number; at?: number } = {}) =>
    db.prepare('INSERT INTO conversations(id,title,pinned,archived,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, title, o.pinned ?? 0, o.archived ?? 0, t(o.at ?? 0), t(o.at ?? 0));
  conv('c-old', 'Old chat about apples', { at: -100 }); conv('c-new', 'Newest chat', { at: 100 }); conv('c-pin', 'Pinned chat', { pinned: 1, at: -200 });
  conv('c-arch', 'Archived apples', { archived: 1 }); conv('c-pct', '100% done');
  db.prepare('INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)').run('m1', 'c-new', 'user', 'tell me about kumquats', t(0));
  const app = Fastify(); await app.register(conversationsRoutes); await app.ready();
  const ids = async (q: string) => ((await app.inject({ url: `/api/conversations?${q}` })).json() as { id: string }[]).map(r => r.id);
  assert.deepEqual((await ids('')).slice(0, 2), ['c-pin', 'c-new'], 'pinned first, then newest');
  assert.ok(!(await ids('')).includes('c-arch'));
  assert.deepEqual(await ids('archived=1'), ['c-arch']);
  assert.deepEqual(await ids('q=apples'), ['c-old']);
  assert.deepEqual(await ids('q=kumquats'), ['c-new'], 'matches message text');
  assert.deepEqual(await ids('q=' + encodeURIComponent('%')), ['c-pct'], '% is literal, not a wildcard');
  assert.deepEqual(await ids('q=' + encodeURIComponent('_')), [], '_ is literal');
  await app.close();
});

test('handoff summary: deterministic, quotes stored messages, honest footer, hidden outside its context', async () => {
  const db = getDb(); db.pragma('foreign_keys = OFF');
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,name,created_at,updated_at) VALUES('HP','Handoff Proj',?,?)").run(now, now);
  db.prepare("INSERT INTO conversations(id,title,scope,project_id,created_at,updated_at) VALUES('hc','Plan the migration','project','HP',?,?)").run(now, now);
  const m = (id: string, role: string, content: string, extra = '[]', prov = '') =>
    db.prepare('INSERT INTO messages(id,conversation_id,role,content,attachments,provider,created_at) VALUES(?,?,?,?,?,?,?)').run(id, 'hc', role, content, extra, prov, new Date(Date.now() + Number(id.slice(1))).toISOString());
  m('h1', 'user', 'How do we migrate the billing tables?', JSON.stringify([{ filename: 'schema.sql', size: 1234 }]));
  m('h2', 'assistant', 'Use an expand/contract migration.\n\nStep one: add columns.', '[]', 'claude');
  m('h3', 'user', 'And rollback?');
  db.prepare("INSERT INTO tasks(id,title,conversation_id,status) VALUES('ht','Write rollback script','hc','pending')").run();
  const app = Fastify(); await app.register(conversationsRoutes); await app.ready();
  const r = await app.inject({ url: '/api/conversations/hc/handoff?project_id=HP' });
  assert.equal(r.statusCode, 200);
  const md = r.json().markdown as string;
  for (const part of ['# Handoff: Plan the migration', 'project "Handoff Proj"', 'answered by claude', 'How do we migrate the billing tables?', 'And rollback?',
    'expand/contract migration. Step one: add columns.', 'schema.sql (1234 bytes)', '[pending] Write rollback script', 'without a model']) assert.ok(md.includes(part), part);
  assert.equal((await app.inject({ url: '/api/conversations/hc/handoff' })).statusCode, 404, 'not visible from global context');
  assert.equal((await app.inject({ url: '/api/conversations/hc/handoff?project_id=OTHER' })).statusCode, 404);
  await app.close();
});
