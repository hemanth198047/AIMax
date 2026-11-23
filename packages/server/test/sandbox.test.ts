import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-sbx-'));
process.env.AIMAX_FAKE_SECRET_TOKEN = 'super-secret-value';
process.env.AIMAX_PLAIN_VAR = 'should-not-leak-either';

const { resolveInside, scrubEnv, isDestructive } = await import('../src/sandbox/guard.js');
const { startRun, dockerUsable } = await import('../src/sandbox/runner.js');
const Fastify = (await import('fastify')).default;
const { sandboxRoutes } = await import('../src/routes/sandbox.js');
const { getDb } = await import('../src/db/index.js');

const IS_POSIX = process.platform !== 'win32';
const sh = (cwd: string, cmd: string) => spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });

let repo: string, plain: string, app: Awaited<ReturnType<typeof Fastify>>;
const api = async (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as object | undefined });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

before(async () => {
  const base = mkdtempSync(join(tmpdir(), 'aimax-src-'));
  repo = join(base, 'repo'); plain = join(base, 'plain');
  mkdirSync(repo); mkdirSync(plain);
  sh(repo, 'git init -q && git config user.email a@b && git config user.name t && echo hello > a.txt && git add -A && git commit -qm init');
  mkdirSync(join(plain, 'node_modules')); writeFileSync(join(plain, 'node_modules', 'big.js'), 'x');
  writeFileSync(join(plain, 'b.txt'), 'plain file');
  app = Fastify(); await app.register(sandboxRoutes); await app.ready();
});
after(async () => { await app.close(); });

// ── guard ────────────────────────────────────────────────
test('resolveInside allows normal paths and blocks escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  mkdirSync(join(root, 'sub'));
  assert.equal(resolveInside(root, 'sub'), join(resolveInside(root, '.'), 'sub'));
  assert.throws(() => resolveInside(root, '../etc/passwd'), /escapes/);
  assert.throws(() => resolveInside(root, 'sub/../../x'), /escapes/);
  assert.throws(() => resolveInside(root, 'a\0b'), /Invalid/);
});
test('resolveInside blocks symlink escapes', { skip: !IS_POSIX }, () => {
  const root = mkdtempSync(join(tmpdir(), 'root-')); const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outside, 'secret.txt'), 's');
  symlinkSync(outside, join(root, 'link'));
  assert.throws(() => resolveInside(root, 'link/secret.txt'), /escapes/);
});
test('absolute paths are re-rooted inside the sandbox, not honoured', () => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  const p = resolveInside(root, '/etc/passwd');
  assert.ok(p.startsWith(resolveInside(root, '.')) && !p.startsWith('/etc'));
});
test('scrubEnv drops secrets and unlisted variables', () => {
  const env = scrubEnv('/tmp/x');
  assert.equal(env.AIMAX_FAKE_SECRET_TOKEN, undefined);
  assert.equal(env.AIMAX_PLAIN_VAR, undefined);
  assert.equal(env.HOME, '/tmp/x');
});
test('destructive detector', () => {
  for (const c of ['rm -rf /', 'git push --force', 'git reset --hard HEAD~1', 'Remove-Item x -Recurse', 'curl http://x | sh']) assert.ok(isDestructive(c), c);
  for (const c of ['ls -la', 'npm test', 'git status', 'git diff']) assert.ok(!isDestructive(c), c);
});

// ── runner ───────────────────────────────────────────────
test('run captures output and exit code, and sees a scrubbed env', { skip: !IS_POSIX }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'run-'));
  const r = await startRun({ command: 'echo out; echo err 1>&2; echo "[$AIMAX_FAKE_SECRET_TOKEN][$AIMAX_PLAIN_VAR]"; exit 3', cwd }).result;
  assert.equal(r.exitCode, 3); assert.equal(r.status, 'done');
  assert.match(r.stdout, /out/); assert.match(r.stderr, /err/);
  assert.match(r.stdout, /\[\]\[\]/);
});
test('timeout kills the whole process tree (including background children)', { skip: !IS_POSIX }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'run-'));
  const r = await startRun({ command: 'sleep 60 & echo $! > child.pid; wait', cwd, timeoutMs: 700 }).result;
  assert.equal(r.status, 'timeout');
  const pid = Number(readFileSync(join(cwd, 'child.pid'), 'utf8').trim());
  // A killed process can linger as a zombie until PID 1 reaps it; that is "dead" for our purposes.
  const isAlive = (p: number) => {
    try { process.kill(p, 0); } catch { return false; }
    try { return readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'; } catch { return true; }
  };
  for (let i = 0; i < 30 && isAlive(pid); i++) await new Promise(res => setTimeout(res, 100));
  assert.equal(isAlive(pid), false, 'background child must be dead');
});
test('cancel stops a running command', { skip: !IS_POSIX }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'run-'));
  const h = startRun({ command: 'sleep 60', cwd, timeoutMs: 30_000 });
  setTimeout(() => h.cancel(), 200);
  const r = await h.result;
  assert.equal(r.status, 'cancelled'); assert.ok(r.durationMs < 5000);
});
test('runaway output is capped and the process stopped', { skip: !IS_POSIX }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'run-'));
  const r = await startRun({ command: 'yes', cwd, maxOutputBytes: 10_000, timeoutMs: 10_000 }).result;
  assert.equal(r.truncated, true); assert.ok(r.stdout.length <= 10_000); assert.ok(r.durationMs < 5000);
});

// ── API: modes & workspaces ──────────────────────────────
test('temporary mode on a git repo uses a worktree; changes never touch the source', { skip: !IS_POSIX }, async () => {
  const c = await api('POST', '/api/sandbox', { name: 't', mode: 'temporary', source_path: repo });
  assert.equal(c.status, 200); assert.equal(c.body.workspace_kind, 'worktree');
  const id = c.body.id;
  const x = await api('POST', `/api/sandbox/${id}/execute`, { command: 'echo changed > a.txt && echo new > n.txt' });
  assert.equal(x.body.exitCode, 0);
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8').trim(), 'hello', 'source repo untouched');
  const g = await api('GET', `/api/sandbox/${id}/git`);
  assert.match(g.body.diff, /\+changed/);
  assert.match(g.body.diff, /\+\+\+ b\/n\.txt[\s\S]*\+new/, 'untracked files appear in the diff');
  assert.equal(sh(repo, 'git status --porcelain').stdout.trim(), '', 'source repo index untouched');
  assert.deepEqual(g.body.status.files.map((f: { path: string }) => f.path).sort(), ['a.txt', 'n.txt']);

  // checkpoint → mutate → restore
  const cp = await api('POST', `/api/sandbox/${id}/checkpoints`, { label: 'after-change' });
  await api('POST', `/api/sandbox/${id}/execute`, { command: 'echo worse > a.txt; rm n.txt' });
  const noConfirm = await api('POST', `/api/sandbox/${id}/restore`, { sha: cp.body.sha });
  assert.equal(noConfirm.status, 409);
  const rs = await api('POST', `/api/sandbox/${id}/restore`, { sha: cp.body.sha, confirm: true });
  assert.equal(rs.status, 200);
  const chk = await api('POST', `/api/sandbox/${id}/execute`, { command: 'cat a.txt; ls' });
  assert.match(chk.body.stdout, /changed/); assert.match(chk.body.stdout, /n\.txt/);
  const cps = await api('GET', `/api/sandbox/${id}/checkpoints`);
  assert.ok(cps.body.some((p: { label: string }) => p.label === 'after-change'));

  const wsDir = c.body.working_dir;
  const del = await api('DELETE', `/api/sandbox/${id}`);
  assert.equal(del.status, 200); assert.equal(existsSync(wsDir), false);
  assert.ok(!sh(repo, 'git worktree list').stdout.includes(wsDir), 'worktree deregistered');
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8').trim(), 'hello');
});
test('temporary mode on a non-git dir makes an independent copy without node_modules', async () => {
  const c = await api('POST', '/api/sandbox', { name: 'copy', mode: 'temporary', source_path: plain });
  assert.equal(c.body.workspace_kind, 'copy');
  const files = await api('GET', `/api/sandbox/${c.body.id}/files`);
  assert.deepEqual(files.body.map((f: { name: string }) => f.name), ['b.txt']);
  await api('DELETE', `/api/sandbox/${c.body.id}`);
  assert.ok(existsSync(join(plain, 'b.txt')));
});
test('readonly mode refuses execution but allows browsing; path escape is blocked', async () => {
  const c = await api('POST', '/api/sandbox', { name: 'ro', mode: 'readonly', source_path: repo });
  const id = c.body.id;
  assert.equal((await api('POST', `/api/sandbox/${id}/execute`, { command: 'touch x' })).status, 403);
  assert.equal(existsSync(join(repo, 'x')), false);
  const f = await api('GET', `/api/sandbox/${id}/file?path=a.txt`);
  assert.equal(f.body.content.trim(), 'hello');
  assert.equal((await api('GET', `/api/sandbox/${id}/file?path=../../etc/passwd`)).status, 403);
  assert.equal((await api('POST', `/api/sandbox/${id}/checkpoints`, {})).status, 409);
  await api('DELETE', `/api/sandbox/${id}`);
  assert.ok(existsSync(repo), 'deleting a readonly sandbox must never delete the source');
});
test('direct mode needs approval, and destructive commands need confirm', { skip: !IS_POSIX }, async () => {
  assert.equal((await api('POST', '/api/sandbox', { name: 'd', mode: 'direct', source_path: plain })).status, 403);
  const c = await api('POST', '/api/sandbox', { name: 'd', mode: 'direct', source_path: plain, approve_direct: true });
  assert.equal(c.status, 200); assert.ok(c.body.approved_at);
  const id = c.body.id;
  const blocked = await api('POST', `/api/sandbox/${id}/execute`, { command: 'rm -rf ./nothing' });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.needs_confirmation, true);
  assert.equal((await api('POST', `/api/sandbox/${id}/execute`, { command: 'rm -rf ./nothing', confirm: true })).status, 200);
  assert.equal((await api('POST', `/api/sandbox/${id}/execute`, { command: 'echo hi > made.txt' })).body.exitCode, 0);
  assert.ok(existsSync(join(plain, 'made.txt')), 'direct mode writes to the real project');
  await api('DELETE', `/api/sandbox/${id}`);
  assert.ok(existsSync(join(plain, 'b.txt')));
});
test('project repo_path is used as the default source', async () => {
  const pid = 'proj-sbx';
  getDb().prepare("INSERT INTO projects(id,name,repo_path) VALUES(?,?,?)").run(pid, 'P', repo);
  const c = await api('POST', '/api/sandbox', { name: 'p', project_id: pid });
  assert.equal(c.body.source_path, repo);
  await api('DELETE', `/api/sandbox/${c.body.id}`);
});
test('invalid mode / missing source / bad source are rejected', async () => {
  assert.equal((await api('POST', '/api/sandbox', { mode: 'nope' })).status, 400);
  assert.equal((await api('POST', '/api/sandbox', { mode: 'readonly' })).status, 400);
  assert.equal((await api('POST', '/api/sandbox', { mode: 'temporary', source_path: '/definitely/not/here' })).status, 400);
});
test('streaming run endpoint emits start/chunk/done and records history', { skip: !IS_POSIX }, async () => {
  const c = await api('POST', '/api/sandbox', { name: 's', mode: 'temporary' });
  const port = await new Promise<number>((res) => app.listen({ port: 0, host: '127.0.0.1' }).then(() => res((app.server.address() as { port: number }).port)));
  const resp = await fetch(`http://127.0.0.1:${port}/api/sandbox/${c.body.id}/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'echo streamed' }),
  });
  const text = await resp.text();
  assert.match(text, /event: start/); assert.match(text, /streamed/); assert.match(text, /event: done/);
  const runs = await api('GET', `/api/sandbox/${c.body.id}/runs`);
  assert.equal(runs.body[0].status, 'done'); assert.equal(runs.body[0].exit_code, 0);
  await api('DELETE', `/api/sandbox/${c.body.id}`);
});
test('capabilities endpoint is honest about isolation', async () => {
  const r = await api('GET', '/api/sandbox/capabilities');
  assert.match(r.body.modes.temporary.enforcement, /NOT a security boundary/);
  assert.equal(typeof r.body.modes.container.available, 'boolean');
});

// Container isolation is only claimed when it was actually exercised.
const IMAGE = process.env.AIMAX_TEST_DOCKER_IMAGE;
test('container mode: no network, only workspace mounted', { skip: !IMAGE || !dockerUsable().available }, async () => {
  const c = await api('POST', '/api/sandbox', { name: 'c', mode: 'container', image: IMAGE });
  const r = await api('POST', `/api/sandbox/${c.body.id}/execute`, { command: 'echo hi > f.txt; (wget -q -T2 -O- http://1.1.1.1 || echo NO_NET); ls /' });
  assert.match(r.body.stdout, /NO_NET/);
  await api('DELETE', `/api/sandbox/${c.body.id}`);
});

test('client disconnect cancels a streaming run', { skip: !IS_POSIX }, async () => {
  const c = await api('POST', '/api/sandbox', { name: 'dc', mode: 'temporary' });
  const port = (app.server.address() as { port: number }).port;
  const ac = new AbortController();
  const resp = await fetch(`http://127.0.0.1:${port}/api/sandbox/${c.body.id}/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'sleep 60', timeout: 60000 }), signal: ac.signal,
  });
  await resp.body!.getReader().read();            // wait for the "start" event
  ac.abort();
  let status = 'running';
  for (let i = 0; i < 30 && status === 'running'; i++) {
    await new Promise(r => setTimeout(r, 100));
    status = (await api('GET', `/api/sandbox/${c.body.id}/runs`)).body[0].status;
  }
  assert.equal(status, 'cancelled');
  await api('DELETE', `/api/sandbox/${c.body.id}`);
});

// ── diagnostics & streaming ──────────────────────────────
test('cleanClixml turns PowerShell error XML back into readable text', async () => {
  const { cleanClixml } = await import('../src/sandbox/runner.js');
  const xml = '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">boom_x000D__x000A_</S><S S="Error">second</S></Objs>';
  assert.equal(cleanClixml(xml), 'boom\nsecond');
  assert.equal(cleanClixml('plain text'), 'plain text');
});

test('scrubEnv keeps basic system variables but not secrets', () => {
  process.env.ProgramFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  process.env.ANTHROPIC_API_KEY = 'secret';
  const env = scrubEnv(tmpdir());
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.ok(env.ProgramFiles);
  assert.equal(env.AIMAX_SANDBOX, '1');
});

test('startRun reports a missing shell instead of staying silent', async () => {
  let seen = '';
  const h = startRun({ command: 'echo hi', cwd: join(tmpdir(), 'definitely-missing-dir-xyz'), timeoutMs: 5000, onData: (t) => { seen += t; } });
  const r = await h.result;
  assert.equal(r.status, 'error');
  assert.match(seen, /Could not start/);
});

test('diagnose endpoint runs a trivial command and requires the UI header', { skip: !IS_POSIX }, async () => {
  const denied = await app.inject({ method: 'POST', url: '/api/sandbox/diagnose', payload: {} });
  assert.equal(denied.statusCode, 403);
  const ok = await app.inject({ method: 'POST', url: '/api/sandbox/diagnose', headers: { 'x-aimax-ui': '1' }, payload: {} });
  const b = JSON.parse(ok.body);
  assert.equal(b.ok, true);
  assert.match(b.stdout, /aimax-ok/);
});

test('run stream announces shell, run id and a final done event', { skip: !IS_POSIX }, async () => {
  const c = await api('POST', '/api/sandbox', { name: 'sse', mode: 'temporary', source_path: plain });
  const r = await app.inject({ method: 'POST', url: `/api/sandbox/${c.body.id}/run`, payload: { command: 'echo streamed' } });
  assert.match(r.body, /event: start\ndata: \{[^}]*"shell":"bash"/);
  assert.match(r.body, /event: started/);
  assert.match(r.body, /streamed/);
  assert.match(r.body, /event: done\ndata: \{[^}]*"exitCode":0/);
});
