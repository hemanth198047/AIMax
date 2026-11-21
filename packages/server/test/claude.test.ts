import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-cl-'));
const LOG = join(process.env.AIMAX_DATA_DIR, 'fake.log');
process.env.FAKE_CLAUDE_LOG = LOG; writeFileSync(LOG, '');
process.env.AIMAX_CLAUDE_BIN = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');
process.env.AIMAX_TEST_PROVIDER = '1';
const IS_POSIX = process.platform !== 'win32';

const { claudeChat, DENIED_TOOLS, _resetClaudeCache } = await import('../src/providers/claude.js');
const Fastify = (await import('fastify')).default;
const { chatRoutes } = await import('../src/routes/chat.js');
const { getDb } = await import('../src/db/index.js');

const calls = () => readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const reset = () => { writeFileSync(LOG, ''); _resetClaudeCache(); };
const alive = (pid: number) => { try { process.kill(pid, 0); } catch { return false; } try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'; } catch { return true; } };
const U = (c: string) => ({ role: 'user' as const, content: c });
const A = (c: string) => ({ role: 'assistant' as const, content: c });

test('streams deltas, returns the session id, and locks the CLI down', { skip: !IS_POSIX }, async () => {
  reset(); process.env.FAKE_CLAUDE_MODE = 'ok';
  const chunks: string[] = [];
  const r = await claudeChat([U('hi')], 'SYSTEM-TEXT', c => chunks.push(c));
  assert.deepEqual(chunks, ['Hello ', 'world']);
  assert.equal(r.text, 'Hello world'); assert.match(r.sessionId!, /^sess-/); assert.equal(r.resumed, false);
  const [c] = calls();
  for (const f of ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']) assert.ok(c.args.includes(f), f);
  assert.equal(c.args[c.args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(c.args[c.args.indexOf('--disallowedTools') + 1], DENIED_TOOLS);
  for (const t of ['Bash', 'Edit', 'Write', 'Read', 'WebFetch']) assert.ok(DENIED_TOOLS.split(',').includes(t), t);
  assert.equal(c.stdin, 'hi', 'prompt goes over stdin, not argv');
  assert.ok(!c.args.includes('hi'));
  assert.equal(c.system, 'SYSTEM-TEXT');
  assert.deepEqual(c.cwdEntries.filter((e: string) => !e.startsWith('.')), [], 'runs in an empty directory');
});
test('resume sends only the new turn', { skip: !IS_POSIX }, async () => {
  reset(); process.env.FAKE_CLAUDE_MODE = 'ok';
  const r = await claudeChat([U('first'), A('answer'), U('second')], 'S', () => {}, { sessionId: 'sess-abc' });
  assert.equal(r.resumed, true); assert.equal(r.sessionId, 'sess-abc');
  const [c] = calls();
  assert.equal(c.resume, 'sess-abc'); assert.equal(c.stdin, 'second', 'no history re-sent');
});
test('failed resume falls back to a fresh session with the full history', { skip: !IS_POSIX }, async () => {
  reset(); process.env.FAKE_CLAUDE_MODE = 'fail-resume';
  const r = await claudeChat([U('first'), A('answer'), U('second')], 'S', () => {}, { sessionId: 'sess-dead' });
  assert.equal(r.resumed, false); assert.equal(r.text, 'Hello world');
  const cs = calls(); assert.equal(cs.length, 2);
  assert.equal(cs[0].resume, 'sess-dead'); assert.equal(cs[1].resume, null);
  assert.match(cs[1].stdin, /Previous conversation:[\s\S]*Human: first[\s\S]*Assistant: answer[\s\S]*Human: second/);
});
test('assistant-only output (no partial deltas) is still streamed', { skip: !IS_POSIX }, async () => {
  reset(); process.env.FAKE_CLAUDE_MODE = 'assistant-only';
  const chunks: string[] = [];
  const r = await claudeChat([U('x')], 'S', c => chunks.push(c));
  assert.deepEqual(chunks, ['Hello world']); assert.equal(r.text, 'Hello world');
});
test('abort kills the CLI process and returns the partial text', { skip: !IS_POSIX }, async () => {
  reset(); process.env.FAKE_CLAUDE_MODE = 'slow';
  const ac = new AbortController(); const chunks: string[] = [];
  const p = claudeChat([U('x')], 'S', c => { chunks.push(c); if (chunks.length === 3) ac.abort(); }, { signal: ac.signal });
  const r = await p;
  assert.ok(r.text.startsWith('s0 s1 s2'), r.text);
  const { pid } = calls()[0];
  for (let i = 0; i < 30 && alive(pid); i++) await new Promise(res => setTimeout(res, 100));
  assert.equal(alive(pid), false, 'CLI process must be dead');
});
test('non-zero exit without output becomes an error', { skip: !IS_POSIX }, async () => {
  reset(); process.env.FAKE_CLAUDE_MODE = 'bad-exit';
  await assert.rejects(claudeChat([U('x')], 'S', () => {}), /code 2.*boom/s);
});

// ── chat route end-to-end (HTTP + SSE) ────────────────────
let app: Awaited<ReturnType<typeof Fastify>>; let base = '';
before(async () => {
  app = Fastify(); await app.register(chatRoutes); await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const db = getDb(); db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO memory_entries VALUES('m1','project','PA',NULL,'note','Canary plan','Roll out canary to 5 percent first','verified',1,'[]',NULL,'n','n')").run();
});
after(() => app.close());

async function chat(body: object, opts: { abortAfterMs?: number } = {}) {
  const ac = new AbortController(); if (opts.abortAfterMs) setTimeout(() => ac.abort(), opts.abortAfterMs);
  const events: { event: string; data: any }[] = [];
  try {
    const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
    if (!res.ok) return { status: res.status, events, json: await res.json() };
    const text = await res.text();
    for (const block of text.split('\n\n')) {
      const ev = /^event: (.+)$/m.exec(block)?.[1]; const d = /^data: (.+)$/m.exec(block)?.[1];
      if (ev && d) events.push({ event: ev, data: JSON.parse(d) });
    }
  } catch (e) { if ((e as Error).name !== 'AbortError') throw e; }
  return { status: 200, events, json: null };
}
const ev = (r: { events: { event: string; data: any }[] }, name: string) => r.events.filter(e => e.event === name).map(e => e.data);
const text = (r: { events: { event: string; data: any }[] }) => ev(r, 'chunk').map(c => c.text).join('');

test('chat: gateway activity, scoped context, enhancement and system protocol reach the provider', async () => {
  const r = await chat({ message: 'Explain the canary rollout', provider: 'test', projectId: 'PA', scope: 'project' });
  const steps = ev(r, 'activity').map(a => a.step);
  for (const s of ['scope', 'classify', 'memory', 'enhance', 'provider']) assert.ok(steps.includes(s), s);
  assert.equal(ev(r, 'context')[0].items[0].title, 'Canary plan');
  const t = text(r);
  assert.match(t, /memory-context: \[Canary plan\] \(verified\)/);
  assert.match(t, /guidance: yes/); assert.match(t, /run-protocol: yes/);
  // other project must not see it
  const other = text(await chat({ message: 'Explain the canary rollout', provider: 'test', projectId: 'PB', scope: 'project' }));
  assert.match(other, /memory-context: none/);
});
test('chat: enhancement can be switched off (user text only)', async () => {
  assert.match(text(await chat({ message: 'hello there friend', provider: 'test', enhance: 'off' })), /guidance: no/);
});
test('chat: follow-ups reuse keywords from earlier turns', async () => {
  const first = await chat({ message: 'Tell me about the canary rollout', provider: 'test', projectId: 'PA', scope: 'project' });
  const convId = ev(first, 'start')[0].conversationId;
  const second = await chat({ conversationId: convId, message: 'and how big is the first cohort?', provider: 'test', projectId: 'PA', scope: 'project' });
  assert.match(text(second), /memory-context: \[Canary plan\]/);
});
test('chat: validation', async () => {
  assert.equal((await chat({ message: '   ', provider: 'test' })).status, 400);
});
test('chat: Stop aborts the provider and saves the partial answer', async () => {
  const r = await chat({ message: 'long one [test:slow]', provider: 'test' }, { abortAfterMs: 600 });
  assert.equal(r.status, 200);
  await new Promise(res => setTimeout(res, 400));
  const row = getDb().prepare("SELECT content FROM messages WHERE role='assistant' AND content LIKE 'slow-0%' ORDER BY created_at DESC LIMIT 1").get() as { content: string } | undefined;
  assert.ok(row, 'partial message persisted'); assert.match(row!.content, /_\(stopped\)_$/);
  assert.ok(!row!.content.includes('slow-59'), 'generation really stopped');
});
test('chat: Claude session is reused within a scope and DISCARDED when the scope changes', { skip: !IS_POSIX }, async () => {
  reset(); process.env.FAKE_CLAUDE_MODE = 'ok';
  const t1 = await chat({ message: 'turn one about canary', provider: 'claude', projectId: 'PA', scope: 'project' });
  const convId = ev(t1, 'start')[0].conversationId;
  assert.ok(ev(t1, 'activity').some(a => a.detail === 'new provider session'));
  const t2 = await chat({ conversationId: convId, message: 'turn two', provider: 'claude', projectId: 'PA', scope: 'project' });
  assert.ok(ev(t2, 'activity').some(a => /resumed provider session/.test(a.detail)));
  const t3 = await chat({ conversationId: convId, message: 'turn three', provider: 'claude', projectId: 'PB', scope: 'project' });
  assert.ok(ev(t3, 'activity').some(a => /context changed/.test(a.detail)), 'scope change must start a fresh session');
  const cs = calls();
  assert.equal(cs[0].resume, null); assert.ok(cs[1].resume); assert.equal(cs[2].resume, null);
  assert.ok(!cs[2].stdin.includes('Canary plan'), 'private context of PA never reaches PB');
  assert.equal(cs[1].stdin.includes('Previous conversation'), false, 'resumed turn sends only the new message');
});
