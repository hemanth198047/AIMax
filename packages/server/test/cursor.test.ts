import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const IS_POSIX = process.platform !== 'win32';
process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-cur-'));
const bin = mkdtempSync(join(tmpdir(), 'curbin-'));
const LOG = join(bin, 'log'); writeFileSync(LOG, ''); process.env.FAKE_CURSOR_LOG = LOG;
copyFileSync(resolve(import.meta.dirname, 'fixtures/fake-cursor.mjs'), join(bin, 'cursor-agent')); chmodSync(join(bin, 'cursor-agent'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.CURSOR_API_KEY = 'key-should-not-leak';

test('parseCursorLine reads assistant text and result, ignores junk', async () => {
  const { parseCursorLine } = await import('../src/providers/cursor.js');
  assert.deepEqual(parseCursorLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}'), { delta: 'hi' });
  assert.equal(parseCursorLine('{"type":"result","result":"done"}').result, 'done');
  assert.ok(parseCursorLine('{"type":"result","is_error":true,"result":"bad"}').error);
  assert.deepEqual(parseCursorLine('not json'), {});
});

test('Cursor chat: prompt on stdin, fixed args, scratch cwd, no API key, streamed text', { skip: !IS_POSIX }, async () => {
  const { cursorChat } = await import('../src/providers/cursor.js');
  const chunks: string[] = [];
  const r = await cursorChat([{ role: 'user', content: 'hello there' }], 'SYS', (c) => chunks.push(c));
  assert.equal(r.text, 'pong from cursor'); assert.equal(chunks.join(''), 'pong from cursor');
  const l = JSON.parse(readFileSync(LOG, 'utf8').trim().split('\n').pop()!);
  assert.deepEqual(l.args, ['-p', '--output-format', 'stream-json']); assert.match(l.stdin, /hello there/); assert.match(l.stdin, /SYS/);
  assert.match(l.cwd, /cursor-scratch/); assert.equal(l.hasKey, false);
});

test('Cursor chat: sign-in problems and crashes become clear errors', { skip: !IS_POSIX }, async () => {
  const { cursorChat } = await import('../src/providers/cursor.js');
  process.env.FAKE_CURSOR_MODE = 'authfail';
  await assert.rejects(cursorChat([{ role: 'user', content: 'x' }], '', () => undefined), /not signed in/i);
  process.env.FAKE_CURSOR_MODE = 'exit';
  await assert.rejects(cursorChat([{ role: 'user', content: 'x' }], '', () => undefined), /exited with code 3/);
  delete process.env.FAKE_CURSOR_MODE;
});
