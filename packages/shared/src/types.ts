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
  /**
   * When a signal gives only a single take-profit target, split the position
   * into several equally-spaced TP levels between entry and that target
   * (partial profit at each). Signals that already list multiple TPs are used
   * as-is.
   */
  autoSplitSingleTp: boolean;
  /** Number of TP levels to generate when auto-splitting a single target. */
  tpLevels: number;
  /**
   * Move the stop-loss to break-even (the entry price) once this many
   * take-profit levels have filled. 0 disables it; 1 = after TP1, 2 = after
   * TP2, and so on. Per channel, since providers scale out differently.
   */
  breakevenAfterTp: number;
  /**
   * When true, signals rated "red" (high risk) by the traffic-light system are
   * NOT executed. Their hypothetical outcome is still tracked (shadow trade) so
   * we can verify whether blocking them was the right call.
   */
  blockRedTrades: boolean;
  /**
   * Free-text, channel-specific parsing instructions given to the LLM as extra
   * context (formats, how entries/SL/TP are written, edit/cancel conventions,
   * quirks). Persisted per channel; can be refined over time.
   */
  instructions?: string;
  /** If set, ignore signals for symbols not in this allow-list. */
  allowedSymbols?: string[];
}

/** Global (desk-wide) runtime settings. */
export interface GlobalSettings {
  /**
   * Master test switch. When true, NO real orders are ever sent — every trade
   * is simulated at the live price (full lifecycle incl. SL/TP), regardless of
   * TRADING_ENV or a configured key. Turn off only when you're ready to go live.
   */
  shadowMode: boolean;
}

/** Traffic-light risk classification. */
export type RiskLevel = "green" | "yellow" | "red";

export interface RiskRating {
  level: RiskLevel;
  /** 0..100, higher = safer. */
  score: number;
  /** Human-readable factors behind the rating. */
  reasons: string[];
  /** Number of historical closed trades the channel score is based on. */
  sampleSize: number;
}

/** Lifecycle of a signal as it flows through the system. */
export type SignalStatus =
  | "pending" // parsed, waiting for confirmation (confirm mode)
  | "executing" // order being placed
  | "executed" // order placed -> trade created
  | "rejected" // dismissed by the user
  | "ignored" // filtered out (disabled group, symbol not allowed, ...)
  | "blocked" // high-risk (red) signal not executed; tracked as a shadow trade
  | "backfill" // imported from channel history for analysis; never executed
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
  risk?: RiskRating;
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
  /** Resting stop-loss trigger order id (live mode). */
  slOrderId?: string;
  /** Resting take-profit trigger order ids, in level order (live mode). */
  tpOrderIds?: string[];
  /** Whether SL/TP were actually placed on the exchange (vs. only recorded). */
  bracketProtected?: boolean;
  /** How many take-profit levels have filled so far (from reconciliation). */
  tpFilledCount?: number;
  /** Whether the stop-loss has been moved to break-even. */
  slMovedToBreakeven?: boolean;
  /** Risk rating assigned at entry. */
  risk?: RiskRating;
  /** Order was simulated (shadow/test mode or no signing key) — no real fill. */
  simulated?: boolean;
  /**
   * A shadow trade is NOT a real position — it records what a blocked (red)
   * signal would have done, so we can measure whether blocking it was correct.
   */
  shadow?: boolean;
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

/**
 * How well the traffic-light did: outcomes of red signals we blocked (tracked
 * as shadow trades). If blocked reds mostly would have lost, the classification
 * is earning its keep.
 */
export interface RiskAudit {
  blocked: number; // red signals blocked (shadow trades created)
  resolved: number; // shadows that have concluded
  wouldWin: number; // resolved shadows that would have been profitable
  wouldLose: number; // resolved shadows that would have lost
  /** Net PnL avoided by blocking (positive = blocking helped). */
  avoidedPnl: number;
}

export interface DashboardStats {
  overall: PerformanceStats;
  byGroup: GroupPerformance[];
  equityCurve: EquityPoint[];
  riskAudit: RiskAudit;
}

/** Result of replaying a channel's historical signals against real prices. */
export interface BacktestResult {
  groupId: string;
  groupName: string;
  /** Signals re-parsed with the current parser. */
  reparsed: number;
  /** Signals that had enough info to simulate. */
  tested: number;
  /** Parsed-but-not-simulatable (no SL/TP, symbol unavailable, no candles). */
  skipped: number;
  stats: PerformanceStats;
  /** Distribution of the re-parsed signals' risk levels. */
  riskCounts: { green: number; yellow: number; red: number };
  error?: string;
}

export type LogLevel = "info" | "warn" | "error";

/** A persisted, structured log entry (pipeline trace + system events). */
export interface LogEntry {
  id: string;
  ts: string;
  level: LogLevel;
  /** Grouping: "message" (incoming pipeline), "exec", "monitor", "system"… */
  category: string;
  message: string;
  /** Optional structured context (parsed fields, order result, ids…). */
  meta?: Record<string, unknown>;
  groupId?: string;
  signalId?: string;
}

/** Messages broadcast over the WebSocket to the desk. */
export type WsEvent =
  | { type: "signal"; signal: Signal }
  | { type: "trade"; trade: Trade }
  | { type: "group"; group: Group }
  | { type: "settings"; settings: GlobalSettings }
  | { type: "stats"; stats: DashboardStats }
  | { type: "log"; entry: LogEntry };

/** Payload to create/update a group from the desk. */
export interface GroupInput {
  name: string;
  telegramChannel: string;
  enabled: boolean;
  settings: GroupSettings;
}
