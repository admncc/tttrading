import { nanoid } from "nanoid";
import type {
  Group,
  GroupInput,
  GroupSettings,
  LogEntry,
  ParsedSignal,
  RiskRating,
  Signal,
  SignalStatus,
  Trade,
  TradeStatus,
} from "@tttrading/shared";
import { db } from "./index.js";

const now = () => new Date().toISOString();

/* ----------------------------- row mappers ----------------------------- */

interface GroupRow {
  id: string;
  name: string;
  telegram_channel: string;
  enabled: number;
  settings: string;
  created_at: string;
  updated_at: string;
}

function toGroup(r: GroupRow): Group {
  return {
    id: r.id,
    name: r.name,
    telegramChannel: r.telegram_channel,
    enabled: !!r.enabled,
    settings: JSON.parse(r.settings) as GroupSettings,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface SignalRow {
  id: string;
  group_id: string;
  group_name: string;
  raw_text: string;
  status: string;
  parsed: string | null;
  risk: string | null;
  error: string | null;
  trade_id: string | null;
  received_at: string;
  updated_at: string;
}

function toSignal(r: SignalRow): Signal {
  return {
    id: r.id,
    groupId: r.group_id,
    groupName: r.group_name,
    rawText: r.raw_text,
    status: r.status as SignalStatus,
    parsed: r.parsed ? (JSON.parse(r.parsed) as ParsedSignal) : undefined,
    risk: r.risk ? (JSON.parse(r.risk) as RiskRating) : undefined,
    error: r.error ?? undefined,
    tradeId: r.trade_id ?? undefined,
    receivedAt: r.received_at,
    updatedAt: r.updated_at,
  };
}

interface TradeRow {
  id: string;
  signal_id: string | null;
  group_id: string;
  group_name: string;
  symbol: string;
  side: string;
  status: string;
  env: string;
  exchange: string | null;
  leverage: number;
  notional_usd: number;
  size: number;
  entry_price: number;
  signal_entry: number | null;
  exit_price: number | null;
  stop_loss: number | null;
  take_profits: string | null;
  realized_pnl: number | null;
  fees: number | null;
  banked_pnl: number | null;
  banked_fees: number | null;
  exchange_order_id: string | null;
  sl_order_id: string | null;
  tp_order_ids: string | null;
  bracket_protected: number | null;
  tp_filled_count: number | null;
  sl_moved_to_breakeven: number | null;
  risk: string | null;
  shadow: number | null;
  simulated: number | null;
  error: string | null;
  opened_at: string;
  closed_at: string | null;
}

function toTrade(r: TradeRow): Trade {
  return {
    id: r.id,
    signalId: r.signal_id ?? undefined,
    groupId: r.group_id,
    groupName: r.group_name,
    symbol: r.symbol,
    side: r.side as Trade["side"],
    status: r.status as TradeStatus,
    env: r.env as Trade["env"],
    exchange: (r.exchange as Trade["exchange"]) ?? undefined,
    leverage: r.leverage,
    notionalUsd: r.notional_usd,
    size: r.size,
    entryPrice: r.entry_price,
    signalEntry: r.signal_entry ?? undefined,
    exitPrice: r.exit_price ?? undefined,
    stopLoss: r.stop_loss ?? undefined,
    takeProfits: r.take_profits ? (JSON.parse(r.take_profits) as number[]) : undefined,
    realizedPnl: r.realized_pnl ?? undefined,
    fees: r.fees ?? undefined,
    bankedPnl: r.banked_pnl ?? undefined,
    bankedFees: r.banked_fees ?? undefined,
    exchangeOrderId: r.exchange_order_id ?? undefined,
    slOrderId: r.sl_order_id ?? undefined,
    tpOrderIds: r.tp_order_ids ? (JSON.parse(r.tp_order_ids) as string[]) : undefined,
    bracketProtected: r.bracket_protected === null ? undefined : !!r.bracket_protected,
    tpFilledCount: r.tp_filled_count ?? undefined,
    slMovedToBreakeven:
      r.sl_moved_to_breakeven === null ? undefined : !!r.sl_moved_to_breakeven,
    risk: r.risk ? (JSON.parse(r.risk) as RiskRating) : undefined,
    shadow: r.shadow === null ? undefined : !!r.shadow,
    simulated: r.simulated === null ? undefined : !!r.simulated,
    error: r.error ?? undefined,
    openedAt: r.opened_at,
    closedAt: r.closed_at ?? undefined,
  };
}

/* ------------------------------- groups -------------------------------- */

export const groups = {
  list(): Group[] {
    const rows = db.prepare("SELECT * FROM groups ORDER BY name").all() as GroupRow[];
    return rows.map(toGroup);
  },
  get(id: string): Group | undefined {
    const row = db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;
    return row ? toGroup(row) : undefined;
  },
  getByChannel(channel: string): Group | undefined {
    const row = db
      .prepare("SELECT * FROM groups WHERE telegram_channel = ?")
      .get(channel) as GroupRow | undefined;
    return row ? toGroup(row) : undefined;
  },
  create(input: GroupInput): Group {
    const ts = now();
    const group: Group = { id: nanoid(), ...input, createdAt: ts, updatedAt: ts };
    db.prepare(
      `INSERT INTO groups (id, name, telegram_channel, enabled, settings, created_at, updated_at)
       VALUES (@id, @name, @telegram_channel, @enabled, @settings, @created_at, @updated_at)`,
    ).run({
      id: group.id,
      name: group.name,
      telegram_channel: group.telegramChannel,
      enabled: group.enabled ? 1 : 0,
      settings: JSON.stringify(group.settings),
      created_at: ts,
      updated_at: ts,
    });
    return group;
  },
  update(id: string, input: GroupInput): Group | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const ts = now();
    db.prepare(
      `UPDATE groups SET name=@name, telegram_channel=@telegram_channel,
        enabled=@enabled, settings=@settings, updated_at=@updated_at WHERE id=@id`,
    ).run({
      id,
      name: input.name,
      telegram_channel: input.telegramChannel,
      enabled: input.enabled ? 1 : 0,
      settings: JSON.stringify(input.settings),
      updated_at: ts,
    });
    return this.get(id);
  },
  remove(id: string): void {
    db.prepare("DELETE FROM groups WHERE id = ?").run(id);
  },
  count(): number {
    const r = db.prepare("SELECT COUNT(*) AS c FROM groups").get() as { c: number };
    return r.c;
  },
};

/* ------------------------------- signals ------------------------------- */

export interface NewSignal {
  groupId: string;
  groupName: string;
  rawText: string;
  status: SignalStatus;
  parsed?: ParsedSignal;
  risk?: RiskRating;
  error?: string;
  /** Override the timestamp (e.g. original date for backfilled messages). */
  receivedAt?: string;
}

export const signals = {
  list(limit = 200): Signal[] {
    const rows = db
      .prepare("SELECT * FROM signals ORDER BY received_at DESC LIMIT ?")
      .all(limit) as SignalRow[];
    return rows.map(toSignal);
  },
  pending(): Signal[] {
    const rows = db
      .prepare("SELECT * FROM signals WHERE status = 'pending' ORDER BY received_at DESC")
      .all() as SignalRow[];
    return rows.map(toSignal);
  },
  /** All signals for a group, oldest first (for export/analysis). */
  forGroup(groupId: string): Signal[] {
    const rows = db
      .prepare("SELECT * FROM signals WHERE group_id = ? ORDER BY received_at ASC")
      .all(groupId) as SignalRow[];
    return rows.map(toSignal);
  },
  /** True if a signal with the same group, timestamp and text already exists. */
  existsSimilar(groupId: string, receivedAt: string, rawText: string): boolean {
    const row = db
      .prepare(
        "SELECT 1 FROM signals WHERE group_id = ? AND received_at = ? AND raw_text = ? LIMIT 1",
      )
      .get(groupId, receivedAt, rawText);
    return !!row;
  },
  get(id: string): Signal | undefined {
    const row = db.prepare("SELECT * FROM signals WHERE id = ?").get(id) as SignalRow | undefined;
    return row ? toSignal(row) : undefined;
  },
  create(input: NewSignal): Signal {
    const ts = input.receivedAt ?? now();
    const id = nanoid();
    db.prepare(
      `INSERT INTO signals (id, group_id, group_name, raw_text, status, parsed, risk, error, received_at, updated_at)
       VALUES (@id, @group_id, @group_name, @raw_text, @status, @parsed, @risk, @error, @received_at, @updated_at)`,
    ).run({
      id,
      group_id: input.groupId,
      group_name: input.groupName,
      raw_text: input.rawText,
      status: input.status,
      parsed: input.parsed ? JSON.stringify(input.parsed) : null,
      risk: input.risk ? JSON.stringify(input.risk) : null,
      error: input.error ?? null,
      received_at: ts,
      updated_at: ts,
    });
    return this.get(id)!;
  },
  update(
    id: string,
    patch: Partial<Pick<Signal, "status" | "error" | "tradeId" | "parsed" | "risk">>,
  ): Signal | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...patch };
    db.prepare(
      `UPDATE signals SET status=@status, error=@error, trade_id=@trade_id,
        parsed=@parsed, risk=@risk, updated_at=@updated_at WHERE id=@id`,
    ).run({
      id,
      status: merged.status,
      error: merged.error ?? null,
      trade_id: merged.tradeId ?? null,
      parsed: merged.parsed ? JSON.stringify(merged.parsed) : null,
      risk: merged.risk ? JSON.stringify(merged.risk) : null,
      updated_at: now(),
    });
    return this.get(id);
  },
};

/* -------------------------------- trades ------------------------------- */

export type NewTrade = Omit<Trade, "id" | "openedAt"> & {
  openedAt?: string;
};

export const trades = {
  list(limit = 500): Trade[] {
    const rows = db
      .prepare("SELECT * FROM trades ORDER BY opened_at DESC LIMIT ?")
      .all(limit) as TradeRow[];
    return rows.map(toTrade);
  },
  open(): Trade[] {
    const rows = db
      .prepare("SELECT * FROM trades WHERE status = 'open' ORDER BY opened_at DESC")
      .all() as TradeRow[];
    return rows.map(toTrade);
  },
  /** Resting limit entry orders (status='working'), newest first. */
  working(): Trade[] {
    const rows = db
      .prepare("SELECT * FROM trades WHERE status = 'working' ORDER BY opened_at DESC")
      .all() as TradeRow[];
    return rows.map(toTrade);
  },
  /** Open positions + working orders (for exposure/limit checks). */
  activeAndWorking(): Trade[] {
    const rows = db
      .prepare("SELECT * FROM trades WHERE status IN ('open','working') ORDER BY opened_at DESC")
      .all() as TradeRow[];
    return rows.map(toTrade);
  },
  forGroup(groupId: string): Trade[] {
    const rows = db
      .prepare("SELECT * FROM trades WHERE group_id = ? ORDER BY opened_at DESC")
      .all(groupId) as TradeRow[];
    return rows.map(toTrade);
  },
  get(id: string): Trade | undefined {
    const row = db.prepare("SELECT * FROM trades WHERE id = ?").get(id) as TradeRow | undefined;
    return row ? toTrade(row) : undefined;
  },
  create(input: NewTrade): Trade {
    const id = nanoid();
    const openedAt = input.openedAt ?? now();
    db.prepare(
      `INSERT INTO trades (id, signal_id, group_id, group_name, symbol, side, status, env, exchange,
        leverage, notional_usd, size, entry_price, signal_entry, exit_price, stop_loss, take_profits,
        realized_pnl, fees, banked_pnl, banked_fees, exchange_order_id, sl_order_id, tp_order_ids, bracket_protected,
        tp_filled_count, sl_moved_to_breakeven, risk, shadow, simulated, error, opened_at, closed_at)
       VALUES (@id, @signal_id, @group_id, @group_name, @symbol, @side, @status, @env, @exchange,
        @leverage, @notional_usd, @size, @entry_price, @signal_entry, @exit_price, @stop_loss, @take_profits,
        @realized_pnl, @fees, @banked_pnl, @banked_fees, @exchange_order_id, @sl_order_id, @tp_order_ids, @bracket_protected,
        @tp_filled_count, @sl_moved_to_breakeven, @risk, @shadow, @simulated, @error, @opened_at, @closed_at)`,
    ).run({
      id,
      signal_id: input.signalId ?? null,
      group_id: input.groupId,
      group_name: input.groupName,
      symbol: input.symbol,
      side: input.side,
      status: input.status,
      env: input.env,
      exchange: input.exchange ?? null,
      leverage: input.leverage,
      notional_usd: input.notionalUsd,
      size: input.size,
      entry_price: input.entryPrice,
      signal_entry: input.signalEntry ?? null,
      exit_price: input.exitPrice ?? null,
      stop_loss: input.stopLoss ?? null,
      take_profits: input.takeProfits ? JSON.stringify(input.takeProfits) : null,
      realized_pnl: input.realizedPnl ?? null,
      fees: input.fees ?? null,
      banked_pnl: input.bankedPnl ?? null,
      banked_fees: input.bankedFees ?? null,
      exchange_order_id: input.exchangeOrderId ?? null,
      sl_order_id: input.slOrderId ?? null,
      tp_order_ids: input.tpOrderIds ? JSON.stringify(input.tpOrderIds) : null,
      bracket_protected: input.bracketProtected === undefined ? null : input.bracketProtected ? 1 : 0,
      tp_filled_count: input.tpFilledCount ?? null,
      sl_moved_to_breakeven:
        input.slMovedToBreakeven === undefined ? null : input.slMovedToBreakeven ? 1 : 0,
      risk: input.risk ? JSON.stringify(input.risk) : null,
      shadow: input.shadow === undefined ? null : input.shadow ? 1 : 0,
      simulated: input.simulated === undefined ? null : input.simulated ? 1 : 0,
      error: input.error ?? null,
      opened_at: openedAt,
      closed_at: input.closedAt ?? null,
    });
    return this.get(id)!;
  },
  update(id: string, patch: Partial<Trade>): Trade | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const m = { ...existing, ...patch };
    db.prepare(
      `UPDATE trades SET status=@status, exit_price=@exit_price, stop_loss=@stop_loss,
        take_profits=@take_profits, realized_pnl=@realized_pnl, size=@size,
        fees=@fees, banked_pnl=@banked_pnl, banked_fees=@banked_fees,
        exchange_order_id=@exchange_order_id, sl_order_id=@sl_order_id,
        tp_order_ids=@tp_order_ids, bracket_protected=@bracket_protected,
        tp_filled_count=@tp_filled_count, sl_moved_to_breakeven=@sl_moved_to_breakeven,
        risk=@risk, shadow=@shadow, simulated=@simulated, error=@error, closed_at=@closed_at
       WHERE id=@id`,
    ).run({
      id,
      status: m.status,
      exit_price: m.exitPrice ?? null,
      stop_loss: m.stopLoss ?? null,
      take_profits: m.takeProfits ? JSON.stringify(m.takeProfits) : null,
      realized_pnl: m.realizedPnl ?? null,
      size: m.size,
      fees: m.fees ?? null,
      banked_pnl: m.bankedPnl ?? null,
      banked_fees: m.bankedFees ?? null,
      exchange_order_id: m.exchangeOrderId ?? null,
      sl_order_id: m.slOrderId ?? null,
      tp_order_ids: m.tpOrderIds ? JSON.stringify(m.tpOrderIds) : null,
      bracket_protected: m.bracketProtected === undefined ? null : m.bracketProtected ? 1 : 0,
      tp_filled_count: m.tpFilledCount ?? null,
      sl_moved_to_breakeven:
        m.slMovedToBreakeven === undefined ? null : m.slMovedToBreakeven ? 1 : 0,
      risk: m.risk ? JSON.stringify(m.risk) : null,
      shadow: m.shadow === undefined ? null : m.shadow ? 1 : 0,
      simulated: m.simulated === undefined ? null : m.simulated ? 1 : 0,
      error: m.error ?? null,
      closed_at: m.closedAt ?? null,
    });
    return this.get(id);
  },
  count(): number {
    const r = db.prepare("SELECT COUNT(*) AS c FROM trades").get() as { c: number };
    return r.c;
  },
};

/* -------------------------------- logs --------------------------------- */

interface LogRow {
  id: string;
  ts: string;
  level: string;
  category: string;
  message: string;
  meta: string | null;
  group_id: string | null;
  signal_id: string | null;
}

function toLog(r: LogRow): LogEntry {
  return {
    id: r.id,
    ts: r.ts,
    level: r.level as LogEntry["level"],
    category: r.category,
    message: r.message,
    meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : undefined,
    groupId: r.group_id ?? undefined,
    signalId: r.signal_id ?? undefined,
  };
}

const LOG_CAP = 5000;
let logInserts = 0;

export const logs = {
  create(entry: LogEntry): void {
    db.prepare(
      `INSERT INTO logs (id, ts, level, category, message, meta, group_id, signal_id)
       VALUES (@id, @ts, @level, @category, @message, @meta, @group_id, @signal_id)`,
    ).run({
      id: entry.id,
      ts: entry.ts,
      level: entry.level,
      category: entry.category,
      message: entry.message,
      meta: entry.meta ? JSON.stringify(entry.meta) : null,
      group_id: entry.groupId ?? null,
      signal_id: entry.signalId ?? null,
    });
    // Periodically trim to the most recent LOG_CAP rows.
    if (++logInserts % 200 === 0) {
      db.prepare(
        `DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY ts DESC LIMIT ?)`,
      ).run(LOG_CAP);
    }
  },
  list(limit = 300, category?: string): LogEntry[] {
    const rows = category
      ? (db
          .prepare("SELECT * FROM logs WHERE category = ? ORDER BY ts DESC LIMIT ?")
          .all(category, limit) as LogRow[])
      : (db.prepare("SELECT * FROM logs ORDER BY ts DESC LIMIT ?").all(limit) as LogRow[]);
    return rows.map(toLog);
  },
  clear(): void {
    db.prepare("DELETE FROM logs").run();
  },
};

/* ---------------------------- global settings -------------------------- */

function kvGet(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function kvSet(key: string, value: string): void {
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export const settings = {
  /** Master test switch. Defaults to ON (safe) until explicitly disabled. */
  getShadowMode(): boolean {
    const v = kvGet("shadowMode");
    return v === undefined ? true : v === "true";
  },
  setShadowMode(on: boolean): void {
    kvSet("shadowMode", on ? "true" : "false");
  },
  /** Kill-switch: block new entries while existing trades keep running. */
  getTradingPaused(): boolean {
    return kvGet("tradingPaused") === "true";
  },
  setTradingPaused(on: boolean): void {
    kvSet("tradingPaused", on ? "true" : "false");
  },
  getRiskLimit(key: "dailyLossLimitUsd" | "maxOpenTrades" | "maxExposureUsd"): number {
    const v = Number(kvGet(key));
    return Number.isFinite(v) && v > 0 ? v : 0;
  },
  setRiskLimit(key: "dailyLossLimitUsd" | "maxOpenTrades" | "maxExposureUsd", value: number): void {
    kvSet(key, String(Number.isFinite(value) && value > 0 ? value : 0));
  },
  /** Route an opposing signal to a backup venue instead of netting. Default on. */
  getSplitOpposingVenues(): boolean {
    const v = kvGet("splitOpposingVenues");
    return v === undefined ? true : v === "true";
  },
  setSplitOpposingVenues(on: boolean): void {
    kvSet("splitOpposingVenues", on ? "true" : "false");
  },
  getGlobalSettings(): import("@tttrading/shared").GlobalSettings {
    return {
      shadowMode: this.getShadowMode(),
      tradingPaused: this.getTradingPaused(),
      dailyLossLimitUsd: this.getRiskLimit("dailyLossLimitUsd"),
      maxOpenTrades: this.getRiskLimit("maxOpenTrades"),
      maxExposureUsd: this.getRiskLimit("maxExposureUsd"),
      splitOpposingVenues: this.getSplitOpposingVenues(),
    };
  },
  /** Anthropic API key set via the desk (empty string => not set). */
  getAnthropicKey(): string {
    return kvGet("anthropicKey") ?? "";
  },
  setAnthropicKey(key: string): void {
    kvSet("anthropicKey", key);
  },
  getAnthropicModel(): string {
    return kvGet("anthropicModel") ?? "";
  },
  setAnthropicModel(model: string): void {
    kvSet("anthropicModel", model);
  },
  /**
   * Claim a Telegram message id for a group so it is processed exactly once,
   * no matter whether it arrives via the live event stream or the catch-up
   * poller. Returns true if this id was NOT seen before (caller should process
   * it), false if it was already handled. Tracks per-message ids (not just a
   * high-water mark) so a missed message in a gap is still caught later.
   */
  claimTelegramMessage(groupId: string, msgId: number): boolean {
    const key = `seenMsgs:${groupId}`;
    const raw = kvGet(key);
    const arr: number[] = raw ? (JSON.parse(raw) as number[]) : [];
    if (arr.includes(msgId)) return false;
    arr.push(msgId);
    // Keep the HIGHEST 2000 ids (paging appends newest-first, so trim by id, not
    // by insertion order, or a big gap-recovery could evict newer ids).
    const trimmed =
      arr.length > 2000 ? [...new Set(arr)].sort((a, b) => a - b).slice(-2000) : arr;
    kvSet(key, JSON.stringify(trimmed));
    return true;
  },
  /** Create the seen-set (empty) so a group counts as primed even with 0 msgs. */
  ensureTelegramSeen(groupId: string): void {
    const key = `seenMsgs:${groupId}`;
    if (kvGet(key) === undefined) kvSet(key, "[]");
  },
  /** Mark a message id as already seen without processing (startup priming). */
  markTelegramMessageSeen(groupId: string, msgId: number): void {
    this.claimTelegramMessage(groupId, msgId);
  },
  /** Whether a group has ever been primed (has a seen-set). */
  hasTelegramSeen(groupId: string): boolean {
    return kvGet(`seenMsgs:${groupId}`) !== undefined;
  },
  /** Release a claimed id so a transiently-failed message can be retried. */
  unclaimTelegramMessage(groupId: string, msgId: number): void {
    const key = `seenMsgs:${groupId}`;
    const raw = kvGet(key);
    if (!raw) return;
    const arr = (JSON.parse(raw) as number[]).filter((x) => x !== msgId);
    kvSet(key, JSON.stringify(arr));
  },
  /** Last date (YYYY-MM-DD, UTC) a given report kind was sent; "" if never. */
  getLastReport(kind: string): string {
    return kvGet(`lastReport:${kind}`) ?? "";
  },
  setLastReport(kind: string, date: string): void {
    kvSet(`lastReport:${kind}`, date);
  },
  /** Whether AI auto-refinement of channel instructions is enabled (desk toggle). */
  getAutoRefine(defaultOn: boolean): boolean {
    const v = kvGet("autoRefine");
    return v === undefined ? defaultOn : v === "true";
  },
  setAutoRefine(on: boolean): void {
    kvSet("autoRefine", on ? "true" : "false");
  },
  /** ISO timestamp a channel's instructions were last auto-refined; "" if never. */
  getLastRefine(groupId: string): string {
    return kvGet(`lastRefine:${groupId}`) ?? "";
  },
  setLastRefine(groupId: string, iso: string): void {
    kvSet(`lastRefine:${groupId}`, iso);
  },

  /* ---- desk-stored exchange credentials (write-only; env is the fallback) ---- */
  /** A desk-entered exchange value ("" when unset — callers fall back to env). */
  getExchangeValue(key: string): string {
    return kvGet(`ex:${key}`) ?? "";
  },
  setExchangeValue(key: string, value: string): void {
    kvSet(`ex:${key}`, value);
  },
  /** True if a non-empty desk value is stored for this key. */
  hasExchangeValue(key: string): boolean {
    return !!kvGet(`ex:${key}`);
  },
  /** A desk-entered boolean flag, or undefined when the desk hasn't set it. */
  getExchangeFlag(key: string): boolean | undefined {
    const v = kvGet(`ex:${key}`);
    return v === undefined ? undefined : v === "true";
  },
  setExchangeFlag(key: string, on: boolean): void {
    kvSet(`ex:${key}`, on ? "true" : "false");
  },
  /** Venue routing priority (first = tried first). Non-secret; survives backup. */
  getExchangePriority(): string[] {
    const def = ["hyperliquid", "hyperliquid-testnet", "aster", "mexc"];
    const raw = kvGet("exchangePriority");
    if (!raw) return def;
    try {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) {
        const valid = arr.filter((x): x is string => typeof x === "string" && def.includes(x));
        // Append any venue missing from a stale/partial stored list.
        for (const v of def) if (!valid.includes(v)) valid.push(v);
        if (valid.length) return valid;
      }
    } catch {
      /* fall back to default */
    }
    return def;
  },
  setExchangePriority(order: string[]): void {
    const known = ["hyperliquid", "hyperliquid-testnet", "aster", "mexc"];
    const valid = order.filter((x) => known.includes(x));
    for (const v of known) if (!valid.includes(v)) valid.push(v);
    kvSet("exchangePriority", JSON.stringify(valid));
  },
  /** Every desk-stored exchange key (for backup redaction). */
  exchangeKeys(): string[] {
    const rows = db
      .prepare("SELECT key FROM app_settings WHERE key LIKE 'ex:%'")
      .all() as { key: string }[];
    return rows.map((r) => r.key);
  },
};
