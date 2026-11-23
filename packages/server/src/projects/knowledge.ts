import { getDb } from '../db/index.js';
import { keywords } from '../gateway/context.js';

/** Capacity of one project's knowledge, in characters of text (about 150k tokens). Shown to the user as a meter, like Claude's projects. */
export const KNOWLEDGE_CAP_CHARS = 600_000;
const WHOLE_IF_UNDER = 6_000;           // small knowledge bases are included whole
const CHUNK = 1_200;

export interface KnowledgeRow { id: string; kind: string; title: string; source: string; mimetype: string; size: number; chars: number; created_at: string }

export function listKnowledge(projectId: string): { items: KnowledgeRow[]; usedChars: number; capChars: number } {
  const items = getDb().prepare("SELECT id, kind, title, source, mimetype, size, LENGTH(text) chars, created_at FROM project_knowledge WHERE project_id=? ORDER BY created_at DESC, rowid DESC").all(projectId) as KnowledgeRow[];
  return { items, usedChars: items.reduce((n, i) => n + i.chars, 0), capChars: KNOWLEDGE_CAP_CHARS };
}

export function addKnowledge(projectId: string, row: { id: string; kind: 'file' | 'note' | 'link'; title: string; source?: string; mimetype?: string; size?: number; text: string }): { ok: true } | { ok: false; error: string } {
  const text = row.text.replace(/\u0000/g, '').trim();
  if (!text) return { ok: false, error: 'There is no text to add.' };
  const used = listKnowledge(projectId).usedChars;
  if (used + text.length > KNOWLEDGE_CAP_CHARS) return { ok: false, error: `This project's knowledge is full (${used.toLocaleString()} of ${KNOWLEDGE_CAP_CHARS.toLocaleString()} characters). Remove something first.` };
  getDb().prepare('INSERT INTO project_knowledge(id,project_id,kind,title,source,mimetype,size,text) VALUES(?,?,?,?,?,?,?,?)')
    .run(row.id, projectId, row.kind, row.title.slice(0, 200) || 'Untitled', row.source ?? '', row.mimetype ?? '', row.size ?? text.length, text);
  return { ok: true };
}

export interface KnowledgeHit { id: string; title: string; chars: number }

/** Relevant parts of a project's knowledge for this message: everything if small, else the best-matching chunks within the budget. */
export function knowledgeBlock(projectId: string | null | undefined, messages: string[], budget = 6000): { text: string; used: number; hits: KnowledgeHit[]; files: string[] } {
  if (!projectId) return { text: '', used: 0, hits: [], files: [] };
  const rows = getDb().prepare('SELECT id, title, text FROM project_knowledge WHERE project_id=? ORDER BY created_at, rowid').all(projectId) as { id: string; title: string; text: string }[];
  if (!rows.length) return { text: '', used: 0, hits: [], files: [] };
  const files = rows.map((r) => r.title);
  const total = rows.reduce((n, r) => n + r.text.length, 0);
  const pieces: { id: string; title: string; text: string; score: number; order: number }[] = [];
  const terms = [...new Set(messages.flatMap((m, i) => keywords(m, i === messages.length - 1 ? 10 : 6)))];
  let order = 0;
  for (const r of rows) {
    const paras = r.text.split(/\n{2,}/); let cur = '';
    const flush = () => { if (cur.trim()) { const low = cur.toLowerCase(); pieces.push({ id: r.id, title: r.title, text: cur.trim(), order: order++, score: terms.reduce((n, t) => n + (low.includes(t) ? 1 : 0), 0) }); } cur = ''; };
    for (const p of paras) { if (cur && cur.length + p.length > CHUNK) flush(); cur += (cur ? '\n\n' : '') + p; while (cur.length > CHUNK * 1.5) { pieces.push({ id: r.id, title: r.title, text: cur.slice(0, CHUNK), order: order++, score: terms.reduce((n, t) => n + (cur.slice(0, CHUNK).toLowerCase().includes(t) ? 1 : 0), 0) }); cur = cur.slice(CHUNK); } }
    flush();
  }
  const pick = total <= WHOLE_IF_UNDER ? pieces : pieces.filter((p) => p.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
  const chosen: typeof pieces = []; let used = 0;
  for (const p of pick) { if (used + p.text.length > budget) continue; chosen.push(p); used += p.text.length; }
  chosen.sort((a, b) => a.order - b.order);
  const text = chosen.map((p) => `[${p.title}]\n${p.text}`).join('\n---\n');
  const seen = new Map<string, KnowledgeHit>();
  for (const p of chosen) { const h = seen.get(p.id) ?? { id: p.id, title: p.title, chars: 0 }; h.chars += p.text.length; seen.set(p.id, h); }
  return { text, used, hits: [...seen.values()], files };
}
