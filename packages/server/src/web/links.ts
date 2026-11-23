/**
 * Read links pasted into a chat message and turn them into context.
 * Safety model: only public http(s) hosts. Every address a host resolves to is checked AT CONNECT TIME (so DNS tricks cannot swap in a private
 * address), redirects are followed manually and re-checked, no cookies/credentials are sent, size/time are capped, and the text is always
 * handed to the model as untrusted data. Nothing is written to disk except a temp file for PDFs, deleted straight away.
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAttachment } from '../attachments/extract.js';

export const LINK_LIMITS = { maxLinks: 3, maxBytes: 2 * 1024 * 1024, maxPdfBytes: 10 * 1024 * 1024, timeoutMs: 10_000, redirects: 4, charsPerLink: 12_000, totalChars: 24_000 };

export function extractUrls(message: string): string[] {
  const found = message.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  const out: string[] = [];
  for (let u of found) {
    u = u.replace(/[)\].,;:!?}*_]+$/, '');                                         // trailing punctuation / markdown
    try { const p = new URL(u); if (!/^https?:$/.test(p.protocol)) continue; p.hash = ''; const s = p.toString(); if (!out.includes(s)) out.push(s); } catch { /* not a URL */ }
    if (out.length >= LINK_LIMITS.maxLinks) break;
  }
  return out;
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved, cloud-metadata and mapped/ULA IPv6 addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x); if (mapped) return isPrivateAddress(mapped[1]);
    if (x.startsWith('::ffff:')) return true;                                            // hex-form mapped addresses: refuse
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff') || x.startsWith('64:ff9b') || x.startsWith('2001:db8');
  }
  return true;
}

const safeLookup: net.LookupFunction = (hostname, options, cb) => {
  dns.lookup(hostname, { ...(options as dns.LookupOptions), all: true }, (err, addrs) => {
    if (err) return (cb as any)(err);
    const list = (addrs as dns.LookupAddress[]);
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || !list.length) return (cb as any)(Object.assign(new Error('That address is private or internal; AImax only reads public web pages.'), { code: 'EPRIVATE' }));
    if ((options as dns.LookupOptions).all) return (cb as any)(null, list);
    (cb as any)(null, list[0].address, list[0].family);
  });
};

interface Raw { status: number; headers: http.IncomingHttpHeaders; body: Buffer; finalUrl: string }

function once(url: URL, maxBytes: number, signal?: AbortSignal): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    // Test hook only: exactly one host:port (e.g. a local fixture server) may be reached; everything else stays blocked.
    const allowed = !!process.env.AIMAX_LINKS_ALLOW_HOST && process.env.AIMAX_LINKS_ALLOW_HOST === url.host;
    if (!allowed && net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('That address is private or internal; AImax only reads public web pages.'));
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET', lookup: allowed ? (dns.lookup as unknown as net.LookupFunction) : safeLookup, timeout: LINK_LIMITS.timeoutMs, agent: false,
      headers: { 'User-Agent': 'AImax-link-reader/1.0 (local app; reads pages you paste)', Accept: 'text/html,text/plain,application/json,application/pdf;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'identity' },
    }, (res) => {
      const chunks: Buffer[] = []; let size = 0; let over = false;
      res.on('data', (c: Buffer) => { size += c.length; if (size > maxBytes) { over = true; req.destroy(); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('close', () => { if (over) resolve({ status: res.statusCode ?? 0, headers: { ...res.headers, 'x-aimax-truncated': '1' }, body: Buffer.concat(chunks) }); });
      res.on('error', reject);
    });
    const onAbort = () => req.destroy(new Error('Cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${LINK_LIMITS.timeoutMs / 1000}s`)));
    req.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    req.end();
  });
}

async function get(start: string, maxBytes: number, signal?: AbortSignal): Promise<Raw> {
  let url = new URL(start);
  for (let i = 0; i <= LINK_LIMITS.redirects; i++) {
    if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https links are read.');
    if (url.username || url.password) throw new Error('Links with embedded credentials are not read.');
    const r = await once(url, maxBytes, signal);
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) { url = new URL(String(r.headers.location), url); continue; }
    return { ...r, finalUrl: url.toString() };
  }
  throw new Error('Too many redirects.');
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return ENT[e.toLowerCase()] ?? m;
});

export function htmlToText(html: string): { title: string; description: string; text: string } {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim());
  const description = decode((/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ?? '').trim());
  let h = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template|iframe|canvas|form|select)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1>/i.exec(h); if (main && main[2].length > 500) h = main[2];
  else h = h.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `).replace(/<li[^>]*>/gi, '\n- ').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|tr|table|ul|ol|pre|blockquote|h[1-6])>/gi, '\n').replace(/<(p|div|section|tr|pre|blockquote)[^>]*>/gi, '\n').replace(/<\/t[dh]>/gi, ' | ').replace(/<[^>]+>/g, '');
  const text = decode(h).split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, description, text };
}

export interface LinkResult { url: string; finalUrl?: string; ok: boolean; title?: string; text?: string; truncated?: boolean; kind?: string; error?: string }

const PRIVATE_CHAT = /^(?:www\.)?(claude\.ai|chatgpt\.com|chat\.openai\.com|gemini\.google\.com|copilot\.microsoft\.com|perplexity\.ai)$/i;
function gatedHint(u: URL, status?: number): string | null {
  const host = u.hostname;
  const isShare = /\/share\//.test(u.pathname);
  if (PRIVATE_CHAT.test(host) && !isShare) return `${host} chats are private to your account, so AImax cannot open them (nothing was sent there). Workarounds: (1) paste the chat text into the message, (2) in that chat ask for a handoff summary and paste it, or (3) export your chats (Claude: Settings → Privacy → Export data; ChatGPT: Settings → Data controls → Export) and use "Import chats" in AImax's sidebar, then continue the chat there.`;
  if (status === 401 || status === 403) return `The site refused the request${PRIVATE_CHAT.test(host) ? ' (shared chat pages usually block automated readers)' : ' (it needs a sign-in or blocks automated readers)'}. Workaround: open the page yourself, select all, copy, and paste the text into the message — or save it as a PDF/text file and attach it, or add it to the project's knowledge.`;
  return null;
}

export async function readLink(url: string, signal?: AbortSignal): Promise<LinkResult> {
  try {
    const gated = gatedHint(new URL(url)); if (gated) return { url, ok: false, error: gated };
    const first = await get(url, LINK_LIMITS.maxPdfBytes, signal);
    const type = String(first.headers['content-type'] ?? '').toLowerCase();
    if (first.status >= 400) return { url, ok: false, error: gatedHint(new URL(first.finalUrl), first.status) ?? `The site answered HTTP ${first.status}.` };
    const cap = LINK_LIMITS.charsPerLink; const trunc = !!first.headers['x-aimax-truncated'];
    if (type.includes('application/pdf')) {
      if (trunc) return { url, ok: false, error: 'The PDF is larger than 10 MB.' };
      const dir = mkdtempSync(join(tmpdir(), 'aimax-link-')); const f = join(dir, 'page.pdf');
      try { writeFileSync(f, first.body); const x = await extractAttachment(f, 'page.pdf', 'application/pdf', first.body.length);
        if (!x.extracted) return { url, ok: false, error: x.reason ?? 'Could not read the PDF text.' };
        return { url, finalUrl: first.finalUrl, ok: true, kind: 'pdf', text: x.text.slice(0, cap), truncated: x.truncated || x.text.length > cap };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    if (first.body.length > LINK_LIMITS.maxBytes) return { url, ok: false, error: 'The page is larger than 2 MB.' };
    const body = first.body.toString('utf8');
    if (type.includes('html') || /^\s*<(!doctype|html)/i.test(body)) {
      const h = htmlToText(body); const text = [h.description && h.description !== h.text.slice(0, h.description.length) ? h.description : '', h.text].filter(Boolean).join('\n\n');
      if (text.length < 80) return { url, ok: false, error: 'The page has almost no readable text (it may need JavaScript or a sign-in).' };
      return { url, finalUrl: first.finalUrl, ok: true, kind: 'html', title: h.title, text: text.slice(0, cap), truncated: trunc || text.length > cap };
    }
    if (/^(text\/|application\/(json|xml|x-yaml|yaml)|application\/[\w.+-]*\+(json|xml))/.test(type) || type === '') {
      return { url, finalUrl: first.finalUrl, ok: true, kind: 'text', text: body.slice(0, cap), truncated: trunc || body.length > cap };
    }
    return { url, ok: false, error: `Unsupported content type (${type.split(';')[0] || 'unknown'}). Only pages, text, JSON and PDF are read.` };
  } catch (e) {
    const err = e as NodeJS.ErrnoException; const msg = err.code === 'ENOTFOUND' ? 'That host name does not exist.' : err.code === 'ECONNREFUSED' ? 'The server refused the connection.' : err instanceof Error ? err.message : String(e);
    return { url, ok: false, error: msg };
  }
}

/** Wraps fetched pages for the model. Marked as untrusted so instructions inside a page are not followed. */
export function linkBlock(results: LinkResult[]): { text: string; used: number } {
  let budget = LINK_LIMITS.totalChars; const parts: string[] = [];
  for (const r of results) {
    if (!r.ok) { parts.push(`### ${r.url}\n[AImax could not read this link: ${r.error} Do not guess what it contains; tell the user it could not be read and pass on the workaround.]`); continue; }
    const t = (r.text ?? '').slice(0, Math.max(0, budget)); budget -= t.length;
    parts.push(`### ${r.title ? `${r.title} — ` : ''}${r.finalUrl ?? r.url}${r.finalUrl && r.finalUrl !== r.url ? ` (from ${r.url})` : ''}\n${t}${r.truncated || t.length < (r.text?.length ?? 0) ? '\n[…page truncated]' : ''}`);
  }
  return { text: parts.join('\n\n'), used: LINK_LIMITS.totalChars - budget };
}
