import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';

// Phase 27: Link Vault integration — read-only sync
const LINKVAULT_DB = process.env.AIMAX_LINKVAULT_DB || (process.platform === 'win32' ? 'D:\\ProjectsPortfolio\\LinkVault\\linkvault.db' : join('D:', 'ProjectsPortfolio', 'LinkVault', 'linkvault.db'));

interface LinkVaultRow {
  id: number;
  url: string;
  platform: string;
  saved_at: string;
  note: string;
  title: string;
  description: string;
  summary: string;
  category: string;
  tags: string;
  status: string;
  transcript: string;
  analysis_source: string;
  analyzed_at: string;
  times_saved: number;
}

function getLinkVaultDb(): Database.Database | null {
  if (!existsSync(LINKVAULT_DB)) return null;
  try {
    return new Database(LINKVAULT_DB, { readonly: true });
  } catch {
    return null;
  }
}

export const linkVaultPath = () => LINKVAULT_DB;
export async function linkVaultRoutes(app: FastifyInstance) {
  app.get('/api/linkvault/status', async () => {
    const available = existsSync(LINKVAULT_DB);
    if (!available) return { available: false, path: LINKVAULT_DB };
    const db = getLinkVaultDb();
    if (!db) return { available: false, path: LINKVAULT_DB };
    try {
      const count = (db.prepare('SELECT COUNT(*) as n FROM links').get() as { n: number }).n;
      return { available: true, path: LINKVAULT_DB, total_links: count };
    } catch (e) { return { available: false, path: LINKVAULT_DB, error: `Found the file but cannot read a "links" table: ${e instanceof Error ? e.message : String(e)}` }; }
    finally { db.close(); }
  });

  app.get('/api/linkvault/links', async (req) => {
    const { q = '', category = '', platform = '', page = '1', limit = '25' } = req.query as Record<string, string>;
    const db = getLinkVaultDb();
    if (!db) return { total: 0, items: [] };

    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where: string[] = [];
    const args: unknown[] = [];

    if (q) {
      where.push('(url LIKE ? OR title LIKE ? OR summary LIKE ? OR note LIKE ? OR transcript LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (category) { where.push('category=?'); args.push(category); }
    if (platform) { where.push('platform=?'); args.push(platform); }

    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = (db.prepare(`SELECT COUNT(*) as n FROM links${clause}`).get(...args) as { n: number }).n;
    const items = db.prepare(`SELECT * FROM links${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, parseInt(limit), offset) as LinkVaultRow[];

    db.close();
    return { total, items };
  });

  // AI-relevant content (MCP servers, repos, skills, tools)
  app.get('/api/linkvault/ai-content', async (req) => {
    const { limit = '50' } = req.query as Record<string, string>;
    const db = getLinkVaultDb();
    if (!db) return { items: [] };

    const AI_PATTERNS = [
      'github.com', 'mcp', 'agent', 'llm', 'claude', 'gpt', 'ollama',
      'langchain', 'rag', 'embedding', 'prompt', 'skill', 'ai tool',
      'openai', 'anthropic', 'huggingface', 'model', 'inference'
    ];

    const conditions = AI_PATTERNS.map(() => '(url LIKE ? OR title LIKE ? OR summary LIKE ? OR note LIKE ?)').join(' OR ');
    const args: string[] = AI_PATTERNS.flatMap(p => [`%${p}%`, `%${p}%`, `%${p}%`, `%${p}%`]);
    args.push(String(parseInt(limit)));

    const items = db.prepare(`
      SELECT id, url, platform, title, summary, note, category, tags, status, analysis_source
      FROM links WHERE ${conditions} ORDER BY id DESC LIMIT ?
    `).all(...args) as LinkVaultRow[];

    db.close();

    // Classify each item
    return {
      items: items.map(item => ({
        ...item,
        ai_classification: classifyAiContent(item)
      }))
    };
  });

  app.get('/api/linkvault/stats', async () => {
    const db = getLinkVaultDb();
    if (!db) return null;
    const total = (db.prepare('SELECT COUNT(*) as n FROM links').get() as { n: number }).n;
    const platforms = db.prepare('SELECT platform, COUNT(*) as count FROM links GROUP BY platform ORDER BY count DESC').all();
    const categories = db.prepare('SELECT category, COUNT(*) as count FROM links GROUP BY category ORDER BY count DESC').all();
    const statuses = db.prepare('SELECT status, COUNT(*) as count FROM links GROUP BY status ORDER BY count DESC').all();
    db.close();
    return { total, platforms, categories, statuses };
  });
}

function classifyAiContent(item: LinkVaultRow): string {
  const text = [item.url, item.title, item.summary, item.note].join(' ').toLowerCase();
  if (text.includes('github.com')) return 'github-repository';
  if (text.includes('mcp') || text.includes('model context protocol')) return 'mcp-server';
  if (text.includes('agent') && (text.includes('ai') || text.includes('llm'))) return 'ai-agent';
  if (text.includes('rag') || text.includes('retrieval')) return 'rag-technique';
  if (text.includes('prompt') && text.includes('engineer')) return 'prompt-engineering';
  if (text.includes('ollama') || text.includes('local') && text.includes('model')) return 'local-model';
  if (text.includes('skill') || text.includes('tool')) return 'ai-tool';
  return 'ai-general';
}
