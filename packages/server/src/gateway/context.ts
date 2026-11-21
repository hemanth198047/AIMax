import { searchMemory, type MemoryRow } from '../memory/search.js';
import type { MemoryContext } from '../memory/scope.js';

export interface ContextItem { id: string; title: string; type: string; scope: string; provenance: string; chars: number }
export interface BuiltContext { items: ContextItem[]; text: string; usedChars: number; query: string }

const STOP = new Set(('the a an and or but if then than that this these those with without for from into onto over under about what which who whom whose when where why how is are was were be been being do does did can could should would will shall may might must i you he she it we they me my your our their them his her its of in on at to as by not no yes so just also please tell show give make get need want like know remind').split(' '));

/** Distinctive terms only: drop stop-words and very short tokens, keep order, de-duplicate. */
export function keywords(text: string, max = 10): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? []) {
    if (STOP.has(w) || seen.has(w)) continue;
    seen.add(w); out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Scope-aware retrieval with a hard character budget. The query is the current message PLUS the distinctive
 * terms of the last couple of user turns, so a follow-up like "and what about its rollout?" still finds context.
 */
export function buildContext(opts: { message: string; recentUserMessages: string[]; scope: MemoryContext; budgetChars?: number; maxItems?: number }): BuiltContext {
  const budget = opts.budgetChars ?? 3000;
  const terms = [...keywords(opts.message, 10), ...opts.recentUserMessages.slice(-2).flatMap(m => keywords(m, 6))];
  const query = [...new Set(terms)].join(' ');
  if (!query) return { items: [], text: '', usedChars: 0, query };

  const rows: MemoryRow[] = searchMemory(query, opts.scope, opts.maxItems ?? 8);
  const items: ContextItem[] = []; const blocks: string[] = []; let used = 0;
  for (const r of rows) {
    const content = r.content.length > 800 ? r.content.slice(0, 800) + '…' : r.content;
    const block = `[${r.title}] (${r.provenance}): ${content}`;
    if (used + block.length > budget) break;
    used += block.length; blocks.push(block);
    items.push({ id: r.id, title: r.title, type: r.type, scope: r.scope, provenance: r.provenance, chars: block.length });
  }
  return { items, text: blocks.join('\n---\n'), usedChars: used, query };
}
