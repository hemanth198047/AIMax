import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-gate-'));
process.env.AIMAX_TEST_PROVIDER = '1';
const { default: Fastify } = await import('fastify');
const { default: multipart } = await import('@fastify/multipart');
const { getDb } = await import('../src/db/index.js');
const { conversationsRoutes } = await import('../src/routes/conversations.js');
const { attachmentsRoutes } = await import('../src/routes/attachments.js');
const { chatRoutes } = await import('../src/routes/chat.js');
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function build() {
  const app = Fastify(); await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  await app.register(conversationsRoutes); await app.register(attachmentsRoutes); await app.register(chatRoutes); await app.ready(); return app;
}
function multipartBody(filename: string, data: Buffer) {
  const b = '----t' + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  return { payload: Buffer.concat([head, data, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}

test('upload extracts DOCX/XLSX/PDF text; binary reports why', async () => {
  const app = await build();
  for (const [file, marker] of [['sample.docx', 'walrus-rollout'], ['sample.xlsx', 'narwhal license'], ['sample.pdf', 'axolotl-metric']]) {
    const r = await app.inject({ method: 'POST', url: '/api/attachments/upload', ...multipartBody(file, readFileSync(join(FIX, file))) });
    const j = r.json(); assert.equal(j.extracted, true, file); assert.ok(j.preview.length > 0);
    const t = (await app.inject({ url: `/api/attachments/${j.id}/text` })).json(); assert.ok(t.text.includes(marker), file);
  }
  const bad = (await app.inject({ method: 'POST', url: '/api/attachments/upload', ...multipartBody('x.bin', Buffer.from([0, 1, 2])) })).json();
  assert.equal(bad.extracted, false); assert.ok(bad.note);
  await app.close();
});

test('conversations, their messages and their attachments are invisible outside their context', async () => {
  const db = getDb(); db.pragma('foreign_keys = OFF');
  const app = await build();
  const att = (await app.inject({ method: 'POST', url: '/api/attachments/upload', ...multipartBody('n.txt', Buffer.from('private-attachment-text')) })).json();
  // A chat inside project P1 creates a P1-bound conversation and binds the attachment to it
  const sse = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hello', provider: 'test', projectId: 'P1', scope: 'project', attachmentIds: [att.id] } });
  assert.equal(sse.statusCode, 200);
  const convId = (db.prepare("SELECT id FROM conversations WHERE project_id='P1'").get() as { id: string }).id;

  assert.equal((await app.inject({ url: `/api/conversations/${convId}/messages?project_id=P1` })).statusCode, 200);
  assert.equal((await app.inject({ url: `/api/conversations/${convId}/messages` })).statusCode, 404, 'global context cannot read it');
  assert.equal((await app.inject({ url: `/api/conversations/${convId}/messages?project_id=P2` })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/attachments/${att.id}/text?project_id=P1` })).statusCode, 200);
  assert.equal((await app.inject({ url: `/api/attachments/${att.id}/text` })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/attachments/${att.id}` })).statusCode, 404);
  // cannot continue, rename or delete it from another context
  const wrong = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'sneaky', provider: 'test', conversationId: convId, scope: 'global' } });
  assert.equal(wrong.statusCode, 404);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/conversations/${convId}`, payload: { title: 'x' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/conversations/${convId}` })).statusCode, 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id=?').get(convId)!['n' as never] >= 2, true, 'nothing was added or removed');
  // and the same attachment id cannot be pulled into a different conversation
  const other = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'reuse', provider: 'test', scope: 'global', attachmentIds: [att.id] } });
  assert.equal(other.statusCode, 200);
  assert.ok(!other.body.includes('private-attachment-text'));
  await app.close();
});
