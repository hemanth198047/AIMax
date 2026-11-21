import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAttachment } from '../src/attachments/extract.js';

const F = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const run = (name: string, as = name) => extractAttachment(join(F, name), as, '', statSync(join(F, name)).size);

test('DOCX: paragraphs, table cells, XML entities decoded', async () => {
  const r = await run('sample.docx');
  assert.equal(r.extracted, true);
  assert.match(r.text, /Release plan/); assert.match(r.text, /walrus-rollout starts on Monday & ends <Friday>/);
  assert.match(r.text, /Owner/); assert.match(r.text, /Alice/);
});
test('XLSX: sheets, shared strings and numbers, tab-separated', async () => {
  const r = await run('sample.xlsx');
  assert.match(r.text, /## Sheet: Budget/); assert.match(r.text, /narwhal license\t1200/); assert.match(r.text, /hosting\t3\.5/);
  assert.match(r.text, /## Sheet: Notes/); assert.match(r.text, /second-sheet-marker/);
});
test('PPTX: slide text', async () => {
  const r = await run('sample.pptx');
  assert.match(r.text, /Slide 1/); assert.match(r.text, /Kickoff deck/); assert.match(r.text, /pangolin agenda item/);
});
test('PDF: text per page; image-only PDF is reported honestly (no OCR)', async () => {
  const r = await run('sample.pdf');
  assert.equal(r.extracted, true);
  assert.match(r.text, /axolotl-metric rose 12 percent/); assert.match(r.text, /Page 2[\s\S]*platypus/);
  const b = await run('blank.pdf');
  assert.equal(b.extracted, false); assert.match(b.reason!, /no text layer/);
});
test('ZIP: listed only, never extracted; unsafe paths flagged', async () => {
  const r = await run('sample.zip');
  assert.match(r.text, /3 entries/); assert.match(r.text, /src\/a\.txt/); assert.match(r.text, /unsafe path/);
  assert.ok(!r.text.includes('hello'), 'contents are not read');
});
test('zip bombs are refused, not inflated', async () => {
  const t0 = Date.now();
  const d = await run('bomb.docx');
  assert.equal(d.extracted, false); assert.match(d.reason!, /zip-bomb/);
  assert.ok(Date.now() - t0 < 3000);
});
test('wrong or corrupt content with an Office/PDF extension fails cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ext-'));
  for (const name of ['fake.docx', 'fake.xlsx', 'fake.pdf', 'fake.zip']) {
    const p = join(dir, name); writeFileSync(p, 'this is not really that format');
    const r = await extractAttachment(p, name, '', 30);
    assert.equal(r.extracted, false, name); assert.match(r.reason!, /Could not read|not a/i, name);
  }
});
test('images and unknown binaries are stored but honestly unread; plain text still works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ext-'));
  const png = join(dir, 'a.png'); writeFileSync(png, Buffer.from([137, 80, 78, 71, 0, 1]));
  const r = await extractAttachment(png, 'a.png', 'image/png', 6);
  assert.equal(r.extracted, false); assert.match(r.reason!, /no OCR/);
  const txt = join(dir, 'n.txt'); writeFileSync(txt, 'hello');
  assert.equal((await extractAttachment(txt, 'n.txt', 'text/plain', 5)).text, 'hello');
});
test('long extraction is truncated and flagged', async () => {
  const { MAX_EXTRACT_BYTES } = await import('../src/attachments/extract.js');
  const dir = mkdtempSync(join(tmpdir(), 'ext-')); const p = join(dir, 'big.txt'); writeFileSync(p, 'x'.repeat(MAX_EXTRACT_BYTES + 500));
  const r = await extractAttachment(p, 'big.txt', 'text/plain', MAX_EXTRACT_BYTES + 500);
  assert.equal(r.truncated, true); assert.equal(r.text.length, MAX_EXTRACT_BYTES);
});
