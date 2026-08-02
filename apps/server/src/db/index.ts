import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { log } from "../logger.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  telegram_channel TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  settings TEXT NOT NULL,        -- JSON GroupSettings
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  status TEXT NOT NULL,
  parsed TEXT,                   -- JSON ParsedSignal
  risk TEXT,                     -- JSON RiskRating
  error TEXT,
  trade_id TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_group ON signals(group_id);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  signal_id TEXT,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  status TEXT NOT NULL,
  env TEXT NOT NULL,
  leverage REAL NOT NULL,
  notional_usd REAL NOT NULL,
  size REAL NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL,
  stop_loss REAL,
  take_profits TEXT,             -- JSON number[]
  realized_pnl REAL,
  fees REAL,
  banked_pnl REAL,
  banked_fees REAL,
  exchange_order_id TEXT,
  sl_order_id TEXT,
  tp_order_ids TEXT,             -- JSON string[]
  bracket_protected INTEGER,
  tp_filled_count INTEGER,
  sl_moved_to_breakeven INTEGER,
  risk TEXT,                     -- JSON RiskRating
  shadow INTEGER,
  simulated INTEGER,
  error TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_group ON trades(group_id);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  meta TEXT,
  group_id TEXT,
  signal_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);
`;

function open(): Database.Database {
  const dir = path.dirname(config.dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const database = new Database(config.dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA);
  migrate(database);
  log.info(`SQLite ready at ${config.dbPath}`);
  return database;
}

/** Add columns introduced after the initial schema to pre-existing databases. */
function migrate(database: Database.Database): void {
  const additions: Record<string, Record<string, string>> = {
    trades: {
      bracket_protected: "INTEGER",
      sl_order_id: "TEXT",
      tp_order_ids: "TEXT",
      tp_filled_count: "INTEGER",
      sl_moved_to_breakeven: "INTEGER",
      risk: "TEXT",
      shadow: "INTEGER",
      simulated: "INTEGER",
      banked_pnl: "REAL",
      banked_fees: "REAL",
    },
    signals: {
      risk: "TEXT",
    },
  };
  for (const [table, cols] of Object.entries(additions)) {
    const existing = (
      database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).map((c) => c.name);
    for (const [name, type] of Object.entries(cols)) {
      if (!existing.includes(name)) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        log.info(`Migrated: added ${table}.${name}`);
      }
    }
  }
}

export const db: Database.Database = open();

/**
 * Serialize the database with secrets stripped, for the desk backup download.
 * Removes the desk-stored Anthropic key so a backup file never carries it.
 */
export function sanitizedBackup(): Buffer {
  const snapshot = db.serialize();
  const tmp = new Database(snapshot);
  try {
    tmp.prepare("DELETE FROM app_settings WHERE key = 'anthropicKey'").run();
    return tmp.serialize();
  } finally {
    tmp.close();
  }
}
