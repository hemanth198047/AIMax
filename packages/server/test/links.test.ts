import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

let srv: Server; let host = '';
const BIG = 'x'.repeat(3 * 1024 * 1024);
before(async () => {
  srv = createServer((req, res) => {
    const u = req.url ?? '';
    if (u === '/page') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<html><head><title>Test &amp; Page</title><meta name="description" content="A short description of the page that is long enough to count."><style>.x{}</style><script>alert('SECRET-SCRIPT')</script></head><body><nav>NAVMENU</nav><main><h1>Main heading</h1><p>First paragraph with <a href="/x">a link</a> and enough words to be useful for the reader of this page, really.</p><ul><li>one</li><li>two</li></ul><p>${'More text. '.repeat(60)}</p></main><footer>FOOTERJUNK</footer></body></html>`); return; }
    if (u === '/redir') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end(); return; }
    if (u === '/redir-ok') { res.writeHead(302, { location: '/page' }).end(); return; }
    if (u === '/json') { res.setHeader('content-type', 'application/json'); res.end('{"a":1}'); return; }
    if (u === '/big') { res.setHeader('content-type', 'text/plain'); res.end(BIG); return; }
    if (u === '/bin') { res.setHeader('content-type', 'application/zip'); res.end('PK'); return; }
    if (u === '/empty') { res.setHeader('content-type', 'text/html'); res.end('<html><body><div id=root></div></body></html>'); return; }
    if (u === '/slow') { return; }
    res.writeHead(404).end('nope');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); host = `127.0.0.1:${(srv.address() as any).port}`;
});
after(() => srv.close());

test('extractUrls: finds http(s) links, trims punctuation, dedupes, caps at 3, ignores other schemes', async () => {
  const { extractUrls } = await import('../src/web/links.js');
  assert.deepEqual(extractUrls('see https://a.com/x), and (https://b.com/y). also https://a.com/x#frag ftp://c.com file:///etc/passwd javascript:alert(1)'), ['https://a.com/x', 'https://b.com/y']);
  assert.equal(extractUrls('https://1.com https://2.com https://3.com https://4.com').length, 3);
});

test('isPrivateAddress blocks loopback, private, link-local, metadata, CGNAT, IPv6 and mapped addresses', async () => {
  const { isPrivateAddress: p } = await import('../src/web/links.js');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'garbage']) assert.equal(p(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(p(ip), false, ip);
});

test('private and internal targets are refused (no hook): loopback, localhost, metadata, IPv6 loopback, credentials, other schemes', async () => {
  delete process.env.AIMAX_LINKS_ALLOW_HOST; const { readLink } = await import('../src/web/links.js');
  for (const u of [`http://${host}/page`, 'http://localhost:1/', 'http://169.254.169.254/latest', 'http://[::1]:1/', 'http://10.0.0.1/', 'http://u:p@example.com/', 'ftp://example.com/']) {
    const r = await readLink(u); assert.equal(r.ok, false, u); assert.match(r.error ?? '', /private|internal|credentials|http/i, u);
  }
});

test('reads a page: title, description, main content only (no scripts, nav, footer); redirects followed; JSON read', async () => {
  process.env.AIMAX_LINKS_ALLOW_HOST = host; const { readLink, linkBlock } = await import('../src/web/links.js');
  const r = await readLink(`http://${host}/redir-ok`);
  assert.equal(r.ok, true); assert.equal(r.title, 'Test & Page'); assert.match(r.finalUrl ?? '', /\/page$/);
  assert.match(r.text!, /# Main heading/); assert.match(r.text!, /- one\n- two/); assert.match(r.text!, /A short description/);
  for (const bad of ['SECRET-SCRIPT', 'NAVMENU', 'FOOTERJUNK', '<p>']) assert.ok(!r.text!.includes(bad), bad);
  assert.equal((await readLink(`http://${host}/json`)).text, '{"a":1}');
  const blk = linkBlock([r]); assert.match(blk.text, /^### Test & Page — http/);
});

test('redirect into a private address is blocked; failures are explained, never silent', async () => {
  process.env.AIMAX_LINKS_ALLOW_HOST = host; const { readLink, linkBlock } = await import('../src/web/links.js');
  const r = await readLink(`http://${host}/redir`); assert.equal(r.ok, false); assert.match(r.error!, /private|internal/i);
  assert.match((await readLink(`http://${host}/missing`)).error!, /HTTP 404/);
  assert.match((await readLink(`http://${host}/bin`)).error!, /Unsupported content type/);
  assert.match((await readLink(`http://${host}/empty`)).error!, /almost no readable text/);
  const big = await readLink(`http://${host}/big`); assert.equal(big.ok, false); assert.match(big.error!, /larger than 2 MB/);
  assert.match(linkBlock([r]).text, /could not read this link.*Do not guess/s);
});

test('a hanging server can be cancelled', async () => {
  process.env.AIMAX_LINKS_ALLOW_HOST = host; const { readLink } = await import('../src/web/links.js');
  const c = new AbortController(); setTimeout(() => c.abort(), 200); const t = Date.now();
  const r = await readLink(`http://${host}/slow`, c.signal); assert.equal(r.ok, false); assert.ok(Date.now() - t < 3000);
});

test('private chat pages and refused pages give an actionable workaround; nothing is fetched for private chats', async () => {
  delete process.env.AIMAX_LINKS_ALLOW_HOST; const { readLink } = await import('../src/web/links.js');
  for (const u of ['https://claude.ai/chat/abc-123', 'https://chatgpt.com/c/abc']) {
    const r = await readLink(u); assert.equal(r.ok, false); assert.match(r.error!, /private to your account/); assert.match(r.error!, /Import chats/); assert.match(r.error!, /paste/i);
  }
  process.env.AIMAX_LINKS_ALLOW_HOST = host;
  const { createServer } = await import('node:http');
  const s403 = createServer((_q, res) => { res.writeHead(403).end('no'); }); await new Promise<void>((r) => s403.listen(0, '127.0.0.1', r));
  process.env.AIMAX_LINKS_ALLOW_HOST = `127.0.0.1:${(s403.address() as any).port}`;
  const r = await readLink(`http://${process.env.AIMAX_LINKS_ALLOW_HOST}/x`); s403.close();
  assert.match(r.error!, /needs a sign-in or blocks automated readers/); assert.match(r.error!, /copy, and paste/);
});
