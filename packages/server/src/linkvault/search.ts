import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { keywords } from '../gateway/context.js';
import { getSetting } from '../providers/usage.js';
import { linkVaultPath } from '../routes/linkvault.js';

export interface VaultHit { id: number; title: string; url: string; summary: string; tags: string; category: string }

/** Opt-in (Settings → Link Vault). Off by default because the matched text is sent to whichever provider answers the chat. */
export const linkVaultInChat = () => getSetting<boolean>('linkvault_in_chat', false) === true;

/** Read-only keyword search over title/summary/note/tags/url (transcripts are never read). Ranked by how many distinct keywords match. */
export function searchLinkVault(message: string, limit = 4): VaultHit[] {
  const terms = keywords(message, 8);
  const path = linkVaultPath();
  if (!terms.length || !existsSync(path)) return [];
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const esc = (s: string) => `%${s.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    const cols = ['title', 'summary', 'note', 'tags', 'url'];
    const score = terms.map(() => `(CASE WHEN ${cols.map((c) => `COALESCE(${c},'') LIKE ? ESCAPE '\\'`).join(' OR ')} THEN 1 ELSE 0 END)`).join(' + ');
    const params = terms.flatMap((t) => cols.map(() => esc(t)));
    const rows = db.prepare(`SELECT id, COALESCE(title,'') title, url, COALESCE(summary,'') summary, COALESCE(tags,'') tags, COALESCE(category,'') category, (${score}) s FROM links WHERE s >= ? ORDER BY s DESC, saved_at DESC LIMIT ?`)
      .all(...params, terms.length >= 3 ? 2 : 1, limit) as (VaultHit & { s: number })[];
    return rows.map(({ s: _s, ...r }) => r);
  } catch { return []; } finally { db?.close(); }
}

export function vaultBlock(hits: VaultHit[], budget = 1500): { text: string; used: number; kept: VaultHit[] } {
  const blocks: string[] = []; const kept: VaultHit[] = []; let used = 0;
  for (const h of hits) {
    const b = `[${h.title || h.url}] ${h.url}${h.category ? ` (${h.category})` : ''}${h.summary ? `: ${h.summary.slice(0, 300)}${h.summary.length > 300 ? '…' : ''}` : ''}`;
    if (used + b.length > budget) break; used += b.length; blocks.push(b); kept.push(h);
  }
  return { text: blocks.join('\n---\n'), used, kept };
}
