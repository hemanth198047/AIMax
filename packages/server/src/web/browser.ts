/**
 * Sign-in browser: when a page needs a login, AImax opens a REAL, visible Chrome (or Edge) window on this computer, with its own separate
 * profile (never your everyday browser's profile). You sign in and open the page; AImax reads that page ONLY when you press "Read this page".
 * AImax never sees your password (you type it into the website itself), never reads pages on its own, and never reuses the login in the background.
 * Sign-ins are kept in AImax's profile folder until you press "Forget saved sign-ins".
 * Playwright (already a dev dependency of this repo) only drives the window; set AIMAX_BROWSER_EXE to use a specific browser.
 */
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DATA_DIR } from '../db/index.js';
import { putCapture } from './captures.js';

const PROFILE = join(DATA_DIR, 'browser-profile');
const IDLE_MS = 20 * 60_000;
let session: { ctx: any; url: string; timer: NodeJS.Timeout; closed: boolean } | null = null;

async function loadPlaywright(): Promise<any> {
  const req = createRequire(import.meta.url);
  for (const name of ['playwright-core', 'playwright', '@playwright/test']) { try { return req(name); } catch { /* try next */ } }
  throw new Error('The sign-in browser needs Playwright. Run "npm install" in the AImax folder and restart.');
}

export function browserState() { return { open: !!session && !session.closed, url: session?.url ?? '' }; }

export async function closeSignIn(): Promise<void> {
  const s = session; session = null; if (!s) return;
  clearTimeout(s.timer); s.closed = true; try { await s.ctx.close(); } catch { /* already closed */ }
}

export async function openSignIn(url: string): Promise<{ url: string; browser: string }> {
  let u: URL; try { u = new URL(url); } catch { throw new Error('That is not a valid link.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https pages can be opened.');
  await closeSignIn();
  const pw = await loadPlaywright(); mkdirSync(PROFILE, { recursive: true });
  const headless = process.env.AIMAX_BROWSER_HEADLESS === '1';
  const common = { headless, viewport: headless ? { width: 1200, height: 800 } : null, args: ['--no-first-run', '--no-default-browser-check'] };
  const tries: [string, Record<string, unknown>][] = process.env.AIMAX_BROWSER_EXE ? [['custom browser', { executablePath: process.env.AIMAX_BROWSER_EXE }]]
    : [['Chrome', { channel: 'chrome' }], ['Edge', { channel: 'msedge' }]];
  let ctx: any = null; let used = ''; let lastErr = '';
  for (const [label, opt] of tries) { try { ctx = await pw.chromium.launchPersistentContext(PROFILE, { ...common, ...opt }); used = label; break; } catch (e) { lastErr = e instanceof Error ? e.message : String(e); } }
  if (!ctx) throw new Error(`Could not open Chrome or Edge on this computer (${lastErr.split('\n')[0]}). Install Chrome, or set AIMAX_BROWSER_EXE to your browser's .exe path.`);
  const s = { ctx, url: u.toString(), closed: false, timer: setTimeout(() => { void closeSignIn(); }, IDLE_MS) };
  ctx.on('close', () => { s.closed = true; if (session === s) session = null; });
  session = s;
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);   // the user may still be signing in; do not block on it
  return { url: u.toString(), browser: used };
}

/** Test hook: the page the user would be looking at. */
export const activePage = (): any => { const pages = session?.ctx.pages() ?? []; return pages[pages.length - 1] ?? null; };

/** Reads the page currently shown in the sign-in window (only when the user asks). */
export async function captureCurrentPage(forUrl: string): Promise<{ title: string; url: string; chars: number }> {
  if (!session || session.closed) throw new Error('The sign-in window is not open any more. Click "Open browser to sign in" again.');
  const page = activePage(); if (!page) throw new Error('There is no page open in the sign-in window.');
  await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => undefined);      // the user may have just clicked a link
  const url: string = page.url();
  if (!/^https?:\/\//i.test(url)) throw new Error('Open the page you want AImax to read in that window first.');
  // Trigger lazy-loaded content (long chats/articles) by scrolling through the page, then return to the top.
  try { await page.evaluate(async () => { const el = document.scrollingElement ?? document.body; for (let i = 0; i < 40; i++) { el.scrollTop += window.innerHeight; await new Promise((r) => setTimeout(r, 120)); if (el.scrollTop + window.innerHeight >= el.scrollHeight - 4) break; } el.scrollTop = 0; }); } catch { /* page may block scripts */ }
  const title: string = await page.title().catch(() => '');
  const read = () => page.evaluate(() => (document.body?.innerText ?? ''));
  const text: string = (await read().catch(async () => { await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => undefined); return read(); })).replace(/\n{3,}/g, '\n\n').trim().slice(0, 200_000);
  if (text.length < 40) throw new Error('That page has almost no readable text yet. Finish signing in, open the page you want, wait for it to load, then try again.');
  putCapture([forUrl, url], title, text);
  return { title, url, chars: text.length };
}

export function forgetBrowserProfile(): boolean {
  void closeSignIn(); if (!existsSync(PROFILE)) return false;
  rmSync(PROFILE, { recursive: true, force: true }); return true;
}
