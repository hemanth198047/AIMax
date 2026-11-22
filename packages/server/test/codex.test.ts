import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const IS_POSIX = process.platform !== 'win32';
const data = mkdtempSync(join(tmpdir(), 'aimax-cdx-')); process.env.AIMAX_DATA_DIR = data;
const bin = mkdtempSync(join(tmpdir(), 'cdxbin-')); const LOG = join(bin, 'log'); writeFileSync(LOG, ''); process.env.FAKE_CODEX_LOG = LOG;
copyFileSync(resolve(import.meta.dirname, 'fixtures/fake-codex.mjs'), join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`; process.env.OPENAI_API_KEY = 'must-not-leak';

test('parseCodexLine: agent message, usage, errors; junk ignored', async () => {
  const { parseCodexLine } = await import('../src/providers/codex.js');
  assert.equal(parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}').delta, 'hi');
  assert.deepEqual(parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":2,"output_tokens":3}}').usage, { inputTokens: 5, outputTokens: 3, cacheReadTokens: 2 });
  assert.ok(parseCodexLine('{"type":"turn.failed","error":{"message":"x"}}').error); assert.deepEqual(parseCodexLine('???'), {});
});

test('Codex chat: stdin prompt, read-only exec args, scratch cwd, no API key; answer from -o file even if events are unknown', { skip: !IS_POSIX }, async () => {
  const { codexChat } = await import('../src/providers/codex.js');
  const chunks: string[] = []; const r = await codexChat([{ role: 'user', content: 'hello' }], 'SYS', (c) => chunks.push(c));
  assert.equal(r.text, 'pong from codex'); assert.equal(chunks.join(''), 'pong from codex'); assert.equal(r.usage?.inputTokens, 100);
  const l = JSON.parse(readFileSync(LOG, 'utf8').trim().split('\n').pop()!);
  assert.deepEqual(l.args.slice(0, 8), ['exec', '-', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-o']);
  assert.match(l.stdin, /hello/); assert.match(l.cwd, /codex-scratch/); assert.equal(l.hasKey, false);
  assert.ok(!readdirSync(data).some((f) => f.startsWith('codex-last-')));                 // temp file cleaned up
  process.env.FAKE_CODEX_MODE = 'noevents'; const c2: string[] = [];
  assert.equal((await codexChat([{ role: 'user', content: 'x' }], '', (c) => c2.push(c))).text, 'pong from codex'); assert.equal(c2.join(''), 'pong from codex');
  process.env.FAKE_CODEX_MODE = 'authfail';
  await assert.rejects(codexChat([{ role: 'user', content: 'x' }], '', () => undefined), /not signed in/i); delete process.env.FAKE_CODEX_MODE;
});
