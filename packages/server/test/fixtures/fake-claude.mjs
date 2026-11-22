#!/usr/bin/env node
// Fake `claude` CLI for tests. Speaks the stream-json protocol and logs what it received to $FAKE_CLAUDE_LOG.
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.0.0-fake'); process.exit(0); }
const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
let stdin = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', d => (stdin += d));
process.stdin.on('end', async () => {
  const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
  const sysFile = args[args.indexOf('--append-system-prompt-file') + 1];
  let system = ''; try { system = readFileSync(sysFile, 'utf8'); } catch {}
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, stdin, system, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), pid: process.pid, resume }) + '\n');
  const out = o => process.stdout.write(JSON.stringify(o) + '\n');
  const sid = resume || 'sess-' + Math.random().toString(36).slice(2, 8);
  if (mode === 'ratelimit') { process.stderr.write('Claude usage limit reached. Your limit will reset at 5pm.'); process.exit(1); }
  if (mode === 'bad-exit') { process.stderr.write('boom'); process.exit(2); }
  if (mode === 'fail-resume' && resume) { out({ type: 'result', subtype: 'error', is_error: true, result: 'No conversation found with session ID ' + resume, session_id: resume }); process.exit(1); }
  out({ type: 'system', subtype: 'init', session_id: sid });
  if (mode === 'agent') {
    const { writeFileSync, appendFileSync: ap } = await import('node:fs');
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'agent-made.txt' } }] }, session_id: sid });
    writeFileSync('agent-made.txt', 'made by fake agent: ' + stdin.trim() + '\n');
    try { ap('app.txt', 'agent touched this\n'); } catch {}
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Created agent-made.txt.' } } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Created agent-made.txt.', session_id: sid });
    process.exit(0);
  }
  if (mode === 'slow') { for (let i = 0; i < 200; i++) { out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `s${i} ` } } }); await new Promise(r => setTimeout(r, 100)); } }
  if (mode !== 'assistant-only') {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } } });
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] }, session_id: sid });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Hello world', session_id: sid });
});
