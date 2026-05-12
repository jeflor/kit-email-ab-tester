const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'kit-ab.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Lightweight migration: existing campaigns rows may lack subject_lineup.
function ensureColumn(table, col, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (rows.length && !rows.find(r => r.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${definition}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    audience_type TEXT NOT NULL,        -- 'tag' or 'segment'
    audience_id TEXT NOT NULL,
    audience_label TEXT,
    starting_subject TEXT NOT NULL,
    current_winner TEXT NOT NULL,
    subject_lineup TEXT NOT NULL DEFAULT '[]', -- JSON array; index 0 is starting subject, rest are challengers in order
    preview_text TEXT NOT NULL DEFAULT '',     -- preheader/inbox preview snippet; same for all variations
    email_html TEXT NOT NULL,
    batch_size INTEGER NOT NULL DEFAULT 1000,
    wait_seconds INTEGER NOT NULL DEFAULT 3600,
    status TEXT NOT NULL DEFAULT 'draft', -- draft | running | paused | done | error
    next_run_at INTEGER,                 -- unix ms; when the runner should next act
    next_action TEXT,                    -- 'send' or 'evaluate'
    current_round INTEGER NOT NULL DEFAULT 0,
    total_rounds INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    round_number INTEGER NOT NULL,
    winner_subject TEXT NOT NULL,
    challenger_subject TEXT NOT NULL,
    winner_broadcast_id TEXT,
    challenger_broadcast_id TEXT,
    winner_tag_id TEXT,
    challenger_tag_id TEXT,
    winner_opens INTEGER,
    winner_recipients INTEGER,
    challenger_opens INTEGER,
    challenger_recipients INTEGER,
    winner_rate REAL,
    challenger_rate REAL,
    outcome TEXT,                        -- 'winner_kept' | 'challenger_won'
    sent_at INTEGER,
    evaluated_at INTEGER,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  );

  CREATE INDEX IF NOT EXISTS idx_rounds_campaign ON rounds(campaign_id);
`);

ensureColumn('campaigns', 'subject_lineup', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('campaigns', 'preview_text', "TEXT NOT NULL DEFAULT ''");
ensureColumn('campaigns', 'audience_include_tags', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('campaigns', 'audience_exclude_tags', "TEXT NOT NULL DEFAULT '[]'");

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value == null ? null : String(value));
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

module.exports = { db, getSetting, setSetting, getAllSettings };
