import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { log } from "../logger.js";
import { canonicalSymbol } from "../symbols.js";

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
  initial_size REAL,             -- size at entry, before partials (RI-3)
  initial_risk REAL,             -- |entry-stop| × initial_size, frozen at entry (RI-3)
  initial_risk_source TEXT,      -- 'recorded' | 'backfilled_estimate' (P1-R8)
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

-- Phase 2: point-in-time features per signal (Shadow-Mode basis, dev-brief §7).
-- One row per (signal, feature); computed at signal time and never recomputed with
-- later data (computed_at <= signal_at). num_value for numeric, text_value for
-- categorical. No model reads this yet — only bucket reports.
CREATE TABLE IF NOT EXISTS signal_features (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  num_value REAL,
  text_value TEXT,
  source TEXT NOT NULL,
  version TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  signal_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sigfeat_signal ON signal_features(signal_id);
CREATE INDEX IF NOT EXISTS idx_sigfeat_name ON signal_features(name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sigfeat_uniq ON signal_features(signal_id, name);
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
      initial_size: "REAL",
      initial_risk: "REAL",
      initial_risk_source: "TEXT",
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

  // RI-3: back-fill initial_size / initial_risk for rows that predate the columns
  // so historical R-multiples use the entry risk, not the post-partial size. Best
  // effort: current size is the closest proxy for the original for legacy rows.
  // Idempotent — only fills NULLs, so a value set at entry going forward is kept.
  try {
    const sizeRes = database
      .prepare("UPDATE trades SET initial_size = size WHERE initial_size IS NULL")
      .run();
    const riskRes = database
      .prepare(
        "UPDATE trades SET initial_risk = ABS(entry_price - stop_loss) * initial_size " +
          "WHERE initial_risk IS NULL AND stop_loss IS NOT NULL AND initial_size > 0",
      )
      .run();
    // P1-R8: everything the migration touched is an ESTIMATE (reconstructed from
    // the current size, not the true entry). New trades set 'recorded' at create().
    const srcRes = database
      .prepare("UPDATE trades SET initial_risk_source = 'backfilled_estimate' WHERE initial_risk_source IS NULL")
      .run();
    if (sizeRes.changes || riskRes.changes || srcRes.changes) {
      log.info(`Migrated: back-filled initial_size on ${sizeRes.changes}, initial_risk on ${riskRes.changes}, source on ${srcRes.changes} trade(s).`);
    }
  } catch (err) {
    log.warn("initial-risk migration skipped:", err instanceof Error ? err.message : err);
  }

  // Default directional venue split ON: route LONGs to the primary venue
  // (Hyperliquid) and SHORTs to the secondary (Aster) so an opposing same-coin
  // pair can never net onto one venue (#6/#7). ONE-TIME: only inserts when the
  // key was never set, so a later desk toggle-off is respected and this never
  // re-forces it on. Requires a live, funded secondary venue — otherwise a short
  // falls back to the primary and nets again.
  try {
    const row = database.prepare("SELECT value FROM app_settings WHERE key = 'directionalVenueSplit'").get();
    if (!row) {
      database
        .prepare("INSERT INTO app_settings (key, value) VALUES ('directionalVenueSplit', 'true')")
        .run();
      log.info("Migrated: directionalVenueSplit defaulted ON (longs→primary venue, shorts→secondary).");
    }
  } catch (err) {
    log.warn("directionalVenueSplit default migration skipped:", err instanceof Error ? err.message : err);
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

  // Correct realizedPnl mis-booked by the netted-position close bug: a close that
  // used the FULL netted exchange size (several traders' legs on one venue)
  // instead of the leg's own size booked another leg's loss against one record
  // (the ONDO incident — a Gauls close showed −371 when the real leg move was
  // ~−59). For a CLOSED, real (non-shadow/non-sim) trade the round-trip PnL is
  // deterministic from price×size, so recompute it and correct only where the
  // stored value diverges materially (the mis-booking signature). Flag-gated,
  // logged, and it leaves correctly-booked trades untouched.
  // Flag key is bumped (…v2) so this pass RE-RUNS: an earlier pass corrected the
  // ONDO legs but aborted before reaching later rows (a bad row threw and stopped
  // the whole sweep — e.g. the Aster ETH shorts stayed mis-booked). Now each row
  // is guarded on its own, and the sweep is idempotent (a corrected record already
  // matches its price×size, so it is never touched again).
  try {
    const done = database
      .prepare("SELECT value FROM app_settings WHERE key='migration:pnlNettedFix2'")
      .get() as { value: string } | undefined;
    if (!done) {
      const rows = database
        .prepare(
          `SELECT id, group_name, symbol, side, entry_price, exit_price, size, realized_pnl, banked_pnl, banked_fees
             FROM trades
            WHERE status='closed' AND COALESCE(shadow,0)=0 AND COALESCE(simulated,0)=0
              AND exit_price IS NOT NULL AND realized_pnl IS NOT NULL AND size > 0`,
        )
        .all() as {
        id: string; group_name: string; symbol: string; side: string;
        entry_price: number; exit_price: number; size: number;
        realized_pnl: number; banked_pnl: number | null; banked_fees: number | null;
      }[];
      const upd = database.prepare("UPDATE trades SET realized_pnl=?, fees=? WHERE id=?");
      let fixed = 0;
      for (const r of rows) {
        try {
          const dir = r.side === "long" ? 1 : -1;
          const gross = (r.exit_price - r.entry_price) * dir * r.size;
          const estFee = 0.0005 * (r.entry_price + r.exit_price) * r.size; // ~round-trip taker
          const correct = gross + (r.banked_pnl ?? 0) - (r.banked_fees ?? 0) - estFee;
          if (!Number.isFinite(correct) || !Number.isFinite(r.realized_pnl)) continue;
          const diff = Math.abs(r.realized_pnl - correct);
          // Correct only when the stored PnL diverges FAR beyond any plausible fee
          // (3× a generous 0.1%-of-notional fee, floor 12 USDC) AND the trade is
          // materially sized — the netting-bug signature. A correctly-booked trade
          // matches its own price×size within fee noise, so it is never touched.
          const feeGuard = Math.max(12, 0.003 * Math.abs(r.exit_price * r.size));
          if (diff > feeGuard && (Math.abs(r.realized_pnl) > 20 || Math.abs(correct) > 20)) {
            // fees column = ALL fees booked on the trade (banked partial-close
            // fees + this final leg's estimate), matching how it's written on the
            // normal close paths — not estFee alone, which dropped the banked part.
            const totalFees = (r.banked_fees ?? 0) + estFee;
            upd.run(Number(correct.toFixed(6)), Number(totalFees.toFixed(6)), r.id);
            log.warn(`Corrected mis-booked PnL: ${r.group_name} ${r.symbol} ${r.realized_pnl.toFixed(2)} → ${correct.toFixed(2)} USDC`);
            fixed++;
          }
        } catch (rowErr) {
          log.warn(`PnL correction skipped one row (${r.symbol}):`, rowErr instanceof Error ? rowErr.message : rowErr);
        }
      }
      database
        .prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('migration:pnlNettedFix2','1')")
        .run();
      if (fixed) log.info(`Migrated: corrected ${fixed} mis-booked trade PnL record(s) from the netted-close bug.`);
    }
  } catch (err) {
    log.warn("PnL correction migration skipped:", err instanceof Error ? err.message : err);
  }

  // Canonicalize metal tickers on existing trade records (XAU→GOLD, XAG→SILVER)
  // so they match the now-canonical symbols the connectors report — otherwise an
  // open Aster XAU (gold) position would fail to reconcile against a GOLD feed.
  // Naturally idempotent (no XAU rows remain after the first run).
  try {
    const rows = database.prepare("SELECT id, symbol FROM trades").all() as { id: string; symbol: string }[];
    const upd = database.prepare("UPDATE trades SET symbol=? WHERE id=?");
    let n = 0;
    for (const r of rows) {
      const c = canonicalSymbol(r.symbol);
      if (c !== (r.symbol ?? "").toUpperCase()) { upd.run(c, r.id); n++; }
    }
    if (n) log.info(`Migrated: canonicalized ${n} cross-venue ticker record(s) (e.g. XAU→GOLD, kSHIB→SHIB).`);
  } catch (err) {
    log.warn("ticker canonicalization skipped:", err instanceof Error ? err.message : err);
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
