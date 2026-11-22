import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-agent-'));
const LOG = join(process.env.AIMAX_DATA_DIR, 'fake.log'); writeFileSync(LOG, '');
process.env.FAKE_CLAUDE_LOG = LOG;
process.env.AIMAX_CLAUDE_BIN = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');
const IS_POSIX = process.platform !== 'win32';

const { default: Fastify } = await import('fastify');
const { sandboxRoutes } = await import('../src/routes/sandbox.js');
const { agentRoutes } = await import('../src/routes/agent.js');
const { parseEdits, previewEdits, applyEdits } = await import('../src/sandbox/edits.js');
const { getDb } = await import('../src/db/index.js');
const { _resetClaudeCache } = await import('../src/providers/claude.js');
const usage = await import('../src/providers/usage.js');

const sh = (cwd: string, cmd: string, args: string[]) => spawnSync(cmd, args, { cwd, encoding: 'utf8' });
function repo(files: Record<string, string>, git = true) {
  const d = mkdtempSync(join(tmpdir(), 'aimax-src-'));
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), c); }
  if (git) { sh(d, 'git', ['init', '-q']); sh(d, 'git', ['add', '-A']); sh(d, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']); }
  return d;
}
const block = (file: string, search: string, replace: string) => `FILE: ${file}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;

// ───────────── edit engine ─────────────
test('edits: parse, create, modify, unified diff, sequential edits to one file', () => {
  const root = repo({ 'a.txt': 'one\ntwo\nthree\nfour\nfive\n' }, false);
  assert.equal(parseEdits(block('a.txt', 'two', 'TWO') + block('b/new.txt', '', 'fresh')).length, 2);
  const text = block('a.txt', 'two', 'TWO') + block('a.txt', 'TWO\nthree', 'TWO\nTHREE') + block('b/new.txt', '', 'fresh');
  const pv = previewEdits(root, text);
  assert.equal(pv.ok, true);
  assert.match(pv.edits[0].diff, /^--- a\/a\.txt\n\+\+\+ b\/a\.txt\n@@ -1,\d+ \+1,\d+ @@\n one\n-two\n\+TWO\n three/);
  assert.equal(pv.edits[2].kind, 'create');
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nfour\nfive\n', 'preview writes nothing');
  const r = applyEdits(root, text);
  assert.deepEqual(r.files.sort(), ['a.txt', 'b/new.txt']);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\nTWO\nTHREE\nfour\nfive\n');
  assert.equal(readFileSync(join(root, 'b/new.txt'), 'utf8'), 'fresh');
});
test('edits: CRLF files keep their line endings', () => {
  const root = repo({ 'w.txt': 'a\r\nb\r\nc\r\n' }, false);
  applyEdits(root, block('w.txt', 'a\nb', 'a\nB'));
  assert.equal(readFileSync(join(root, 'w.txt'), 'utf8'), 'a\r\nB\r\nc\r\n');
});
test('edits: not-found, ambiguous, existing-file-create and escapes are rejected, and nothing is written (all-or-nothing)', () => {
  const root = repo({ 'a.txt': 'x\nx\ny\n', 'ok.txt': 'fine\n' }, false);
  const outside = mkdtempSync(join(tmpdir(), 'outside-')); writeFileSync(join(outside, 'secret.txt'), 'S');
  symlinkSync(outside, join(root, 'link'));
  const cases: [string, RegExp][] = [
    [block('a.txt', 'nope', 'z'), /not found/], [block('a.txt', 'x', 'z'), /more than once/], [block('a.txt', '', 'z'), /already exists/],
    [block('../evil.txt', '', 'z'), /escapes/], [block('/etc/passwd', 'root', 'z'), /escapes|does not exist/], [block('link/secret.txt', 'S', 'T'), /escapes/],
    [block('.git/config', '', 'z'), /\.git/], [block('missing.txt', 'a', 'b'), /does not exist/],
  ];
  for (const [text, re] of cases) { const p = previewEdits(root, text); assert.equal(p.ok, false, text); assert.match(p.edits[0].error!, re, text); }
  assert.throws(() => applyEdits(root, block('ok.txt', 'fine', 'CHANGED') + block('a.txt', 'nope', 'z')), /Nothing was changed/);
  assert.equal(readFileSync(join(root, 'ok.txt'), 'utf8'), 'fine\n', 'the valid edit was not applied either');
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'S');
  assert.ok(!existsSync(join(root, '..', 'evil.txt')));
  writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
  assert.match(previewEdits(root, block('bin.dat', 'a', 'b')).edits[0].error!, /Binary/);
  assert.throws(() => parseEdits('no blocks here'), /No SEARCH\/REPLACE/);
  assert.throws(() => parseEdits('<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE'), /no FILE/);
  assert.throws(() => parseEdits('FILE: a\n<<<<<<< SEARCH\na\n'), /separator/);
});

// ───────────── routes: edits, promote, agent ─────────────
let app: Awaited<ReturnType<typeof Fastify>>;
before(async () => { app = Fastify(); await app.register(sandboxRoutes); await app.register(agentRoutes); await app.ready(); });
after(() => app.close());
const j = async (method: 'GET' | 'POST', url: string, payload?: object) => { const r = await app.inject({ method, url, payload }); return { s: r.statusCode, b: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null, raw: r.body }; };
const mk = async (src: string, mode = 'temporary') => (await j('POST', '/api/sandbox', { name: 't', mode, source_path: src })).b;

test('edit routes: preview/apply in a sandbox, checkpoint first, read-only refused, direct needs approval', async () => {
  const src = repo({ 'app.txt': 'hello\n' });
  const sb = await mk(src);
  const prev = await j('POST', `/api/sandbox/${sb.id}/edits/preview`, { edits: block('app.txt', 'hello', 'hi') });
  assert.equal(prev.b.ok, true); assert.equal(readFileSync(join(sb.working_dir, 'app.txt'), 'utf8'), 'hello\n');
  const bad = await j('POST', `/api/sandbox/${sb.id}/edits/apply`, { edits: block('app.txt', 'zzz', 'q') });
  assert.equal(bad.s, 422);
  const ok = await j('POST', `/api/sandbox/${sb.id}/edits/apply`, { edits: block('app.txt', 'hello', 'hi') });
  assert.equal(ok.s, 200); assert.ok(ok.b.checkpoint);
  assert.equal(readFileSync(join(sb.working_dir, 'app.txt'), 'utf8'), 'hi\n');
  assert.equal(readFileSync(join(src, 'app.txt'), 'utf8'), 'hello\n', 'real project untouched');
  const cps = (await j('GET', `/api/sandbox/${sb.id}/checkpoints`)).b; assert.ok(cps.some((c: any) => /before edit: app\.txt/.test(c.label)));
  const ro = await mk(src, 'readonly');
  assert.equal((await j('POST', `/api/sandbox/${ro.id}/edits/apply`, { edits: block('app.txt', 'hello', 'x') })).s, 403);
  assert.equal(readFileSync(join(src, 'app.txt'), 'utf8'), 'hello\n');
});

test('promote: needs confirm; applies only what changed; refuses when the project moved on; undo restores; node_modules excluded', async () => {
  const src = repo({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n', '.gitignore': '' });
  const sb = await mk(src);
  assert.equal((await j('GET', `/api/sandbox/${sb.id}/changes`)).b.files.length, 0);
  assert.equal((await j('POST', `/api/sandbox/${sb.id}/promote`, { confirm: true })).s, 409, 'nothing to apply yet');
  await j('POST', `/api/sandbox/${sb.id}/edits/apply`, { edits: block('a.txt', 'alpha', 'ALPHA') + block('c/new.txt', '', 'brand new') });
  mkdirSync(join(sb.working_dir, 'node_modules/x'), { recursive: true }); writeFileSync(join(sb.working_dir, 'node_modules/x/i.js'), 'junk');
  const ch = (await j('GET', `/api/sandbox/${sb.id}/changes`)).b;
  assert.deepEqual(ch.files.sort(), ['a.txt', 'c/new.txt']); assert.match(ch.patch, /\+ALPHA/); assert.ok(!ch.patch.includes('node_modules'));
  const noConfirm = await j('POST', `/api/sandbox/${sb.id}/promote`, {});
  assert.equal(noConfirm.s, 409); assert.equal(readFileSync(join(src, 'a.txt'), 'utf8'), 'alpha\n');
  const p = await j('POST', `/api/sandbox/${sb.id}/promote`, { confirm: true });
  assert.equal(p.s, 200, p.raw);
  assert.equal(readFileSync(join(src, 'a.txt'), 'utf8'), 'ALPHA\n'); assert.equal(readFileSync(join(src, 'c/new.txt'), 'utf8'), 'brand new');
  assert.equal(readFileSync(join(src, 'b.txt'), 'utf8'), 'beta\n'); assert.ok(!existsSync(join(src, 'node_modules')));
  assert.equal((await j('POST', `/api/sandbox/${sb.id}/promote`, { confirm: true })).s, 409, 'baseline advanced: nothing left to apply');
  // undo
  assert.equal((await j('POST', `/api/sandbox/${sb.id}/promotions/${p.b.id}/undo`)).s, 200);
  assert.equal(readFileSync(join(src, 'a.txt'), 'utf8'), 'alpha\n'); assert.ok(!existsSync(join(src, 'c/new.txt')));
  assert.equal((await j('POST', `/api/sandbox/${sb.id}/promotions/${p.b.id}/undo`)).s, 409, 'cannot undo twice');
});

test('promote refuses to overwrite work you did in the real project meanwhile', async () => {
  const src = repo({ 'a.txt': 'alpha\n' });
  const sb = await mk(src);
  await j('POST', `/api/sandbox/${sb.id}/edits/apply`, { edits: block('a.txt', 'alpha', 'FROM-SANDBOX') });
  writeFileSync(join(src, 'a.txt'), 'my own local edit\n');                      // you kept working in the real project
  const p = await j('POST', `/api/sandbox/${sb.id}/promote`, { confirm: true });
  assert.equal(p.s, 409); assert.match(p.b.error, /no longer matches/);
  assert.equal(readFileSync(join(src, 'a.txt'), 'utf8'), 'my own local edit\n', 'your edit is intact');
  // undo is refused if the project changed after promotion
  const src2 = repo({ 'a.txt': 'one\n' }); const sb2 = await mk(src2);
  await j('POST', `/api/sandbox/${sb2.id}/edits/apply`, { edits: block('a.txt', 'one', 'two') });
  const pr = await j('POST', `/api/sandbox/${sb2.id}/promote`, { confirm: true }); assert.equal(pr.s, 200);
  writeFileSync(join(src2, 'a.txt'), 'two plus my change\n');
  assert.equal((await j('POST', `/api/sandbox/${sb2.id}/promotions/${pr.b.id}/undo`)).s, 409);
  assert.equal(readFileSync(join(src2, 'a.txt'), 'utf8'), 'two plus my change\n');
});

test('promote works for a non-git project folder (copy sandbox) and is unavailable for read-only/direct', async () => {
  const src = repo({ 'doc.md': 'v1\n' }, false);
  const sb = await mk(src); assert.equal(sb.workspace_kind, 'copy');
  await j('POST', `/api/sandbox/${sb.id}/edits/apply`, { edits: block('doc.md', 'v1', 'v2') });
  assert.equal((await j('POST', `/api/sandbox/${sb.id}/promote`, { confirm: true })).s, 200);
  assert.equal(readFileSync(join(src, 'doc.md'), 'utf8'), 'v2\n');
  const ro = await mk(src, 'readonly');
  assert.equal((await j('GET', `/api/sandbox/${ro.id}/changes`)).b.promotable, false);
  assert.equal((await j('POST', `/api/sandbox/${ro.id}/promote`, { confirm: true })).s, 409);
});

const sse = (raw: string) => raw.split('\n\n').map(b => ({ e: /^event: (.+)$/m.exec(b)?.[1], d: /^data: (.+)$/m.exec(b)?.[1] })).filter(x => x.e).map(x => ({ event: x.e!, data: JSON.parse(x.d!) }));
const calls = () => readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

test('agent run: edits happen only inside the sandbox copy, with a checkpoint first and a locked-down CLI', { skip: !IS_POSIX }, async () => {
  writeFileSync(LOG, ''); _resetClaudeCache(); process.env.FAKE_CLAUDE_MODE = 'agent';
  const src = repo({ 'app.txt': 'original\n' });
  const sb = await mk(src);
  const r = await j('POST', '/api/agent/run', { sandboxId: sb.id, task: 'add a notes file' });
  assert.equal(r.s, 200);
  const ev = sse(r.raw);
  assert.ok(ev.some(e => e.event === 'tool' && e.data.name === 'Write' && e.data.target === 'agent-made.txt'));
  const done = ev.find(e => e.event === 'done')!.data;
  assert.equal(done.error, null); assert.equal(done.tools, 1);
  assert.ok(done.files.includes('agent-made.txt')); assert.match(done.summary, /Created agent-made\.txt/);
  const [c] = calls();
  const arg = (f: string) => c.args[c.args.indexOf(f) + 1];
  assert.equal(arg('--permission-mode'), 'acceptEdits');
  assert.ok(!arg('--allowedTools').split(',').includes('Bash')); assert.ok(arg('--disallowedTools').split(',').includes('Bash'));
  assert.ok(c.args.includes('--strict-mcp-config'));
  assert.equal(resolve(c.cwd), resolve(sb.working_dir), 'agent ran in the sandbox workspace');
  assert.equal(c.stdin, 'add a notes file'); assert.match(c.system, /isolated copy/);
  assert.equal(existsSync(join(src, 'agent-made.txt')), false, 'real project untouched');
  assert.equal(readFileSync(join(sb.working_dir, 'agent-made.txt'), 'utf8').trim(), 'made by fake agent: add a notes file');
  assert.ok((await j('GET', `/api/sandbox/${sb.id}/checkpoints`)).b.some((x: any) => x.sha === done.checkpoint && /before agent/.test(x.label)));
  const runs = (await j('GET', `/api/sandbox/${sb.id}/agent-runs`)).b; assert.equal(runs[0].status, 'done'); assert.equal(runs[0].task, 'add a notes file');
  assert.equal(usage.usageCounts('claude').hour >= 1, true, 'counted in the usage ledger');
  // restoring the pre-agent checkpoint undoes the agent's work
  assert.equal((await j('POST', `/api/sandbox/${sb.id}/restore`, { sha: done.checkpoint, confirm: true })).s, 200);
  assert.equal(existsSync(join(sb.working_dir, 'agent-made.txt')), false);
});

test('agent run: refused in read-only/direct, for unknown adapters, bad input, while limits are hit, and concurrently', { skip: !IS_POSIX }, async () => {
  writeFileSync(LOG, ''); _resetClaudeCache(); process.env.FAKE_CLAUDE_MODE = 'agent';
  const src = repo({ 'app.txt': 'x\n' });
  const ro = await mk(src, 'readonly'); const direct = (await j('POST', '/api/sandbox', { mode: 'direct', source_path: src, approve_direct: true })).b;
  for (const sb of [ro, direct]) assert.equal((await j('POST', '/api/agent/run', { sandboxId: sb.id, task: 'x' })).s, 403);
  const t = await mk(src);
  assert.equal((await j('POST', '/api/agent/run', { sandboxId: t.id, task: 'x', provider: 'cursor' })).s, 404);
  assert.equal((await j('POST', '/api/agent/run', { sandboxId: t.id, task: '' })).s, 400);
  assert.equal((await j('POST', '/api/agent/run', { sandboxId: 'nope', task: 'x' })).s, 404);
  assert.equal(calls().length, 0, 'the CLI was never started');
  usage.setSetting('provider_limits', { claude: { per_hour: 0 } });
  assert.equal((await j('POST', '/api/agent/run', { sandboxId: t.id, task: 'x' })).s, 429);
  usage.setSetting('provider_limits', {});
  // concurrency: a slow agent blocks a second one in the same sandbox
  process.env.FAKE_CLAUDE_MODE = 'slow';
  const first = app.inject({ method: 'POST', url: '/api/agent/run', payload: { sandboxId: t.id, task: 'slow one' } });
  await new Promise(r => setTimeout(r, 1500));
  assert.equal((await j('POST', '/api/agent/run', { sandboxId: t.id, task: 'second' })).s, 409);
  const { cancelAllForTest } = await import('../src/agent/claudeAgent.js').then(() => ({ cancelAllForTest: () => spawnSync('pkill', ['-f', 'fake-claude.mjs']) }));
  cancelAllForTest(); await first;
});
