import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-imp-'));
process.env.AIMAX_TEST_PROVIDER = '1';
const { default: Fastify } = await import('fastify');
const { default: multipart } = await import('@fastify/multipart');
const { importRoutes } = await import('../src/routes/import.js');
const { chatRoutes } = await import('../src/routes/chat.js');
const { conversationsRoutes } = await import('../src/routes/conversations.js');
const { getDb } = await import('../src/db/index.js');
const { redact } = await import('../src/importers/redact.js');
const { parseChatFile } = await import('../src/importers/generic.js');

let app: Awaited<ReturnType<typeof Fastify>>;
before(async () => {
  app = Fastify(); await app.register(multipart); await app.register(importRoutes); await app.register(chatRoutes); await app.register(conversationsRoutes); await app.ready();
  const db = getDb(); db.pragma('foreign_keys = OFF'); const now = new Date().toISOString();
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)').run('IP', 'Import Proj', now, now);
});
after(() => app.close());
const j = async (method: 'GET' | 'POST', url: string, payload?: object) => { const r = await app.inject({ method, url, payload }); return { s: r.statusCode, b: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null, raw: r.body }; };
function upload(name: string, content: string) {
  const b = '----x' + Math.random().toString(16).slice(2);
  return app.inject({ method: 'POST', url: '/api/import/file', headers: { 'content-type': `multipart/form-data; boundary=${b}` },
    payload: Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${b}--\r\n`) });
}

// ───────── Claude Code transcripts ─────────
const cc = mkdtempSync(join(tmpdir(), 'cc-')); mkdirSync(join(cc, '-home-me-app'), { recursive: true });
const L = (o: object) => JSON.stringify(o);
writeFileSync(join(cc, '-home-me-app', 'sess1.jsonl'), [
  L({ type: 'summary', summary: 'Fix the billing bug', leafUuid: 'x' }),
  L({ type: 'user', cwd: '/home/me/app', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: 'Why does invoice total drift? <system-reminder>ignore me</system-reminder>' } }),
  L({ type: 'assistant', timestamp: '2026-03-01T10:00:05Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm secret thoughts' }, { type: 'text', text: 'Rounding happens per line item.' }, { type: 'tool_use', id: 't', name: 'Edit', input: { file_path: 'src/billing.ts' } }] } }),
  L({ type: 'user', timestamp: '2026-03-01T10:00:06Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'HUGE FILE DUMP' }] } }),
  L({ type: 'assistant', timestamp: '2026-03-01T10:00:09Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done: round once at the end.' }] } }),
  L({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } }),
  L({ type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent noise' } }),
  L({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
  'not json at all',
  L({ type: 'user', timestamp: '2026-03-01T10:05:00Z', message: { role: 'user', content: [{ type: 'text', text: 'Now add a regression test. My key is sk-ant-abcdefghijklmnopqrstuvwxyz123456' }] } }),
].join('\n'));
writeFileSync(join(cc, '-home-me-app', 'empty.jsonl'), L({ type: 'system', content: 'x' }) + '\n');

test('Claude Code: scan lists readable sessions; import keeps real dialogue, drops tool dumps/thinking/noise, redacts secrets', async () => {
  const scan = await j('POST', '/api/import/scan', { source: 'claude-code', dir: cc });
  assert.equal(scan.s, 200); assert.equal(scan.b.items.length, 1);
  assert.deepEqual([scan.b.items[0].title, scan.b.items[0].messages, scan.b.items[0].project, scan.b.items[0].imported], ['Fix the billing bug', 3, '/home/me/app', false]);
  const prev = await j('POST', '/api/import/preview', { source: 'claude-code', dir: cc, id: scan.b.items[0].id });
  assert.equal(prev.b.messages, 3); assert.ok(!JSON.stringify(prev.b).includes('sk-ant-abcdef'));
  const run = await j('POST', '/api/import/run', { source: 'claude-code', dir: cc, ids: [scan.b.items[0].id], project_id: 'IP' });
  assert.equal(run.b.imported, 1, run.raw);
  const r = run.b.results[0]; assert.equal(r.redactions, 1);
  const conv = getDb().prepare('SELECT * FROM conversations WHERE id=?').get(r.conversationId) as any;
  assert.deepEqual([conv.scope, conv.project_id, conv.person_id, conv.import_source], ['project', 'IP', null, 'claude-code']);
  assert.equal(conv.title, 'Imported · Fix the billing bug');
  const msgs = getDb().prepare('SELECT role,content,provider FROM messages WHERE conversation_id=? ORDER BY created_at, rowid').all(r.conversationId) as any[];
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'user'], 'tool_result-only turn dropped; consecutive assistant text merged');
  assert.equal(msgs[0].content, 'Why does invoice total drift?');
  assert.match(msgs[1].content, /Rounding happens per line item\.[\s\S]*tools used: Edit src\/billing\.ts[\s\S]*Done: round once at the end\./);
  const all = msgs.map(m => m.content).join('\n');
  for (const bad of ['secret thoughts', 'HUGE FILE DUMP', 'ignore me', 'meta noise', 'subagent noise', '/clear', 'sk-ant-abcdef']) assert.ok(!all.includes(bad), bad);
  assert.match(msgs[2].content, /\[REDACTED api key\]/); assert.equal(msgs[1].provider, 'imported:claude-code');
  // de-duplication
  const again = await j('POST', '/api/import/run', { source: 'claude-code', dir: cc, ids: [scan.b.items[0].id] });
  assert.equal(again.b.results[0].status, 'skipped'); assert.equal(again.b.results[0].conversationId, r.conversationId);
  assert.equal((await j('POST', '/api/import/scan', { source: 'claude-code', dir: cc })).b.items[0].imported, true);
  // redaction can be switched off by the user
  getDb().prepare('DELETE FROM conversations WHERE id=?').run(r.conversationId);
  const raw = await j('POST', '/api/import/run', { source: 'claude-code', dir: cc, ids: [scan.b.items[0].id], redact: false });
  assert.match((getDb().prepare("SELECT content FROM messages WHERE conversation_id=? AND role='user' ORDER BY created_at DESC").get(raw.b.results[0].conversationId) as any).content, /sk-ant-abcdef/);
});

test('import safety: relative/traversal ids, wrong folders, missing project, bad input', async () => {
  for (const id of ['../outside.jsonl', '/etc/passwd', '-home-me-app/sess1.txt', '..\\..\\x.jsonl']) {
    const r = await j('POST', '/api/import/run', { source: 'claude-code', dir: cc, ids: [id] });
    assert.equal(r.b.results[0].status, 'error', id);
  }
  assert.equal((await j('POST', '/api/import/scan', { source: 'claude-code', dir: 'relative/path' })).s, 400);
  assert.equal((await j('POST', '/api/import/scan', { source: 'claude-code', dir: join(cc, 'nope') })).s, 404);
  assert.equal((await j('POST', '/api/import/scan', { source: 'bogus' })).s, 400);
  assert.equal((await j('POST', '/api/import/run', { source: 'claude-code', dir: cc, ids: ['x'], project_id: 'NOPE' })).s, 404);
  assert.equal((await j('POST', '/api/import/run', { source: 'claude-code', dir: cc, ids: [] })).s, 400);
});

// ───────── Cursor (synthetic databases in the layouts I know; real Cursor data is unverified) ─────────
const cur = mkdtempSync(join(tmpdir(), 'cursor-')); mkdirSync(join(cur, 'globalStorage'), { recursive: true });
{
  const g = new Database(join(cur, 'globalStorage', 'state.vscdb')); g.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  const put = (k: string, v: object) => g.prepare('INSERT INTO cursorDiskKV VALUES(?,?)').run(k, JSON.stringify(v));
  put('composerData:aaaaaaaa-1111', { name: 'Refactor auth', createdAt: 1767225600000, lastUpdatedAt: 1767229200000, fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }, { bubbleId: 'b2', type: 2 }] });
  put('bubbleId:aaaaaaaa-1111:b1', { type: 1, text: 'Split the auth module' }); put('bubbleId:aaaaaaaa-1111:b2', { type: 2, text: 'Created auth/session.ts and auth/token.ts' });
  put('composerData:bbbbbbbb-2222', { name: 'Inline convo', createdAt: 1767225600000, conversation: [{ type: 1, text: 'hi' }, { type: 2, text: 'hello' }] });
  put('composerData:cccccccc-3333', { name: 'Empty', conversation: [] });
  g.close();
  const hash = 'abcdef0123456789'; mkdirSync(join(cur, 'workspaceStorage', hash), { recursive: true });
  writeFileSync(join(cur, 'workspaceStorage', hash, 'workspace.json'), JSON.stringify({ folder: 'file:///home/me/old%20project' }));
  const w = new Database(join(cur, 'workspaceStorage', hash, 'state.vscdb')); w.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  w.prepare('INSERT INTO ItemTable VALUES(?,?)').run('workbench.panel.aichat.view.aichat.chatdata', JSON.stringify({ tabs: [{ tabId: 't1', chatTitle: 'Old chat', bubbles: [{ type: 'user', text: 'old question' }, { type: 'ai', rawText: 'old answer' }] }] }));
  w.close();
}
test('Cursor: reads composer chats (inline and bubble layouts) and older chat tabs, read-only, with diagnostics', async () => {
  const scan = await j('POST', '/api/import/scan', { source: 'cursor', dir: cur });
  assert.equal(scan.s, 200, scan.raw);
  const byTitle = Object.fromEntries(scan.b.items.map((i: any) => [i.title, i]));
  assert.deepEqual(Object.keys(byTitle).sort(), ['Inline convo', 'Old chat', 'Refactor auth']);
  assert.equal(byTitle['Old chat'].project, '/home/me/old project'); assert.ok(scan.b.diagnostics.some((d: string) => /3 composerData row/.test(d)));
  const run = await j('POST', '/api/import/run', { source: 'cursor', dir: cur, ids: Object.values<any>(byTitle).map(i => i.id), project_id: 'IP' });
  assert.equal(run.b.imported, 3, run.raw);
  const texts = (title: string) => (getDb().prepare("SELECT m.role,m.content FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.title=? ORDER BY m.created_at, m.rowid").all(`Imported · ${title}`) as any[]).map(m => `${m.role}:${m.content}`);
  assert.deepEqual(texts('Refactor auth'), ['user:Split the auth module', 'assistant:Created auth/session.ts and auth/token.ts']);
  assert.deepEqual(texts('Old chat'), ['user:old question', 'assistant:old answer']);
  assert.deepEqual(texts('Inline convo'), ['user:hi', 'assistant:hello']);
  const empty = await j('POST', '/api/import/scan', { source: 'cursor', dir: mkdtempSync(join(tmpdir(), 'nocursor-')) });
  assert.equal(empty.b.items.length, 0); assert.ok(empty.b.diagnostics.some((d: string) => /not found/.test(d)));
  const bad = await j('POST', '/api/import/run', { source: 'cursor', dir: cur, ids: ['global:../../x', 'ws:zz:t'] });
  assert.deepEqual(bad.b.results.map((r: any) => r.status), ['error', 'error']);
});

// ───────── exported files ─────────
test('files: OpenAI messages, ChatGPT export, Claude.ai export, markdown transcript, JSONL; unknown formats are rejected', async () => {
  const openai = parseChatFile(JSON.stringify({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'ping' }, { role: 'assistant', content: 'pong' }] }), 'gw.json');
  assert.deepEqual(openai[0].messages.map(m => m.role + ':' + m.content), ['user:ping', 'assistant:pong']);
  const chatgpt = parseChatFile(JSON.stringify([{ title: 'GPT chat', current_node: 'n3', mapping: {
    n1: { parent: null, children: ['n2'], message: null }, n2: { parent: 'n1', children: ['n3'], message: { author: { role: 'user' }, content: { parts: ['q?'] }, create_time: 1767225600 } },
    n3: { parent: 'n2', children: [], message: { author: { role: 'assistant' }, content: { parts: ['a.'] }, create_time: 1767225660 } } } }]), 'conversations.json');
  assert.equal(chatgpt[0].title, 'GPT chat'); assert.deepEqual(chatgpt[0].messages.map(m => m.content), ['q?', 'a.']);
  const claudeAi = parseChatFile(JSON.stringify([{ uuid: 'u1', name: 'Claude.ai chat', chat_messages: [{ sender: 'human', text: 'hello', created_at: '2026-01-01T00:00:00Z' }, { sender: 'assistant', text: 'hi!' }] }]), 'conversations.json');
  assert.equal(claudeAi[0].title, 'Claude.ai chat'); assert.equal(claudeAi[0].messages.length, 2);
  const md = parseChatFile('# Notes\n\nUser: how do I rotate keys?\nAnd quickly please\n\nAssistant: Use the vault CLI.\n- step 1\n\n**User:** thanks', 'chat.md');
  assert.deepEqual(md[0].messages.map(m => m.role), ['user', 'assistant', 'user']); assert.match(md[0].messages[0].content, /rotate keys\?\nAnd quickly please/); assert.match(md[0].messages[1].content, /step 1/);
  const jsonl = parseChatFile('{"role":"user","content":"a"}\n{"role":"assistant","content":"b"}', 'x.jsonl'); assert.equal(jsonl[0].messages.length, 2);
  assert.throws(() => parseChatFile('{"foo":1}', 'x.json'), /Could not recognise/); assert.throws(() => parseChatFile('   ', 'x.txt'), /empty/); assert.throws(() => parseChatFile('just some words with no roles', 'x.txt'), /Could not recognise/);
});

test('file upload → pick → import into a person+project context; expired uploads are refused', async () => {
  const body = JSON.stringify([{ uuid: 'z1', name: 'First', chat_messages: [{ sender: 'human', text: 'one' }, { sender: 'assistant', text: 'two' }] }, { uuid: 'z2', name: 'Second', chat_messages: [{ sender: 'human', text: 'three' }, { sender: 'assistant', text: 'four' }] }]);
  const up = (await upload('conversations.json', body)).json();
  assert.equal(up.items.length, 2);
  const db = getDb(); const now = new Date().toISOString(); db.prepare('INSERT INTO people(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run('IPP', 'Pat', now, now);
  const run = await j('POST', '/api/import/run', { source: 'file', importId: up.importId, ids: [up.items[1].id], project_id: 'IP', person_id: 'IPP' });
  assert.equal(run.b.imported, 1);
  const c = db.prepare('SELECT scope,project_id,person_id,title FROM conversations WHERE id=?').get(run.b.results[0].conversationId) as any;
  assert.deepEqual([c.scope, c.project_id, c.person_id, c.title], ['project_person', 'IP', 'IPP', 'Imported · Second']);
  assert.equal((await j('POST', '/api/import/run', { source: 'file', importId: 'nope', ids: ['x'] })).b.results[0].status, 'error');
  assert.equal((await upload('x.json', '{"foo":1}')).statusCode, 422);
  // imported conversations obey the normal scope rules: invisible from global context, visible in theirs
  const ids = async (q: string) => ((await j('GET', `/api/conversations?${q}`)).b as any[]).map(x => x.id);
  assert.ok(!(await ids('')).includes(run.b.results[0].conversationId));
  assert.ok((await ids('project_id=IP&person_id=IPP')).includes(run.b.results[0].conversationId));
});

test('redaction masks common credentials and leaves ordinary text alone', () => {
  const t = 'key sk-abcdefghijklmnopqrstuvwx, gh ghp_abcdefghijklmnopqrstuvwxyz0123456789, aws AKIAABCDEFGHIJKLMNOP, Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234, password = "hunter2hunter2", api_key: abc12345xyz, jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4fw\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----';
  const r = redact(t);
  for (const secret of ['sk-abcdefghijklmnopqrstuvwx', 'ghp_abcdef', 'AKIAABCDEFGHIJKLMNOP', 'abcdefghijklmnopqrstuvwxyz1234', 'hunter2hunter2', 'abc12345xyz', 'SflKxwRJSMeKKF2QT4fw', 'MIIE']) assert.ok(!r.text.includes(secret), secret);
  assert.ok(r.count >= 7); assert.match(r.text, /password = "\[REDACTED\]"/);
  const plain = 'The password policy requires rotation; use a token bucket for rate limiting.'; assert.equal(redact(plain).text, plain);
});

test('continuing an imported chat: long history is windowed, and older asks are carried as a digest', async () => {
  const db = getDb(); const now = Date.now(); db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO conversations(id,title,scope,created_at,updated_at,import_source,import_key) VALUES('long','Imported · long','global',?,?,'file','file:long')").run(new Date(now).toISOString(), new Date(now).toISOString());
  for (let i = 0; i < 60; i++) db.prepare('INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)').run(`lm${i}`, 'long', i % 2 === 0 ? 'user' : 'assistant', i % 2 === 0 ? `ask number ${i}` : `answer ${i}`, new Date(now - (200 - i) * 1000).toISOString());
  const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'continue please', provider: 'test', conversationId: 'long', scope: 'global' } });
  assert.equal(res.statusCode, 200);
  const out = res.body.split('\n').filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return {}; } }).map(o => o.text ?? '').join('');
  assert.match(out, /history-messages: 30/);                                   // 29 stored + the new one, within the window
  assert.match(out, /earlier-digest: \[Earlier in this conversation — 31 older message\(s\)/);
  assert.match(out, /ask number 30/); assert.doesNotMatch(out, /ask number 0\b/); assert.match(res.body, /31 older message/);
});
