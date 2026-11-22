import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-rep-'));
const LOG = join(process.env.AIMAX_DATA_DIR, 'fake.log'); writeFileSync(LOG, '');
process.env.FAKE_CLAUDE_LOG = LOG;
process.env.AIMAX_CLAUDE_BIN = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');
process.env.OLLAMA_URL = 'http://127.0.0.1:9';           // nothing listens: Ollama is "unavailable"
const { default: Fastify } = await import('fastify');
const { providersRoutes } = await import('../src/routes/providers.js');
const { getDb } = await import('../src/db/index.js');
const usage = await import('../src/providers/usage.js');
const { buildReport } = await import('../src/providers/report.js');
const { autoChat } = await import('../src/providers/auto.js');
const { _resetClaudeCache } = await import('../src/providers/claude.js');

let app: Awaited<ReturnType<typeof Fastify>>;
before(async () => {
  app = Fastify(); await app.register(providersRoutes); await app.ready();
  const db = getDb(); db.pragma('foreign_keys = OFF'); const t = new Date().toISOString();
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)').run('RP', 'Rep Proj', t, t);
});
after(() => app.close());
const reset = () => { getDb().exec('DELETE FROM usage_events; DELETE FROM settings; DELETE FROM conversations;'); _resetClaudeCache(); };
const conv = (id: string, title: string, project: string | null) => { const t = new Date().toISOString(); getDb().prepare("INSERT INTO conversations(id,title,scope,project_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, title, project ? 'project' : 'global', project, t, t); };
const ev = (o: Partial<Parameters<typeof usage.recordUsage>[0]> & { ago?: number }) => usage.recordUsage({ provider: 'claude', ok: true, inputChars: 400, outputChars: 400, ...o }, new Date(Date.now() - (o.ago ?? 0)));
const prov = (r: ReturnType<typeof buildReport>, p: string) => r.providers.find(x => x.provider === p)!;

test('tokens: reported numbers win over the 4-chars-per-token estimate; windows and remaining budget are correct', () => {
  reset();
  ev({ inputChars: 4000, outputChars: 400 });                                          // ≈ 1000 + 100 estimated
  ev({ inputChars: 99999, outputChars: 99999, reported: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, costUsd: 0.5 } });
  ev({ ago: 3 * 86_400_000, inputChars: 800, outputChars: 0 });                        // 200, outside 24 h but inside 30 d
  ev({ ago: 40 * 86_400_000, inputChars: 4000, outputChars: 0 });                      // outside 30 d
  usage.setSetting('provider_limits', { claude: { per_day_tokens: 3000, per_month_tokens: 10000 } });
  const r = buildReport({ ctx: {}, days: 60 }); const c = prov(r, 'claude');
  assert.equal(c.requests, 4); assert.equal(c.reportedRequests, 1); assert.equal(c.cacheReadTokens, 5000); assert.equal(c.costUsd, 0.5);
  assert.equal(c.last24h, 1100 + 1500); assert.equal(c.last30d, 1100 + 1500 + 200);
  assert.equal(c.budget.remaining_24h, 400); assert.equal(c.budget.used_pct_24h, 87); assert.equal(c.budget.remaining_30d, 10000 - 2800);
  assert.ok(r.tips.some(t => t.id === 'budget24-claude' && /87%/.test(t.title)));
  assert.equal(r.daily.length, 60); assert.equal(r.daily.at(-1)!.requests, 2);
});

test('token budgets are ENFORCED before calling a provider (zero-overage), per 24 h and per 30 days', () => {
  reset();
  usage.setSetting('provider_limits', { claude: { per_day_tokens: 1000 } });
  assert.equal(usage.budgetCheck('claude').ok, true);
  ev({ inputChars: 4000, outputChars: 0 });
  const b = usage.budgetCheck('claude'); assert.equal(b.ok, false); assert.match((b as { reason: string }).reason, /24-hour token budget reached/);
  reset(); usage.setSetting('provider_limits', { claude: { per_month_tokens: 500 } }); ev({ ago: 10 * 86_400_000, inputChars: 4000, outputChars: 0 });
  assert.match((usage.budgetCheck('claude') as { reason: string }).reason, /30-day token budget/);
  assert.deepEqual(usage.sanitizeLimits({ claude: { per_day_tokens: '2000000', per_month_tokens: 5e6 } }), { claude: { per_day_tokens: 2000000, per_month_tokens: 5000000 } });
  assert.throws(() => usage.sanitizeLimits({ claude: { per_day_tokens: -5 } }), /between 0/);
});

test('a real call through the Claude adapter records the tokens the CLI REPORTED (fake CLI, shape unverified)', { skip: process.platform === 'win32' }, async () => {
  reset(); process.env.FAKE_CLAUDE_MODE = 'usage';
  try {
    const out = await autoChat({ messages: [{ role: 'user', content: 'hi' }], system: 's', provider: 'claude', meta: { conversationId: 'c-real' } }, () => undefined);
    assert.equal(out.text, 'Hello world');
  } finally { delete process.env.FAKE_CLAUDE_MODE; }
  const row = getDb().prepare('SELECT reported_in,reported_out,reported_cache_read,reported_cost FROM usage_events').get() as any;
  assert.deepEqual(row, { reported_in: 1200, reported_out: 300, reported_cache_read: 5000, reported_cost: 0.0123 });
});

test('suggestions come from the numbers: context-heavy input, failures, no budget, long conversations; none for an idle ledger', () => {
  reset(); assert.deepEqual(buildReport({ ctx: {} }).tips, []);
  conv('long1', 'Giant thread', null);
  for (let i = 0; i < 16; i++) ev({ conversationId: 'long1', inputChars: 20000, outputChars: 400 });   // 5000 in / 100 out each
  ev({ ok: false, inputChars: 40, outputChars: 0, error: 'boom' });
  const r = buildReport({ ctx: {} }); const ids = r.tips.map(t => t.id);
  for (const id of ['ctx-claude', 'nobudget-claude', 'long-convs', 'one-conv']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('fail-claude'), '1 of 17 is under the 15% bar');
});

test('failure tip triggers over 15%; Ollama tip only when Ollama is reachable', () => {
  reset();
  for (let i = 0; i < 6; i++) ev({ ok: i >= 2, inputChars: 100, outputChars: 100 });                     // 2 of 6 failed, small requests
  assert.ok(buildReport({ ctx: {} }).tips.some(t => t.id === 'fail-claude'));
  for (let i = 0; i < 10; i++) ev({ inputChars: 200, outputChars: 100 });
  assert.ok(!buildReport({ ctx: {}, ollamaAvailable: false }).tips.some(t => t.id === 'small-to-ollama'));
  assert.ok(buildReport({ ctx: {}, ollamaAvailable: true }).tips.some(t => t.id === 'small-to-ollama'));
});

test('privacy: conversation titles outside the current project/person are not named, only counted', async () => {
  reset(); conv('g1', 'Global chat', null); conv('p1', 'Secret project chat', 'RP');
  ev({ conversationId: 'g1' }); ev({ conversationId: 'p1' });
  const inGlobal = buildReport({ ctx: {} });
  assert.deepEqual(inGlobal.topConversations.map(c => c.title), ['Global chat']); assert.equal(inGlobal.hiddenContexts.conversations, 1);
  assert.ok(!JSON.stringify(inGlobal).includes('Secret project chat'));
  const api = await app.inject({ url: '/api/usage/report?days=7&project_id=RP' });
  assert.equal(api.statusCode, 200); const body = api.json();
  assert.deepEqual(body.topConversations.map((c: any) => c.title).sort(), ['Global chat', 'Secret project chat']); assert.equal(body.days, 7);
  assert.match(body.note, /cannot see your real plan quota/);
  const noCtx = (await app.inject({ url: '/api/usage/report' })).body; assert.ok(!noCtx.includes('Secret project chat'));
});
