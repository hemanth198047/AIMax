import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { homedir } from 'os';

export const DATA_DIR = process.env.AIMAX_DATA_DIR ?? join(homedir(), 'AppData', 'Roaming', 'aimax');
mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = join(DATA_DIR, 'aimax.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  applySchema(_db);
  migrate(_db);
  return _db;
}

function applySchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT DEFAULT 'software',
      status TEXT DEFAULT 'active',
      priority TEXT DEFAULT 'medium',
      tags TEXT DEFAULT '[]',
      repo_path TEXT DEFAULT '',
      tech_stack TEXT DEFAULT '[]',
      instructions TEXT DEFAULT '',
      provider TEXT DEFAULT 'auto',
      privacy TEXT DEFAULT 'local_only',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      preferred_name TEXT DEFAULT '',
      role TEXT DEFAULT '',
      organization TEXT DEFAULT '',
      relationship TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      privacy TEXT DEFAULT 'local_only',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS project_people (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'contributor',
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, person_id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT DEFAULT 'New Conversation',
      scope TEXT DEFAULT 'global',
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
      provider TEXT DEFAULT 'auto',
      model TEXT DEFAULT '',
      pinned INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments TEXT DEFAULT '[]',
      provider TEXT DEFAULT '',
      model TEXT DEFAULT '',
      tokens_used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);

    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'global',
      project_id TEXT,
      person_id TEXT,
      type TEXT NOT NULL DEFAULT 'note',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      provenance TEXT DEFAULT 'user_provided',
      confidence REAL DEFAULT 1.0,
      tags TEXT DEFAULT '[]',
      source_conversation_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      title, content, tags,
      content='memory_entries',
      content_rowid='rowid'
    );

    -- Keep the FTS index in sync automatically (manual inserts/deletes corrupted it)
    CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_fts(rowid,title,content,tags) VALUES (new.rowid,new.title,new.content,new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts,rowid,title,content,tags) VALUES('delete',old.rowid,old.title,old.content,old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts,rowid,title,content,tags) VALUES('delete',old.rowid,old.title,old.content,old.tags);
      INSERT INTO memory_fts(rowid,title,content,tags) VALUES (new.rowid,new.title,new.content,new.tags);
    END;

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'medium',
      due_date TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sandboxes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      mode TEXT DEFAULT 'temporary',
      working_dir TEXT DEFAULT '',
      status TEXT DEFAULT 'stopped',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_used TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mimetype TEXT DEFAULT '',
      size INTEGER DEFAULT 0,
      path TEXT NOT NULL,
      extracted_text TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Phase 13: Engineering Knowledge
    CREATE TABLE IF NOT EXISTS discoveries (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'feature',
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      location TEXT DEFAULT '',
      metadata TEXT DEFAULT '{}',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      rationale TEXT DEFAULT '',
      alternatives TEXT DEFAULT '[]',
      tradeoffs TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      supersedes TEXT REFERENCES decisions(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS solutions (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      problem TEXT NOT NULL,
      root_cause TEXT DEFAULT '',
      fix TEXT NOT NULL,
      files_changed TEXT DEFAULT '[]',
      test_evidence TEXT DEFAULT '',
      environment TEXT DEFAULT '{}',
      tags TEXT DEFAULT '[]',
      verified_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS failures (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      approach TEXT NOT NULL,
      reason TEXT NOT NULL,
      context TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Phase 25: DesignIQ
    CREATE TABLE IF NOT EXISTS design_entries (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'token',
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      notes TEXT DEFAULT '',
      approved INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS design_audits (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      url TEXT NOT NULL,
      score REAL DEFAULT 0,
      findings TEXT DEFAULT '[]',
      screenshot_path TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Repair any index corrupted by earlier versions
  db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
}

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === col);
}

/** Versioned migrations on top of the idempotent baseline schema (tracked with PRAGMA user_version). */
const MIGRATIONS: Array<(db: Database.Database) => void> = [
  // v1: real sandbox — source path, kind of workspace, direct-mode approval, run history
  (db) => {
    for (const [col, ddl] of [
      ['source_path', "TEXT DEFAULT ''"],
      ['workspace_kind', "TEXT DEFAULT 'dir'"],   // dir | worktree | copy | source
      ['approved_at', "TEXT DEFAULT NULL"],
      ['container_image', "TEXT DEFAULT ''"],
    ] as const) {
      if (!hasColumn(db, 'sandboxes', col)) db.exec(`ALTER TABLE sandboxes ADD COLUMN ${col} ${ddl}`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS sandbox_runs (
        id TEXT PRIMARY KEY,
        sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
        command TEXT NOT NULL,
        exit_code INTEGER,
        status TEXT DEFAULT 'running',      -- running | done | timeout | cancelled | error
        truncated INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        started_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_runs_sandbox ON sandbox_runs(sandbox_id);
    `);
  },
  // v2: provider session reuse (bound to the exact scope it was created in)
  (db) => {
    if (!hasColumn(db, 'conversations', 'claude_session_id')) db.exec("ALTER TABLE conversations ADD COLUMN claude_session_id TEXT DEFAULT NULL");
    if (!hasColumn(db, 'conversations', 'claude_session_scope')) db.exec("ALTER TABLE conversations ADD COLUMN claude_session_scope TEXT DEFAULT NULL");
  },
  // v3: settings + local usage ledger (requests/characters per provider; never claims to know a provider's real quota)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT DEFAULT '',
        conversation_id TEXT,
        project_id TEXT,
        input_chars INTEGER DEFAULT 0,
        output_chars INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        ok INTEGER DEFAULT 1,
        error TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_usage_provider_ts ON usage_events(provider, ts);
    `);
  },
  // v4: agent mode — base commit for diff/promote, promotion history (with the patch, so it can be undone), agent runs
  (db) => {
    if (!hasColumn(db, 'sandboxes', 'base_sha')) db.exec("ALTER TABLE sandboxes ADD COLUMN base_sha TEXT DEFAULT ''");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sandbox_promotions (
        id TEXT PRIMARY KEY,
        sandbox_id TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        files TEXT NOT NULL DEFAULT '[]',
        patch TEXT NOT NULL,
        undone_at TEXT DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_promo_sandbox ON sandbox_promotions(sandbox_id);
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        sandbox_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT DEFAULT 'running',     -- running | done | error | cancelled
        checkpoint_before TEXT DEFAULT '',
        summary TEXT DEFAULT '',
        files TEXT DEFAULT '[]',
        error TEXT DEFAULT '',
        started_at TEXT NOT NULL,
        finished_at TEXT DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_sandbox ON agent_runs(sandbox_id);
    `);
  },
  // v5: imported conversations (from Claude Code / Cursor / exported files) — de-duplicated by source key
  (db) => {
    if (!hasColumn(db, 'conversations', 'import_source')) db.exec("ALTER TABLE conversations ADD COLUMN import_source TEXT DEFAULT NULL");
    if (!hasColumn(db, 'conversations', 'import_key')) db.exec("ALTER TABLE conversations ADD COLUMN import_key TEXT DEFAULT NULL");
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_import_key ON conversations(import_key) WHERE import_key IS NOT NULL');
  },
  // v6: token numbers REPORTED by a provider CLI when it gives them (otherwise AImax only estimates from characters)
  (db) => {
    db.exec(`
      ALTER TABLE usage_events ADD COLUMN reported_in INTEGER;
      ALTER TABLE usage_events ADD COLUMN reported_out INTEGER;
      ALTER TABLE usage_events ADD COLUMN reported_cache_read INTEGER;
      ALTER TABLE usage_events ADD COLUMN reported_cost REAL;
    `);
  },
  // v7: project knowledge (files, notes and pages added to a project; text only, used in that project's chats)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_knowledge (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'file',
        title TEXT NOT NULL,
        source TEXT DEFAULT '',
        mimetype TEXT DEFAULT '',
        size INTEGER DEFAULT 0,
        text TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_pk_project ON project_knowledge(project_id);
    `);
  },
];

function migrate(db: Database.Database) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => { MIGRATIONS[v](db); db.pragma(`user_version = ${v + 1}`); })();
  }
}
