import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-test-'));

const { getDb } = await import('../src/db/index.js');
const { searchMemory, listMemory } = await import('../src/memory/search.js');

const P1 = 'proj-1', P2 = 'proj-2', X = 'person-x', Y = 'person-y';

function add(id: string, scope: string, project: string | null, person: string | null, title: string, content: string) {
  const now = new Date().toISOString();
  getDb().prepare('INSERT INTO memory_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, scope, project, person, 'note', title, content, 'user_provided', 1, '[]', null, now, now);
}

before(() => {
  const db = getDb();
  db.pragma('foreign_keys = OFF');
  add('g', 'global', null, null, 'Global tip', 'kiwi shared knowledge');
  add('p1', 'project', P1, null, 'P1 note', 'kiwi project one secret');
  add('p2', 'project', P2, null, 'P2 note', 'kiwi project two secret');
  add('x', 'person', null, X, 'X note', 'kiwi person x private');
  add('y', 'person', null, Y, 'Y note', 'kiwi person y private');
  add('p1x', 'project_person', P1, X, 'P1X note', 'kiwi p1 with x private');
});

const ids = (rows: { id: string }[]) => rows.map(r => r.id).sort();

test('global context sees only global entries', () => {
  assert.deepEqual(ids(searchMemory('kiwi', {})), ['g']);
});

test('project context sees global + its own project only', () => {
  assert.deepEqual(ids(searchMemory('kiwi', { projectId: P1 })), ['g', 'p1']);
  assert.deepEqual(ids(searchMemory('kiwi', { projectId: P2 })), ['g', 'p2']);
});

test('person context never sees other people or any project entries', () => {
  assert.deepEqual(ids(searchMemory('kiwi', { personId: X })), ['g', 'x']);
});

test('project+person context sees the combined entry but not other people/projects', () => {
  assert.deepEqual(ids(searchMemory('kiwi', { projectId: P1, personId: X })), ['g', 'p1', 'p1x', 'x']);
});

test('project_person entry is invisible to project-only and person-only contexts', () => {
  assert.ok(!ids(searchMemory('kiwi', { projectId: P1 })).includes('p1x'));
  assert.ok(!ids(searchMemory('kiwi', { personId: X })).includes('p1x'));
});

test('listMemory enforces the same scope rules', () => {
  assert.deepEqual(ids(listMemory({ projectId: P2 })), ['g', 'p2']);
});

test('deleting an entry does not corrupt FTS (regression)', () => {
  getDb().prepare("DELETE FROM memory_entries WHERE id='p1'").run();
  assert.deepEqual(ids(searchMemory('kiwi', { projectId: P1 })), ['g']);
  assert.deepEqual(ids(searchMemory('kiwi', { projectId: P2 })), ['g', 'p2']);
});

test('updating an entry re-indexes it', () => {
  getDb().prepare("UPDATE memory_entries SET content='mango only now' WHERE id='p2'").run();
  assert.equal(searchMemory('mango', { projectId: P2 }).length, 1);
  assert.ok(!ids(searchMemory('kiwi', { projectId: P2 })).includes('p2'));
});

test('FTS special characters in user text do not throw', () => {
  assert.doesNotThrow(() => searchMemory('foo" OR (bar* NEAR', {}));
  assert.deepEqual(searchMemory('!!!', {}), []);
});
