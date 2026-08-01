import { nanoid } from "nanoid";
import type {
  Group,
  GroupInput,
  GroupSettings,
  ParsedSignal,
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
  leverage: number;
  notional_usd: number;
  size: number;
  entry_price: number;
  exit_price: number | null;
  stop_loss: number | null;
  take_profits: string | null;
  realized_pnl: number | null;
  fees: number | null;
  exchange_order_id: string | null;
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
    leverage: r.leverage,
    notionalUsd: r.notional_usd,
    size: r.size,
    entryPrice: r.entry_price,
    exitPrice: r.exit_price ?? undefined,
    stopLoss: r.stop_loss ?? undefined,
    takeProfits: r.take_profits ? (JSON.parse(r.take_profits) as number[]) : undefined,
    realizedPnl: r.realized_pnl ?? undefined,
    fees: r.fees ?? undefined,
    exchangeOrderId: r.exchange_order_id ?? undefined,
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
  error?: string;
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
  get(id: string): Signal | undefined {
    const row = db.prepare("SELECT * FROM signals WHERE id = ?").get(id) as SignalRow | undefined;
    return row ? toSignal(row) : undefined;
  },
  create(input: NewSignal): Signal {
    const ts = now();
    const id = nanoid();
    db.prepare(
      `INSERT INTO signals (id, group_id, group_name, raw_text, status, parsed, error, received_at, updated_at)
       VALUES (@id, @group_id, @group_name, @raw_text, @status, @parsed, @error, @received_at, @updated_at)`,
    ).run({
      id,
      group_id: input.groupId,
      group_name: input.groupName,
      raw_text: input.rawText,
      status: input.status,
      parsed: input.parsed ? JSON.stringify(input.parsed) : null,
      error: input.error ?? null,
      received_at: ts,
      updated_at: ts,
    });
    return this.get(id)!;
  },
  update(
    id: string,
    patch: Partial<Pick<Signal, "status" | "error" | "tradeId" | "parsed">>,
  ): Signal | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...patch };
    db.prepare(
      `UPDATE signals SET status=@status, error=@error, trade_id=@trade_id,
        parsed=@parsed, updated_at=@updated_at WHERE id=@id`,
    ).run({
      id,
      status: merged.status,
      error: merged.error ?? null,
      trade_id: merged.tradeId ?? null,
      parsed: merged.parsed ? JSON.stringify(merged.parsed) : null,
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
  get(id: string): Trade | undefined {
    const row = db.prepare("SELECT * FROM trades WHERE id = ?").get(id) as TradeRow | undefined;
    return row ? toTrade(row) : undefined;
  },
  create(input: NewTrade): Trade {
    const id = nanoid();
    const openedAt = input.openedAt ?? now();
    db.prepare(
      `INSERT INTO trades (id, signal_id, group_id, group_name, symbol, side, status, env,
        leverage, notional_usd, size, entry_price, exit_price, stop_loss, take_profits,
        realized_pnl, fees, exchange_order_id, error, opened_at, closed_at)
       VALUES (@id, @signal_id, @group_id, @group_name, @symbol, @side, @status, @env,
        @leverage, @notional_usd, @size, @entry_price, @exit_price, @stop_loss, @take_profits,
        @realized_pnl, @fees, @exchange_order_id, @error, @opened_at, @closed_at)`,
    ).run({
      id,
      signal_id: input.signalId ?? null,
      group_id: input.groupId,
      group_name: input.groupName,
      symbol: input.symbol,
      side: input.side,
      status: input.status,
      env: input.env,
      leverage: input.leverage,
      notional_usd: input.notionalUsd,
      size: input.size,
      entry_price: input.entryPrice,
      exit_price: input.exitPrice ?? null,
      stop_loss: input.stopLoss ?? null,
      take_profits: input.takeProfits ? JSON.stringify(input.takeProfits) : null,
      realized_pnl: input.realizedPnl ?? null,
      fees: input.fees ?? null,
      exchange_order_id: input.exchangeOrderId ?? null,
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
      `UPDATE trades SET status=@status, exit_price=@exit_price, realized_pnl=@realized_pnl,
        fees=@fees, exchange_order_id=@exchange_order_id, error=@error, closed_at=@closed_at
       WHERE id=@id`,
    ).run({
      id,
      status: m.status,
      exit_price: m.exitPrice ?? null,
      realized_pnl: m.realizedPnl ?? null,
      fees: m.fees ?? null,
      exchange_order_id: m.exchangeOrderId ?? null,
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
