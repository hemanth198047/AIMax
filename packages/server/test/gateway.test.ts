import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-gw-'));
const { classifyTask } = await import('../src/gateway/classify.js');
const { enhancePrompt, systemInstructions } = await import('../src/gateway/enhance.js');
const { buildContext, keywords } = await import('../src/gateway/context.js');
const { getDb } = await import('../src/db/index.js');

test('classification covers the main task types', () => {
  const cases: Array<[string, string]> = [
    ['The login endpoint crashes with a NullPointerException', 'bugfix'],
    ['Write unit tests for the invoice service', 'testing'],
    ['Refactor the user module to remove duplication', 'refactor'],
    ['Make the sidebar responsive and fix the CSS', 'ui'],
    ['Add a new endpoint to export reports', 'feature'],
    ['Compare Postgres and MongoDB for this workload', 'research'],
    ['Is there an XSS vulnerability in this template?', 'security'],
    ['Write a README for this repo', 'documentation'],
    ['What is a closure?', 'question'],
  ];
  for (const [text, expected] of cases) assert.equal(classifyTask(text).type, expected, text);
});
test('complexity grows with scope and size', () => {
  assert.equal(classifyTask('rename x').complexity, 'low');
  assert.equal(classifyTask('Refactor every module across the whole codebase and then also update all services and then also the docs and then also the tests').complexity, 'high');
});
test('enhancement never rewrites the user text and is deterministic', () => {
  const msg = 'Fix the failing login test';
  for (const mode of ['off', 'minimal'] as const) assert.equal(enhancePrompt(msg, { mode, taskType: 'bugfix' }).text, msg);
  const b1 = enhancePrompt(msg, { mode: 'balanced', taskType: 'bugfix' });
  assert.ok(b1.text.startsWith(msg + '\n\n[AImax guidance'));
  assert.deepEqual(b1, enhancePrompt(msg, { mode: 'balanced', taskType: 'bugfix' }));
  const max = enhancePrompt(msg, { mode: 'maximum', taskType: 'bugfix' });
  assert.match(max.text, /root cause/); assert.ok(max.text.length > b1.text.length);
});
test('system instructions teach the approval protocol and include project instructions', () => {
  const s = systemInstructions({ projectInstructions: 'Use tabs.', mode: 'balanced' });
  assert.match(s, /aimax-run/); assert.match(s, /Use tabs\./); assert.match(s, /untrusted/);
});
test('keywords drops stop-words and dedupes', () => {
  assert.deepEqual(keywords('What is the pelican protocol for the pelican release?'), ['pelican', 'protocol', 'release']);
});

before(() => {
  const db = getDb(); db.pragma('foreign_keys = OFF');
  const add = (id: string, scope: string, p: string | null, x: string | null, title: string, content: string) =>
    db.prepare('INSERT INTO memory_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, scope, p, x, 'note', title, content, 'user_provided', 1, '[]', null, 'n', 'n');
  add('a', 'project', 'P', null, 'Rollout plan', 'The canary rollout uses a 5 percent cohort first');
  add('b', 'project', 'Q', null, 'Other rollout', 'canary rollout for project Q is secret');
  add('c', 'global', null, null, 'Huge', 'canary ' + 'x'.repeat(5000));
});
test('follow-ups find context through earlier user turns', () => {
  const r = buildContext({ message: 'and what about the cohort size?', recentUserMessages: ['Explain the canary rollout'], scope: { projectId: 'P' } });
  assert.ok(r.items.some(i => i.id === 'a'), 'found via the earlier turn');
  assert.ok(!r.items.some(i => i.id === 'b'), 'other project invisible');
});
test('context respects the character budget and truncates long entries', () => {
  const r = buildContext({ message: 'canary rollout', recentUserMessages: [], scope: { projectId: 'P' }, budgetChars: 400 });
  assert.ok(r.usedChars <= 400);
  const big = buildContext({ message: 'canary', recentUserMessages: [], scope: {}, budgetChars: 5000 });
  assert.ok(big.items.every(i => i.chars <= 1000));
});
test('empty/stop-word-only messages retrieve nothing', () => {
  assert.deepEqual(buildContext({ message: 'what is it', recentUserMessages: [], scope: {} }).items, []);
});
