/**
 * Shared domain model for the TT Trading desk.
 * These types are the contract between the backend and the web frontend.
 */

export type TradeSide = "long" | "short";

/** How a group's signals should reach the exchange. */
export type ExecutionMode = "auto" | "confirm";

/** Whether we trade against Hyperliquid testnet, mainnet, or only simulate. */
export type TradingEnv = "testnet" | "mainnet" | "paper";

/**
 * A Telegram channel / trading group we listen to. Each group carries its own
 * risk settings so different signal providers can be tuned independently.
 */
export interface Group {
  id: string;
  /** Human friendly name shown in the desk. */
  name: string;
  /** Telegram channel id or @username the listener subscribes to. */
  telegramChannel: string;
  enabled: boolean;
  settings: GroupSettings;
  createdAt: string;
  updatedAt: string;
}

export interface GroupSettings {
  /** Leverage applied per trade, e.g. 4 for x4. */
  leverage: number;
  /** Notional size per trade in USDC, e.g. 5000. */
  tradeSizeUsd: number;
  /** auto = fire immediately, confirm = wait for a click in the desk. */
  executionMode: ExecutionMode;
  /** Cross vs isolated margin on Hyperliquid. */
  marginMode: "cross" | "isolated";
  /** Max acceptable slippage (fraction, e.g. 0.01 = 1%) for market entries. */
  maxSlippage: number;
  /** If set, ignore signals for symbols not in this allow-list. */
  allowedSymbols?: string[];
}

/** Lifecycle of a signal as it flows through the system. */
export type SignalStatus =
  | "pending" // parsed, waiting for confirmation (confirm mode)
  | "executing" // order being placed
  | "executed" // order placed -> trade created
  | "rejected" // dismissed by the user
  | "ignored" // filtered out (disabled group, symbol not allowed, ...)
  | "failed" // parsing or execution error
  | "unparseable"; // message arrived but no signal could be extracted

export type SignalSource = "regex" | "llm" | "manual";

/** The normalized trade instruction extracted from a Telegram message. */
export interface ParsedSignal {
  symbol: string; // e.g. "BTC"
  side: TradeSide;
  entry?: number; // limit entry, undefined => market
  stopLoss?: number;
  takeProfits?: number[];
  leverageHint?: number; // leverage suggested in the message, if any
  confidence: number; // 0..1
  source: SignalSource;
}

/** A signal record persisted for the desk (raw message + parse result). */
export interface Signal {
  id: string;
  groupId: string;
  groupName: string;
  rawText: string;
  status: SignalStatus;
  parsed?: ParsedSignal;
  error?: string;
  tradeId?: string;
  receivedAt: string;
  updatedAt: string;
}

export type TradeStatus = "open" | "closed" | "failed" | "canceled";

/** An executed (or attempted) trade on Hyperliquid. */
export interface Trade {
  id: string;
  signalId?: string;
  groupId: string;
  groupName: string;
  symbol: string;
  side: TradeSide;
  status: TradeStatus;
  env: TradingEnv;
  leverage: number;
  /** Notional in USDC at entry. */
  notionalUsd: number;
  /** Position size in asset units. */
  size: number;
  entryPrice: number;
  exitPrice?: number;
  stopLoss?: number;
  takeProfits?: number[];
  /** Realized PnL in USDC once closed. */
  realizedPnl?: number;
  /** Fees paid in USDC. */
  fees?: number;
  /** Exchange order id of the entry, when available. */
  exchangeOrderId?: string;
  /** Exchange order ids of the resting SL/TP trigger orders (live mode). */
  bracketOrderIds?: string[];
  /** Whether SL/TP were actually placed on the exchange (vs. only recorded). */
  bracketProtected?: boolean;
  error?: string;
  openedAt: string;
  closedAt?: string;
}

/** Aggregated performance figures. */
export interface PerformanceStats {
  trades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1
  realizedPnl: number;
  totalNotional: number;
  avgPnl: number;
  bestTrade: number;
  worstTrade: number;
  profitFactor: number; // gross profit / gross loss
}

export interface GroupPerformance {
  groupId: string;
  groupName: string;
  stats: PerformanceStats;
}

/** Point on the cumulative PnL curve. */
export interface EquityPoint {
  t: string; // ISO timestamp
  pnl: number; // cumulative realized PnL
}

export interface DashboardStats {
  overall: PerformanceStats;
  byGroup: GroupPerformance[];
  equityCurve: EquityPoint[];
}

/** Messages broadcast over the WebSocket to the desk. */
export type WsEvent =
  | { type: "signal"; signal: Signal }
  | { type: "trade"; trade: Trade }
  | { type: "group"; group: Group }
  | { type: "stats"; stats: DashboardStats }
  | { type: "log"; level: "info" | "warn" | "error"; message: string; t: string };

/** Payload to create/update a group from the desk. */
export interface GroupInput {
  name: string;
  telegramChannel: string;
  enabled: boolean;
  settings: GroupSettings;
}
