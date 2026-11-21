import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { homedir } from 'os';

const DATA_DIR = join(homedir(), 'AppData', 'Roaming', 'aimax');
mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = join(DATA_DIR, 'aimax.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  applySchema(_db);
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
}
