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
  exchange TEXT,                  -- venue: hyperliquid | aster | mexc
  leverage REAL NOT NULL,
  notional_usd REAL NOT NULL,
  size REAL NOT NULL,
  entry_price REAL NOT NULL,
  signal_entry REAL,
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
  archived INTEGER,              -- 1 once the user files a closed trade away
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

-- Second Opinion: independent, observe-only assessment per trading signal.
CREATE TABLE IF NOT EXISTS second_opinions (
  id TEXT PRIMARY KEY,
  signal_id TEXT,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  created_at TEXT NOT NULL,
  entry REAL,
  stop_loss REAL,
  take_profits TEXT,   -- JSON number[]
  ta TEXT,             -- JSON SecondOpinionTA
  verdict TEXT,        -- JSON SecondOpinionVerdict
  outcome TEXT         -- JSON SecondOpinionOutcome (filled in over time)
);
CREATE INDEX IF NOT EXISTS idx_secondop_group ON second_opinions(group_id);
CREATE INDEX IF NOT EXISTS idx_secondop_created ON second_opinions(created_at);

-- Chart images attached to incoming messages, keyed by their signal record.
CREATE TABLE IF NOT EXISTS message_images (
  signal_id TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
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
      archived: "INTEGER",
      banked_pnl: "REAL",
      banked_fees: "REAL",
      exchange: "TEXT",
      signal_entry: "REAL",
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

  // Hyperliquid was split into separate testnet/mainnet venues. Back-fill ONLY
  // genuinely legacy trades that predate the column (exchange IS NULL), using
  // their env as the best available hint. We must NEVER rewrite an already-set
  // venue tag: `env` is the DEFAULT trading network (TRADING_ENV), not the venue
  // the order actually executed on — a mainnet order placed while TRADING_ENV=
  // testnet is correctly tagged 'hyperliquid', and overwriting it to
  // 'hyperliquid-testnet' by env would strand the live position on the wrong
  // connector and false-close it. Only-NULL makes this naturally idempotent.
  try {
    const tRes = database
      .prepare("UPDATE trades SET exchange='hyperliquid-testnet' WHERE exchange IS NULL AND env='testnet'")
      .run();
    const mRes = database
      .prepare("UPDATE trades SET exchange='hyperliquid' WHERE exchange IS NULL AND env='mainnet'")
      .run();
    if (tRes.changes || mRes.changes) {
      log.info(`Migrated: back-filled venue on ${tRes.changes} testnet + ${mRes.changes} mainnet legacy (NULL) trades.`);
    }
  } catch (err) {
    log.warn("Trade venue relabel migration skipped:", err instanceof Error ? err.message : err);
  }

  // Working-limit TTL default raised from 7d (168h) to 14d (336h). One-time bump
  // of groups still carrying the OLD default so a deliberately customized value is
  // never overwritten; gated by a flag so re-setting 168 later in the desk stays
  // respected (the migration won't run again).
  try {
    const done = database
      .prepare("SELECT value FROM app_settings WHERE key='migration:limitTtl14d'")
      .get() as { value: string } | undefined;
    if (!done) {
      const rows = database.prepare("SELECT id, settings FROM groups").all() as { id: string; settings: string }[];
      const upd = database.prepare("UPDATE groups SET settings=? WHERE id=?");
      let changed = 0;
      for (const r of rows) {
        try {
          const s = JSON.parse(r.settings) as { limitTimeoutHours?: number };
          if (s && s.limitTimeoutHours === 168) {
            s.limitTimeoutHours = 336;
            upd.run(JSON.stringify(s), r.id);
            changed++;
          }
        } catch {
          /* skip a group with unparseable settings */
        }
      }
      database
        .prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('migration:limitTtl14d','1')")
        .run();
      if (changed) log.info(`Migrated: bumped working-limit TTL 168h→336h on ${changed} group(s).`);
    }
  } catch (err) {
    log.warn("limit-TTL migration skipped:", err instanceof Error ? err.message : err);
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
    // Strip the Anthropic key and every desk-stored exchange credential (ex:*).
    tmp.prepare("DELETE FROM app_settings WHERE key = 'anthropicKey' OR key LIKE 'ex:%'").run();
    // Drop attachment blobs (chart images / PDFs) — pure bloat in a backup that
    // exists to preserve config + trade history, and they can be multi-MB each.
    tmp.prepare("DELETE FROM message_images").run();
    tmp.exec("VACUUM");
    return tmp.serialize();
  } finally {
    tmp.close();
  }
}
