#!/usr/bin/env node
// Fake Codex CLI: `codex exec - --json -o FILE`. FAKE_CODEX_MODE: ok | noevents | authfail
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-fake 0.0.1'); process.exit(0); }
let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, stdin, cwd: process.cwd(), hasKey: !!(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) }) + '\n');
  const mode = process.env.FAKE_CODEX_MODE || 'ok';
  if (mode === 'authfail') { process.stderr.write('Not logged in'); process.exit(1); }
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  if (mode === 'ok') { out({ type: 'thread.started' }); out({ type: 'item.completed', item: { type: 'agent_message', text: 'pong from codex' } }); }
  out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } });
  writeFileSync(args[args.indexOf('-o') + 1], 'pong from codex\n');
});
