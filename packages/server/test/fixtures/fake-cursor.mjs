#!/usr/bin/env node
// Fake Cursor CLI (print mode, stream-json). Logs what it received. FAKE_CURSOR_MODE: ok | authfail | exit
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2025.0.0-fake'); process.exit(0); }
let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  appendFileSync(process.env.FAKE_CURSOR_LOG, JSON.stringify({ args, stdin, cwd: process.cwd(), hasKey: !!process.env.CURSOR_API_KEY }) + '\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const mode = process.env.FAKE_CURSOR_MODE || 'ok';
  if (mode === 'authfail') { process.stderr.write('Error: Not logged in. Run agent login'); process.exit(1); }
  if (mode === 'exit') { process.exit(3); }
  out({ type: 'system', subtype: 'init', model: 'fake' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'pong ' }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'from cursor' }] } });
  out({ type: 'result', subtype: 'success', result: 'pong from cursor', duration_ms: 5 });
});
