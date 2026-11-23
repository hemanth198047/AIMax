import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-web-'));
const Fastify = (await import('fastify')).default; const { webRoutes } = await import('../src/routes/web.js');
const { readLink, linkBlock } = await import('../src/web/links.js'); const { getCapture } = await import('../src/web/captures.js');

test('a page the user pasted from their own browser is used for that link; guarded, validated, clearable', async () => {
  const app = Fastify(); await app.register(webRoutes); await app.ready();
  const url = 'https://claude.ai/chat/abc-123'; const H = { 'x-aimax-ui': '1' };
  assert.equal((await readLink(url)).needsSignIn, true);
  assert.equal((await app.inject({ method: 'POST', url: '/api/web/capture', payload: { url, text: 'x'.repeat(100) } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/web/capture', headers: H, payload: { url: 'nope', text: 'x'.repeat(100) } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/web/capture', headers: H, payload: { url, text: 'short' } })).statusCode, 422);
  const ok = await app.inject({ method: 'POST', url: '/api/web/capture', headers: H, payload: { url, title: 'My chat', text: 'Human: codename?\n\n\n\nAssistant: The codename is PASTED-OTTER and it was chosen on Monday.' } });
  assert.equal(ok.statusCode, 200);
  const r = await readLink(url); assert.equal(r.ok, true); assert.equal(r.kind, 'signed-in page'); assert.match(r.text!, /PASTED-OTTER/); assert.ok(!/\n{3}/.test(r.text!));
  assert.match(linkBlock([r]).text, /My chat — https:\/\/claude\.ai\/chat\/abc-123/);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/web/captures' })).statusCode, 403);
  assert.equal(((await app.inject({ method: 'DELETE', url: '/api/web/captures', headers: H })).json()).removedCapturedPages, 1);
  assert.equal(getCapture(url), null); await app.close();
});
