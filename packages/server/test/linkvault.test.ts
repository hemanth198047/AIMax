import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'lv-'));
process.env.AIMAX_LINKVAULT_DB = join(dir, 'linkvault.db');
process.env.AIMAX_DATA_DIR = dir;
const d = new Database(process.env.AIMAX_LINKVAULT_DB);
d.exec(`CREATE TABLE links (id INTEGER PRIMARY KEY, url TEXT, platform TEXT, saved_at TEXT, note TEXT, title TEXT, description TEXT, summary TEXT, category TEXT, tags TEXT, status TEXT, transcript TEXT)`);
const ins = d.prepare('INSERT INTO links (url,saved_at,note,title,summary,category,tags,transcript) VALUES (?,?,?,?,?,?,?,?)');
ins.run('https://example.com/rag', '2026-01-01', '', 'Hybrid RAG with SQLite', 'Combining FTS5 and vectors for retrieval', 'rag-technique', 'rag,sqlite', 'SECRET-TRANSCRIPT-TEXT');
ins.run('https://example.com/cats', '2026-01-02', '', 'Cat videos', 'Funny cats', 'misc', 'cats', '');
d.close();

test('Link Vault search finds relevant saved links, never reads transcripts, and respects the budget', async () => {
  const { searchLinkVault, vaultBlock } = await import('../src/linkvault/search.js');
  const hits = searchLinkVault('how do I do hybrid retrieval with sqlite fts5');
  assert.equal(hits.length, 1); assert.equal(hits[0].url, 'https://example.com/rag');
  const b = vaultBlock(hits); assert.match(b.text, /Hybrid RAG/); assert.ok(!b.text.includes('SECRET-TRANSCRIPT'));
  assert.equal(vaultBlock(hits, 10).kept.length, 0);
  assert.deepEqual(searchLinkVault('zebra quantum'), []);
});
