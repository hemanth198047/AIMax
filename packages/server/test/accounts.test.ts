import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-acc-'));
const LOG = join(process.env.AIMAX_DATA_DIR, 'fake.log'); writeFileSync(LOG, '');
const TERM = join(process.env.AIMAX_DATA_DIR, 'terminal.log'); writeFileSync(TERM, '');
process.env.FAKE_CLAUDE_LOG = LOG; process.env.AIMAX_TERMINAL_LOG = TERM;
process.env.AIMAX_CLAUDE_BIN = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');
process.env.PATH = (await import('node:path')).dirname(process.execPath);   // only node itself: codex / cursor-agent are NOT installed in this test
const IS_POSIX = process.platform !== 'win32';
const { default: Fastify } = await import('fastify');
const { accountsRoutes } = await import('../src/routes/accounts.js');
const { autoChat } = await import('../src/providers/auto.js');
const { _resetClaudeCache } = await import('../src/providers/claude.js');

let app: Awaited<ReturnType<typeof Fastify>>;
before(async () => { app = Fastify(); await app.register(accountsRoutes); await app.ready(); });
after(() => app.close());
const accounts = async () => (await app.inject({ url: '/api/accounts' })).json();
const acc = (b: any, id: string) => b.accounts.find((a: any) => a.id === id);

test('accounts: Claude is detected, signed-in state comes from the CLI itself; missing CLIs say how to install', { skip: !IS_POSIX }, async () => {
  process.env.FAKE_CLAUDE_AUTH = 'in';
  let b = await accounts(); let c = acc(b, 'claude');
  assert.deepEqual([c.installed, c.loginSupported, c.statusSupported, c.signedIn, c.adapter], [true, true, true, true, 'ready']);
  assert.match(c.statusText, /Logged in/); assert.equal(c.method.kind, 'subscription'); assert.match(c.how, /heuristic/); assert.equal(c.version, '0.0.0-fake');
  process.env.FAKE_CLAUDE_AUTH = 'out'; c = acc(await accounts(), 'claude'); assert.equal(c.signedIn, false); assert.match(c.statusText, /Not logged in/);
  process.env.FAKE_CLAUDE_AUTH = 'none'; c = acc(await accounts(), 'claude');
  assert.deepEqual([c.installed, c.loginSupported, c.signedIn], [true, false, null]); assert.match(c.hint, /\/login/); assert.equal(c.loginCommand, 'claude');
  for (const id of ['cursor', 'openai']) { const a = acc(b, id); assert.deepEqual([a.installed, a.signedIn, a.adapter], [false, null, 'not-built']); assert.match(a.hint, /Install/); }
  delete process.env.FAKE_CLAUDE_AUTH;
});

test('sign-in opens a terminal with a FIXED command; the request cannot choose the command; cross-site calls are refused', { skip: !IS_POSIX }, async () => {
  const post = (url: string, body: object, hdr: Record<string, string> = { 'x-aimax-ui': '1' }) => app.inject({ method: 'POST', url, payload: body, headers: hdr });
  assert.equal((await post('/api/accounts/claude/terminal', { action: 'login' }, {})).statusCode, 403);
  assert.equal((await post('/api/accounts/nope/terminal', { action: 'login' })).statusCode, 404);
  assert.equal((await post('/api/accounts/claude/terminal', { action: 'rm -rf /' })).statusCode, 400);
  assert.equal((await post('/api/accounts/cursor/terminal', { action: 'login' })).statusCode, 404);       // not installed
  writeFileSync(TERM, '');
  const r = await post('/api/accounts/claude/terminal', { action: 'login', command: 'calc.exe', args: ['x'] });
  assert.equal(r.statusCode, 200); assert.equal(r.json().opened, true);
  assert.match(readFileSync(TERM, 'utf8').trim(), /fake-claude\.mjs auth login$/);                          // extra body fields ignored
  await post('/api/accounts/claude/terminal', { action: 'logout' });
  assert.match(readFileSync(TERM, 'utf8'), /auth logout\n$/);
});

test('API keys in the environment are NOT passed to Claude (so the subscription is used, not API billing) and are reported', { skip: !IS_POSIX }, async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-should-not-leak'; process.env.ANTHROPIC_AUTH_TOKEN = 'tok'; _resetClaudeCache();
  writeFileSync(LOG, '');
  await autoChat({ messages: [{ role: 'user', content: 'hi' }], system: 's', provider: 'claude' }, () => undefined);
  const run = readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
  assert.deepEqual([run.hasApiKey, run.hasAuthToken], [false, false]);
  const b = await accounts(); assert.match(b.warnings.join(' '), /ANTHROPIC_API_KEY.*ignores it/); assert.ok(!JSON.stringify(b).includes('sk-ant-test'));
  process.env.AIMAX_ALLOW_API_KEY = '1'; writeFileSync(LOG, '');
  await autoChat({ messages: [{ role: 'user', content: 'hi' }], system: 's', provider: 'claude' }, () => undefined);
  assert.equal(JSON.parse(readFileSync(LOG, 'utf8').trim().split('\n').at(-1)!).hasApiKey, true);          // explicit opt-in works
  delete process.env.AIMAX_ALLOW_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
});

test('"credit balance too low" is explained (API billing, not subscription) and does not pause Claude for an hour', async () => {
  const { explainClaudeError } = await import('../src/providers/claude.js');
  const { looksRateLimited } = await import('../src/providers/usage.js');
  const m = explainClaudeError('Credit balance is too low');
  assert.match(m, /API billing, not your Pro\/Max subscription/); assert.match(m, /Sign out, then Sign in/); assert.match(m, /Credit balance is too low/);
  assert.equal(looksRateLimited('Credit balance is too low'), false);
  assert.match(explainClaudeError('Invalid API key · Please run /login'), /not signed in/);
  assert.equal(explainClaudeError('some other failure'), 'some other failure');
  assert.equal(looksRateLimited('Claude usage limit reached'), true);                       // real limits still pause
});

test('sign-in method is read from the CLI\'s own fields — key NAMES like apiKeySource never cause an "API" verdict', async () => {
  const { parseSignInMethod: P } = await import('../src/accounts/cli.js');
  const sub = P(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', apiKeySource: 'none', subscriptionType: 'max', email: 'me@example.com' }), 'claude');
  assert.deepEqual([sub.kind, sub.account], ['subscription', 'me@example.com']); assert.match(sub.label, /Claude subscription \(max\)/); assert.match(sub.evidence, /authMethod = "claude\.ai"/);
  assert.ok(sub.fields.some(f => f.key === 'apiKeySource' && f.value === 'none'));
  const api = P(JSON.stringify({ loggedIn: true, authMethod: 'console', apiKeySource: '/login managed key' }), 'claude'); assert.equal(api.kind, 'api'); assert.match(api.evidence, /authMethod = "console"/);
  assert.equal(P(JSON.stringify({ loggedIn: true, apiKeySource: 'ANTHROPIC_API_KEY' }), 'claude').kind, 'api');            // key in use and nothing says otherwise
  assert.equal(P(JSON.stringify({ loggedIn: true, apiKeySource: 'none' }), 'claude').kind, 'unknown');                       // says nothing → unknown, not guessed
  assert.equal(P('Logged in using ChatGPT', 'openai').kind, 'subscription'); assert.match(P('Logged in using ChatGPT', 'openai').label, /Subscription/);
  assert.equal(P('Logged in using an API key - sk-proj-***ABCDE', 'openai').kind, 'api');
  assert.equal(P('Login method: Claude Max Account\nEmail: a@b.co', 'claude').kind, 'subscription'); assert.equal(P('Login method: Anthropic Console Account', 'claude').kind, 'api');
  assert.equal(P('Logged in as me@example.com', 'cursor').kind, 'unknown');                                                  // no method stated
  assert.equal(P('', 'claude').kind, 'unknown');
  assert.equal(P('Logged in. You have an API key option and a Claude Pro subscription', 'claude').kind, 'unknown');           // both words → ambiguous, not guessed
  process.env.FAKE_CLAUDE_AUTH = 'json'; let c = acc(await accounts(), 'claude');
  assert.deepEqual([c.method.kind, c.method.account, c.signedIn], ['subscription', 'me@example.com', true]);
  process.env.FAKE_CLAUDE_AUTH = 'console'; c = acc(await accounts(), 'claude'); assert.equal(c.method.kind, 'api');
  process.env.FAKE_CLAUDE_AUTH = 'out'; c = acc(await accounts(), 'claude'); assert.equal(c.signedIn, false); assert.equal(c.method.label, 'Not signed in');
  delete process.env.FAKE_CLAUDE_AUTH;
});
