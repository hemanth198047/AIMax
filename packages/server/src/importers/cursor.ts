/**
 * Cursor chats live in SQLite files under Cursor's user-data folder:
 *   User/globalStorage/state.vscdb  → table cursorDiskKV: 'composerData:<id>' (+ 'bubbleId:<id>:<bubble>' rows)
 *   User/workspaceStorage/<hash>/state.vscdb → table ItemTable: 'workbench.panel.aichat.view.aichat.chatdata' (older chat tabs)
 * The layout changes between Cursor versions and this reader is a best-effort one written WITHOUT access to real Cursor data.
 * Every scan reports what it found so a mismatch is visible, and nothing is ever written to Cursor's files (read-only).
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isoOrUndefined, normalize, type ImportedConversation, type ImportedMessage, type ScanItem } from './types.js';

export function defaultCursorDir(): string {
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'User');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Cursor', 'User');
}

const open = (p: string) => new Database(p, { readonly: true, fileMustExist: true });
function tableExists(db: Database.Database, t: string) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t); }
const parse = (v: unknown): any => { try { return JSON.parse(typeof v === 'string' ? v : Buffer.from(v as Buffer).toString('utf8')); } catch { return null; } };
const bubbleRole = (t: unknown): 'user' | 'assistant' | null => (t === 1 || t === 'user' || t === 'human') ? 'user' : (t === 2 || t === 'ai' || t === 'assistant' || t === 'bot') ? 'assistant' : null;
const bubbleText = (b: any): string => String(b?.text ?? b?.rawText ?? b?.content ?? b?.message ?? '').trim();

function workspaceFolders(dir: string): Map<string, string> {
  const m = new Map<string, string>(); const ws = join(dir, 'workspaceStorage');
  if (!existsSync(ws)) return m;
  for (const h of readdirSync(ws)) {
    try { const j = JSON.parse(readFileSync(join(ws, h, 'workspace.json'), 'utf8')); const f = String(j.folder ?? j.workspace ?? ''); if (f) m.set(h, decodeURIComponent(f.replace(/^file:\/\//, ''))); } catch { /* no workspace.json */ }
  }
  return m;
}

export function scanCursor(dir: string): { items: ScanItem[]; diagnostics: string[] } {
  const diagnostics: string[] = []; const items: ScanItem[] = [];
  const g = join(dir, 'globalStorage', 'state.vscdb');
  if (existsSync(g)) {
    try {
      const db = open(g);
      if (tableExists(db, 'cursorDiskKV')) {
        const rows = db.prepare("SELECT key,value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all() as { key: string; value: unknown }[];
        diagnostics.push(`globalStorage: ${rows.length} composerData row(s)`);
        for (const r of rows) {
          const d = parse(r.value); if (!d) continue;
          const n = Array.isArray(d.conversation) ? d.conversation.length : Array.isArray(d.fullConversationHeadersOnly) ? d.fullConversationHeadersOnly.length : 0;
          if (!n) continue;
          items.push({ id: `global:${r.key.slice('composerData:'.length)}`, title: String(d.name || d.title || 'Cursor chat').slice(0, 100), messages: n,
            updatedAt: isoOrUndefined(d.lastUpdatedAt) ?? isoOrUndefined(d.createdAt) ?? '', project: '', imported: false });
        }
      } else diagnostics.push('globalStorage: state.vscdb has no cursorDiskKV table (different Cursor version?)');
      db.close();
    } catch (e) { diagnostics.push(`globalStorage: could not read (${e instanceof Error ? e.message : e}). Close Cursor and retry if the file is locked.`); }
  } else diagnostics.push(`globalStorage/state.vscdb not found under ${dir}`);

  const folders = workspaceFolders(dir); const ws = join(dir, 'workspaceStorage');
  if (existsSync(ws)) for (const h of readdirSync(ws)) {
    const p = join(ws, h, 'state.vscdb'); if (!existsSync(p)) continue;
    try {
      const db = open(p);
      if (tableExists(db, 'ItemTable')) {
        const row = db.prepare("SELECT value FROM ItemTable WHERE key='workbench.panel.aichat.view.aichat.chatdata'").get() as { value: unknown } | undefined;
        const tabs = row ? parse(row.value)?.tabs : null;
        if (Array.isArray(tabs)) for (const t of tabs) {
          const n = Array.isArray(t.bubbles) ? t.bubbles.filter((b: any) => bubbleText(b)).length : 0;
          if (n) items.push({ id: `ws:${h}:${t.tabId}`, title: String(t.chatTitle || 'Cursor chat').slice(0, 100), messages: n, updatedAt: isoOrUndefined(t.lastSendTime) ?? isoOrUndefined(statSync(p).mtimeMs) ?? '', project: folders.get(h) ?? '', imported: false });
        }
      }
      db.close();
    } catch { /* locked or unexpected layout: skipped */ }
  }
  diagnostics.push(`${items.length} chat(s) with readable messages`);
  return { items, diagnostics };
}

export function loadCursor(dir: string, id: string): ImportedConversation {
  const msgs: ImportedMessage[] = []; let title = 'Cursor chat'; let createdAt: string | undefined; let updatedAt: string | undefined; let project = '';
  if (id.startsWith('global:')) {
    const cid = id.slice(7); if (!/^[0-9a-zA-Z-]{8,80}$/.test(cid)) throw new Error('Invalid chat id');
    const db = open(join(dir, 'globalStorage', 'state.vscdb'));
    try {
      const d = parse((db.prepare('SELECT value FROM cursorDiskKV WHERE key=?').get(`composerData:${cid}`) as { value: unknown } | undefined)?.value);
      if (!d) throw new Error('Chat not found');
      title = String(d.name || d.title || title); createdAt = isoOrUndefined(d.createdAt); updatedAt = isoOrUndefined(d.lastUpdatedAt);
      if (Array.isArray(d.conversation)) for (const b of d.conversation) { const r = bubbleRole(b.type); if (r) msgs.push({ role: r, content: bubbleText(b) }); }
      else for (const h of (d.fullConversationHeadersOnly ?? []) as { bubbleId: string; type: unknown }[]) {
        const b = parse((db.prepare('SELECT value FROM cursorDiskKV WHERE key=?').get(`bubbleId:${cid}:${h.bubbleId}`) as { value: unknown } | undefined)?.value);
        const r = bubbleRole(b?.type ?? h.type); if (r && b) msgs.push({ role: r, content: bubbleText(b) });
      }
    } finally { db.close(); }
  } else if (id.startsWith('ws:')) {
    const [, h, tabId] = id.split(':'); if (!/^[0-9a-f]{8,64}$/i.test(h ?? '')) throw new Error('Invalid chat id');
    const db = open(join(dir, 'workspaceStorage', h, 'state.vscdb'));
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key='workbench.panel.aichat.view.aichat.chatdata'").get() as { value: unknown } | undefined;
      const tab = (parse(row?.value)?.tabs as any[] | undefined)?.find(t => String(t.tabId) === tabId);
      if (!tab) throw new Error('Chat not found');
      title = String(tab.chatTitle || title); project = workspaceFolders(dir).get(h) ?? '';
      for (const b of tab.bubbles ?? []) { const r = bubbleRole(b.type); if (r) msgs.push({ role: r, content: bubbleText(b) }); }
    } finally { db.close(); }
  } else throw new Error('Unknown Cursor chat id');
  const { messages, truncated } = normalize(msgs);
  if (!messages.length) throw new Error('No readable messages in this chat');
  return { key: id, title: title.slice(0, 100), project, createdAt, updatedAt, messages, truncated };
}
