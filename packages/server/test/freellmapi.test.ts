import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-fl-'));
let srv: Server; let seen: { auth?: string; body?: any } = {}; let port = 0;
before(async () => {
  srv = createServer((req, res) => {
    seen.auth = req.headers.authorization;
    if (req.headers.authorization !== 'Bearer freellmapi-test') { res.writeHead(401).end('{}'); return; }
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'auto' }, { id: 'gemini-2.5-flash' }] })); return; }
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      seen.body = JSON.parse(b); res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'); res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n'); res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); port = (srv.address() as any).port;
});
after(() => srv.close());

test('FreeLLMAPI: config validation, key never echoed, probe, streamed chat with bearer key', async () => {
  const m = await import('../src/providers/freellmapi.js');
  assert.throws(() => m.saveFreeConfig({ url: 'ftp://x' }), /http/);
  m.saveFreeConfig({ url: `http://127.0.0.1:${port}/v1/`, model: 'auto' });
  assert.equal(m.freeConfig().url, `http://127.0.0.1:${port}/v1`);
  assert.equal(m.freeConfig().key, ''); assert.equal(await m.freeAvailable(), false);                       // no key yet
  assert.match((await m.freeProbe()).error, /rejected the key/);
  m.saveFreeConfig({ key: 'freellmapi-test' });
  const p = await m.freeProbe(); assert.equal(p.error, ''); assert.deepEqual(p.models, ['auto', 'gemini-2.5-flash']);
  const chunks: string[] = []; const r = await m.freeChat([{ role: 'user', content: 'hi' }], 'SYS', (c) => chunks.push(c));
  assert.equal(r.text, 'hello'); assert.deepEqual(chunks, ['hel', 'lo']); assert.equal(r.usage?.inputTokens, 11);
  assert.equal(seen.auth, 'Bearer freellmapi-test'); assert.equal(seen.body.stream, true); assert.equal(seen.body.messages[0].role, 'system');
  assert.deepEqual(m.parseSseLine('data: [DONE]'), { done: true }); assert.deepEqual(m.parseSseLine('event: x'), {});
  m.saveFreeConfig({ key: 'wrong' }); await assert.rejects(m.freeChat([{ role: 'user', content: 'x' }], '', () => undefined), /rejected the key/);
});

test('connections route reports FreeLLMAPI state without ever returning the key', async () => {
  const { default: Fastify } = await import('fastify'); const { accountsRoutes } = await import('../src/routes/accounts.js');
  const m = await import('../src/providers/freellmapi.js'); m.saveFreeConfig({ key: 'freellmapi-test' });
  const app = Fastify(); await app.register(accountsRoutes); await app.ready();
  assert.equal((await app.inject({ method: 'PUT', url: '/api/connections/freellmapi', payload: { model: 'x' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/connections/freellmapi', payload: { url: 'nope' }, headers: { 'x-aimax-ui': '1' } })).statusCode, 400);
  const r = await app.inject({ method: 'GET', url: '/api/connections' }); const t = r.body;
  assert.ok(!t.includes('freellmapi-test')); const b = r.json(); assert.equal(b.freellmapi.keySet, true); assert.equal(b.freellmapi.reachable, true);
  await app.close();
});

test('FreeLLMAPI: no key → no network probe at all; pointing at AImax\'s own port is explained', async () => {
  const m = await import('../src/providers/freellmapi.js');
  m.saveFreeConfig({ key: '' }); m.saveFreeConfig({ url: 'http://127.0.0.1:1/v1' });
  const t = Date.now(); assert.equal(await m.freeAvailable(), false); assert.ok(Date.now() - t < 50);
  process.env.PORT = '3001'; m.saveFreeConfig({ url: 'http://localhost:3001/v1' });
  const p = await m.freeProbe(); assert.equal(p.reachable, false); assert.match(p.error, /AImax itself.*different port/);
});
