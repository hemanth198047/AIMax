import { getDb } from '../db/index.js';

/** Pages the user captured from the sign-in browser. Local only, kept 24 hours, then deleted on next access. */
const TTL_MS = 24 * 3_600_000;
export const captureKey = (url: string) => { try { const u = new URL(url); u.hash = ''; return u.toString(); } catch { return url; } };

export function putCapture(urls: string[], title: string, text: string): void {
  const db = getDb(); const now = new Date().toISOString();
  const ins = db.prepare('INSERT OR REPLACE INTO web_captures(key,url,title,text,captured_at) VALUES(?,?,?,?,?)');
  db.transaction(() => { for (const u of new Set(urls.map(captureKey))) ins.run(u, u, title, text, now); })();
}
export function getCapture(url: string): { title: string; text: string; url: string } | null {
  const db = getDb();
  db.prepare('DELETE FROM web_captures WHERE captured_at < ?').run(new Date(Date.now() - TTL_MS).toISOString());
  const r = db.prepare('SELECT url, title, text FROM web_captures WHERE key=?').get(captureKey(url)) as { url: string; title: string; text: string } | undefined;
  return r ?? null;
}
export const clearCaptures = () => getDb().prepare('DELETE FROM web_captures').run().changes;
