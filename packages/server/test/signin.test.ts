import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.AIMAX_E2E_CHROME || '/usr/bin/google-chrome';
const HAVE_CHROME = existsSync(CHROME);
process.env.AIMAX_DATA_DIR = mkdtempSync(join(tmpdir(), 'aimax-si-'));
process.env.AIMAX_BROWSER_HEADLESS = '1'; process.env.AIMAX_BROWSER_EXE = CHROME;
let srv: Server; let host = '';
before(async () => {
  srv = createServer((req, res) => {
    const authed = /(^|;\s*)sid=ok-123/.test(req.headers.cookie ?? '');
    if (req.url === '/login') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=ok-123; Path=/; Max-Age=3600' }).end('<html><body><h1>Signed in</h1><p>You are now signed in to the fixture site and may continue.</p></body></html>'); return; }
    if (req.url === '/chat/1') {
      if (!authed) { res.writeHead(403, { 'content-type': 'text/html' }).end('<html><body>forbidden</body></html>'); return; }
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><title>Private chat</title></head><body><div id=app></div><script>document.getElementById('app').innerText='Human: what is the codename?\\nAssistant: The codename is PRIVATE-ZEBRA, decided last week by the team. ${'More detail. '.repeat(20)}'</script></body></html>`); return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>hi</body></html>');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); host = `127.0.0.1:${(srv.address() as any).port}`;
  process.env.AIMAX_LINKS_ALLOW_HOST = host;
});
after(async () => { srv.close(); const b = await import('../src/web/browser.js'); await b.closeSignIn(); });

test('403 page → needsSignIn; user signs in in the opened browser window and captures; the link then reads; forgetting clears it', { skip: !HAVE_CHROME, timeout: 90_000 }, async () => {
  const { readLink } = await import('../src/web/links.js'); const b = await import('../src/web/browser.js');
  const url = `http://${host}/chat/1`;
  const before = await readLink(url); assert.equal(before.ok, false); assert.equal(before.needsSignIn, true); assert.match(before.error!, /Open browser to sign in/);
  assert.equal(b.browserState().open, false);
  await assert.rejects(b.captureCurrentPage(url), /not open/);
  const opened = await b.openSignIn(url); assert.equal(opened.url, url); assert.equal(b.browserState().open, true);
  // the "user": signs in on the site, then opens the chat page
  const page = b.activePage(); await page.goto(`http://${host}/login`); await page.goto(url, { waitUntil: 'load' });
  const cap = await b.captureCurrentPage(url); assert.equal(cap.title, 'Private chat'); assert.ok(cap.chars > 100);
  const after = await readLink(url); assert.equal(after.ok, true); assert.equal(after.kind, 'signed-in page'); assert.match(after.text!, /PRIVATE-ZEBRA/);
  const { linkBlock } = await import('../src/web/links.js'); assert.match(linkBlock([after]).text, /PRIVATE-ZEBRA/);
  await b.closeSignIn(); assert.equal(b.browserState().open, false);
  // the sign-in persists in AImax's own profile: reopening needs no new login
  await b.openSignIn(`http://${host}/chat/1`); await b.activePage().waitForURL(/chat\/1/); await b.activePage().waitForLoadState('load');
  assert.match(await b.activePage().evaluate(() => document.body.innerText), /PRIVATE-ZEBRA/);
  await b.closeSignIn();
  assert.equal(b.forgetBrowserProfile(), true);
  await b.openSignIn(`http://${host}/chat/1`); await b.activePage().waitForURL(/chat\/1/); await b.activePage().waitForLoadState('load');
  assert.doesNotMatch(await b.activePage().evaluate(() => document.body.innerText), /PRIVATE-ZEBRA/);
  await b.closeSignIn();
  const { clearCaptures, getCapture } = await import('../src/web/captures.js'); assert.ok(clearCaptures() >= 1); assert.equal(getCapture(url), null);
});

test('blank/unfinished pages are not captured and file:/chrome: pages cannot be opened', { skip: !HAVE_CHROME, timeout: 60_000 }, async () => {
  const b = await import('../src/web/browser.js');
  await assert.rejects(b.openSignIn('file:///etc/passwd'), /http and https/); await assert.rejects(b.openSignIn('nope'), /valid link/);
  await b.openSignIn(`http://${host}/nothing`); await b.activePage().waitForURL(/nothing/);
  await assert.rejects(b.captureCurrentPage(`http://${host}/nothing`), /almost no readable text/);
  await b.closeSignIn();
});
