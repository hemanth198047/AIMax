import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-use-'));
const LOG = join(process.env.AIMAX_DATA_DIR, 'fake.log'); writeFileSync(LOG, '');
process.env.FAKE_CLAUDE_LOG = LOG;
process.env.AIMAX_CLAUDE_BIN = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');
const IS_POSIX = process.platform !== 'win32';

// Fake Ollama: /api/tags lists two models, /api/chat streams a reply that names the model it was asked for.
const asked: string[] = [];
const ollama = createServer((req, res) => {
  if (req.url === '/api/tags') { res.setHeader('content-type', 'application/json'); return void res.end(JSON.stringify({ models: [{ name: 'small:1b', size: 1, modified_at: '' }, { name: 'big:8b', size: 2, modified_at: '' }] })); }
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    const m = JSON.parse(body || '{}'); asked.push(m.model);
    res.write(JSON.stringify({ message: { content: `ollama-reply-from-${m.model}` } }) + '\n'); res.end();
  });
});
await new Promise<void>(r => ollama.listen(0, '127.0.0.1', r));
process.env.OLLAMA_URL = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`;

const { default: Fastify } = await import('fastify');
const { chatRoutes } = await import('../src/routes/chat.js');
const { providersRoutes } = await import('../src/routes/providers.js');
const { _resetClaudeCache } = await import('../src/providers/claude.js');
const usage = await import('../src/providers/usage.js');
const { getDb } = await import('../src/db/index.js');

let app: Awaited<ReturnType<typeof Fastify>>; let base = '';
before(async () => { app = Fastify(); await app.register(chatRoutes); await app.register(providersRoutes); await app.listen({ port: 0, host: '127.0.0.1' }); base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`; });
after(async () => { await app.close(); ollama.close(); });

async function chat(provider: string, message = 'hi') {
  const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, provider, scope: 'global' }) });
  const text = await res.text();
  const events = text.split('\n\n').map(b => ({ e: /^event: (.+)$/m.exec(b)?.[1], d: /^data: (.+)$/m.exec(b)?.[1] })).filter(x => x.e).map(x => ({ event: x.e!, data: JSON.parse(x.d!) }));
  return { events, text: events.filter(e => e.event === 'chunk').map(e => e.data.text).join(''), error: events.find(e => e.event === 'error')?.data.message as string | undefined,
    activity: events.filter(e => e.event === 'activity').map(e => `${e.data.step}: ${e.data.detail}`) };
}
const reset = () => { getDb().exec('DELETE FROM usage_events; DELETE FROM settings;'); _resetClaudeCache(); };

test('limits are validated and persisted', async () => {
  reset();
  assert.deepEqual(usage.sanitizeLimits({ claude: { per_hour: '5', per_day: 20, junk: 1 }, 'bad name!': { per_hour: 1 } }), { claude: { per_hour: 5, per_day: 20 } });
  assert.throws(() => usage.sanitizeLimits({ claude: { per_hour: -1 } }), /between 0/);
  const r = await app.inject({ method: 'PUT', url: '/api/settings/providers', payload: { limits: { claude: { per_hour: 2 } }, ollama_model: 'big:8b' } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual((await app.inject({ url: '/api/settings/providers' })).json(), { limits: { claude: { per_hour: 2 } }, ollama_model: 'big:8b' });
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/providers', payload: { limits: { claude: { per_day: 'x' } } } })).statusCode, 400);
});

test('Ollama: the chosen model is used; an unknown/removed choice falls back to the first installed', async () => {
  reset(); asked.length = 0;
  usage.setSetting('ollama_model', 'big:8b');
  const a = await chat('ollama'); assert.match(a.text, /ollama-reply-from-big:8b/);
  usage.setSetting('ollama_model', 'gone:7b');
  const b = await chat('ollama'); assert.match(b.text, /ollama-reply-from-small:1b/);
  const st = (await app.inject({ url: '/api/providers/status' })).json();
  assert.equal(st.ollama.selected, 'small:1b'); assert.deepEqual(st.ollama.models, ['small:1b', 'big:8b']);
  assert.equal(usage.usageCounts('ollama').hour, 2, 'both requests were recorded');
});

test('zero-overage: Claude is not called once the configured limit is reached; auto routes to Ollama', { skip: !IS_POSIX }, async () => {
  reset(); process.env.FAKE_CLAUDE_MODE = 'ok'; writeFileSync(LOG, '');
  usage.setSetting('provider_limits', { claude: { per_hour: 2 } });
  assert.equal((await chat('claude')).text, 'Hello world'); assert.equal((await chat('claude')).text, 'Hello world');
  const callsBefore = readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length; assert.equal(callsBefore, 2);
  const blocked = await chat('claude');
  assert.match(blocked.error!, /hourly limit reached \(2\/2\).*zero-overage/s);
  assert.equal(readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length, 2, 'the CLI was NOT invoked');
  const auto = await chat('auto');
  assert.match(auto.text, /ollama-reply-from-/); assert.ok(auto.activity.some(a => /routing: .*hourly limit.*routing to another provider/.test(a)), auto.activity.join('|'));
});

test('a provider-reported limit pauses it; resume clears the pause', { skip: !IS_POSIX }, async () => {
  reset(); process.env.FAKE_CLAUDE_MODE = 'ratelimit'; writeFileSync(LOG, '');
  const first = await chat('claude'); assert.match(first.error!, /usage limit reached/i);
  assert.ok(first.activity.some(a => /paused for 60 min/.test(a)));
  const cd = usage.activeCooldown('claude'); assert.ok(cd);
  process.env.FAKE_CLAUDE_MODE = 'ok';
  const second = await chat('claude'); assert.match(second.error!, /paused until/);
  assert.equal(readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length, 1, 'no second CLI call while paused');
  const u = (await app.inject({ url: '/api/usage' })).json();
  assert.ok(u.providers.find((p: any) => p.provider === 'claude').paused);
  assert.ok(u.recent.some((r: any) => r.ok === 0 && /usage limit/.test(r.error)));
  assert.ok(!JSON.stringify(u).includes('hi'), 'ledger holds no message content');
  assert.equal((await app.inject({ method: 'POST', url: '/api/usage/claude/resume' })).statusCode, 200);
  assert.equal((await chat('claude')).text, 'Hello world');
});

test('status reports the real CLI version, and never claims adapters that do not exist', { skip: !IS_POSIX }, async () => {
  reset(); process.env.FAKE_CLAUDE_MODE = 'ok';
  const st = (await app.inject({ url: '/api/providers/status' })).json();
  assert.equal(st.claude.version, '0.0.0-fake');
  for (const k of ['cursor', 'codex', 'freellmapi']) { assert.equal(st[k].available, false, k); assert.match(st[k].note, k === 'freellmapi' ? /No AImax adapter/ : /Experimental/); }
});

test('time windows: only the last hour/day count', () => {
  reset(); const now = new Date('2026-01-01T12:00:00Z');
  usage.recordUsage({ provider: 'x', ok: true }, new Date('2026-01-01T11:30:00Z'));
  usage.recordUsage({ provider: 'x', ok: true }, new Date('2026-01-01T05:00:00Z'));
  usage.recordUsage({ provider: 'x', ok: true }, new Date('2025-12-30T05:00:00Z'));
  assert.deepEqual(usage.usageCounts('x', now), { hour: 1, day: 2 });
});
