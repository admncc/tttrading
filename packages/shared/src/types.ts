/**
 * Shared domain model for the TT Trading desk.
 * These types are the contract between the backend and the web frontend.
 */

export type TradeSide = "long" | "short";

/**
 * Which venue a trade is (or would be) executed on. Hyperliquid is the primary;
 * others act as backups for symbols the primary doesn't list.
 */
export type ExchangeName = "hyperliquid" | "hyperliquid-testnet" | "aster" | "mexc";

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
  /** Notional size per trade in USDC, e.g. 5000. Used when sizingMode="fixed". */
  tradeSizeUsd: number;
  /**
   * How entries are placed:
   *  - "limit" (default): rest a limit order at the signal's entry price and
   *    wait — it becomes a position only when filled (a working order, not yet
   *    a position). Signals without an entry price fall back to market.
   *  - "market": enter immediately at the current price.
   */
  entryMode?: "limit" | "market";
  /** Cancel an unfilled working limit order after this many hours. Default 336 (14d). */
  limitTimeoutHours?: number;
  /**
   * How the position size is determined:
   *  - "fixed": always tradeSizeUsd (default).
   *  - "percentEquity": margin = riskValue% of account equity; notional = margin × leverage.
   *  - "riskPerTrade": size so that hitting the SL loses ~riskValue USDC (needs an SL).
   */
  sizingMode?: "fixed" | "percentEquity" | "riskPerTrade";
  /** Percent (percentEquity) or USDC risk (riskPerTrade) for the sizing mode. */
  riskValue?: number;
  /** Ignore a same-symbol+side entry within this many minutes of the last one. 0/undefined = off. */
  symbolCooldownMinutes?: number;
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
   * Fraction (percent) to book when a management message says "take partial /
   * booked profits / manual TP1" WITHOUT a number. Default 50. Per channel,
   * since providers scale out differently.
   */
  defaultPartialPct?: number;
  /**
   * Move the stop-loss to break-even (the entry price) once this many
   * take-profit levels have filled. 0 disables it; 1 = after TP1, 2 = after
   * TP2, and so on. Per channel, since providers scale out differently.
   */
  breakevenAfterTp: number;
  /**
   * DCA-hold: widen the placed entry stop-loss to this MULTIPLE of the signal's
   * stop distance, giving DCA-style channels (traders who add through a flush
   * rather than getting wicked out) room to survive before their add/manage
   * signal arrives. 1 = use the signal's stop as-is (default, no change). Bounded
   * 1–3 — this is a wider stop, NOT unbounded loss-averaging. Applied before
   * sizing, so risk-per-trade sizing shrinks the position to keep the $ risk on
   * target; fixed/percent sizing keeps size, so max loss scales with the multiple.
   */
  slWideningMult?: number;
  /**
   * When a signal has an ENTRY but NO stop-loss, place a wide protective stop this
   * many PERCENT from the fill (long below / short above). Gives vague "taking a
   * risk here, wide SL" calls a floor instead of running unprotected. 0/undefined
   * = off (leave stopless). Never overrides a stop the signal actually specified.
   */
  defaultStopPct?: number;
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
  /** Kill-switch: when true, NO new entries are opened (existing trades run). */
  tradingPaused: boolean;
  /** Auto-pause new entries once realized PnL today is below −this. 0 = off. */
  dailyLossLimitUsd: number;
  /** Refuse new entries when this many trades are already open. 0 = off. */
  maxOpenTrades: number;
  /** Refuse new entries when open notional would exceed this. 0 = off. */
  maxExposureUsd: number;
  /**
   * Safety cap on the notional of any REAL (non-simulated) order — HL mainnet,
   * Aster, MEXC. An order sized above this is clamped down to it; simulated
   * (testnet/paper/shadow) orders are unaffected. Ideal for validating mainnet
   * with tiny size before scaling up. 0 = off (no cap).
   */
  liveMaxOrderUsd: number;
  /**
   * When a new signal opposes a position already open for that symbol on the
   * primary venue, route it to the next backup venue that lists the coin and has
   * no opposing position (e.g. long on Hyperliquid, short on Aster) instead of
   * netting them on one venue. When off, opposing signals just route normally.
   */
  splitOpposingVenues: boolean;
  /**
   * When a SAME-coin position from a DIFFERENT trader is already open, route the
   * new trade to a separate backup venue so the two don't net into one shared
   * position (where one trader's close flattens the other and their margin/PnL
   * commingle). Same-trader adds (scale-in / DCA) stay put. Default on.
   */
  isolateSameCoinVenues: boolean;
  /**
   * Directional venue split: route all LONGs to the primary venue (Hyperliquid)
   * and all SHORTs to the secondary (Aster), so opposing positions from different
   * traders always land on separate venues and never conflict — instead of the
   * opposing side being rejected for "no free venue". Takes precedence over
   * splitOpposingVenues and isolateSameCoinVenues. Trade-off: multiple same-side
   * traders in one coin then share (net on) that direction's venue. Default off.
   */
  directionalVenueSplit: boolean;
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
  | "managed" // a trade-management message (SL move / partial / close) applied
  | "failed" // parsing or execution error
  | "unparseable"; // message arrived but no signal could be extracted

export type SignalSource = "regex" | "llm" | "manual";

/** The normalized trade instruction extracted from a Telegram message. */
export interface ParsedSignal {
  symbol: string; // e.g. "BTC"
  side: TradeSide;
  entry?: number; // limit entry, undefined => market
  /**
   * Scale-in entries: when a signal lists several entry zones to ADD into
   * (e.g. "First entry (cmp) … Second limit entry …"), each leg becomes its
   * OWN full-size order sharing the same stop-loss + take-profits. Present only
   * when there are ≥2 legs; single-entry signals use `entry`. `mode` "market"
   * = enter now at the current price (cmp), "limit" = rest at `price`.
   */
  entries?: { price?: number; mode: "market" | "limit" }[];
  stopLoss?: number;
  takeProfits?: number[];
  leverageHint?: number; // leverage suggested in the message, if any
  /**
   * The provider is buying/selling on the SPOT market (e.g. "buying Bitcoin
   * Spot"). Spot has no leverage, stop-loss or take-profit structure, so we
   * never place an order for it — it is parsed and recorded, then skipped.
   */
  spot?: boolean;
  /**
   * The provider is ADDING to / DCA-ing into an existing position at a stated
   * price (e.g. "doing DCA here at 4.416", "adding at", "scaling in") — often
   * phrased as a "trade update". It is an actionable entry that increases size;
   * it may carry no SL/TP of its own (the existing position's stop covers it).
   */
  dca?: boolean;
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
  /** An attachment was on the message (served at /api/messages/:id/image). */
  hasImage?: boolean;
  /** Kind of attachment, so the desk renders an image thumbnail vs a PDF link. */
  attachmentType?: "image" | "pdf";
  receivedAt: string;
  updatedAt: string;
}

export type TradeStatus =
  | "working" // a resting limit entry order — NOT yet a position
  | "open"
  | "closed"
  | "failed"
  | "canceled";

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
  /** Venue the position lives on. Defaults to "hyperliquid" for legacy rows. */
  exchange?: ExchangeName;
  leverage: number;
  /** Notional in USDC at entry. */
  notionalUsd: number;
  /** Position size in asset units. */
  size: number;
  entryPrice: number;
  /** The entry price the signal asked for (planned) — for slippage analysis. */
  signalEntry?: number;
  exitPrice?: number;
  stopLoss?: number;
  takeProfits?: number[];
  /** Realized PnL in USDC once closed. */
  realizedPnl?: number;
  /** Fees paid in USDC. */
  fees?: number;
  /**
   * Realized PnL already locked in from partial exits (e.g. a "book 50%"
   * management message) while the position is still open. Folded into
   * realizedPnl when the trade finally closes.
   */
  bankedPnl?: number;
  /** Fees paid on those partial exits, folded into fees on final close. */
  bankedFees?: number;
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
  /**
   * User has filed this (closed) trade into the archive: it is hidden from the
   * active Trades view and excluded from analytics/stats. Purely a UI/reporting
   * flag — it never affects execution.
   */
  archived?: boolean;
  error?: string;
  openedAt: string;
  closedAt?: string;
}

/**
 * Second Opinion: an INDEPENDENT, observe-only assessment of ONE trading signal
 * — objective chart-analysis (A) plus, over time, verification of how the call
 * actually played out (B). It never places or manages orders; it exists to weigh
 * each provider's calls from a professional trader's view and track whether our
 * read beats theirs before any active use.
 */
export interface SecondOpinionTFrame {
  interval: string;
  trend: "up" | "down" | "sideways";
  ema20: number;
  ema50: number;
  ema200: number;
  atr: number;
  support: number;
  resistance: number;
  rsi: number;
}
/** Our OWN independent plan for the trade — for comparison vs the provider's. */
export interface SecondOpinionSuggestion {
  stopLoss: number;
  takeProfit: number;
  rr: number;
  note: string;
}
export interface SecondOpinionTA {
  interval: string; // primary timeframe
  price: number; // price at analysis time
  trend: "up" | "down" | "sideways";
  emaFast: number;
  emaMid: number;
  emaSlow: number;
  atr: number;
  atrPct: number; // atr / price
  support: number;
  resistance: number;
  slAtrMultiple?: number; // |entry - SL| / atr — <1 ≈ inside the noise
  rrClaimed?: number; // to the provider's TP1
  rrRealistic?: number; // to the nearest opposing swing (support/resistance)
  entryLocation?: string; // e.g. "long into resistance", "short into support"
  entryVsPricePct?: number; // signed % of the provider entry vs live price (+ = above market)
  entryStale?: boolean; // limit entry sits far (>~3% or >2x ATR) from the live market → stale/mismatched
  // --- richer context (collected from the start for comparison) ---
  rsi?: number; // primary-timeframe RSI(14)
  rangePosition?: number; // 0..1 where price sits in the recent high-low range
  volumeTrendPct?: number; // last-bar volume vs recent average, % (+ = rising)
  funding?: number; // current funding rate (perp crowding)
  openInterest?: number; // notional OI
  premiumBps?: number; // (mark - oracle) / oracle, in bps
  frames?: SecondOpinionTFrame[]; // multi-timeframe snapshot (15m/1h/4h/1d)
  mtfAlignment?: string; // e.g. "3/4 timeframes up"
  suggestion?: SecondOpinionSuggestion; // our own SL/TP vs the provider's
}
export interface SecondOpinionVerdict {
  stance: "positive" | "negative";
  score: number; // 0..100 — our confidence the setup is technically sound
  summary: string;
  redFlags: string[];
  strengths: string[];
  source: "llm" | "heuristic";
  confidence: number; // 0..1
}
export interface SecondOpinionOutcome {
  checkedAt: string;
  mfePct: number; // max favorable excursion since the signal (%)
  maePct: number; // max adverse excursion (%)
  tp1Hit?: boolean;
  slHit?: boolean;
  firstHit?: "tp" | "sl" | "none";
  resolved: boolean;
  hoursToFirstHit?: number; // hours from signal to the first TP/SL touch
  maxR?: number; // best favorable excursion in R multiples (using the provider's risk)
  allTpHit?: boolean; // every listed take-profit was reached
}
export interface SecondOpinion {
  id: string;
  signalId?: string;
  groupId: string;
  groupName: string;
  symbol: string;
  side: TradeSide;
  createdAt: string;
  entry?: number;
  stopLoss?: number;
  takeProfits?: number[];
  ta?: SecondOpinionTA;
  verdict?: SecondOpinionVerdict;
  outcome?: SecondOpinionOutcome;
}

/** Aggregated performance figures. */
export interface PerformanceStats {
  trades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1
  realizedPnl: number;
  /**
   * Profit already LOCKED IN from partial take-profit exits on trades that are
   * still OPEN (net of fees). It is real, booked money, so it is included in
   * `realizedPnl` — this field breaks it out so the UI can label how much of the
   * realized total is riding on positions that haven't fully closed yet.
   */
  bankedOpenPnl: number;
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

/** Deeper performance metrics for the analytics view. */
export interface AdvancedStats extends PerformanceStats {
  grossProfit: number;
  grossLoss: number;
  /** Average winning trade PnL. */
  avgWin: number;
  /** Average losing trade PnL (negative). */
  avgLoss: number;
  /** Expectancy = average realized PnL per closed trade. */
  expectancy: number;
  /** Average realized reward:risk (PnL ÷ initial risk from entry→SL). */
  avgRR: number;
  /** Closed trades that had a stop-loss (basis for avgRR). */
  rrSampleSize: number;
  /** Largest peak-to-trough drop on the cumulative realized-PnL curve. */
  maxDrawdown: number;
  /** Average time in trade for closed trades, in hours. */
  avgHoldHours: number;
  /** Total fees paid across closed trades. */
  totalFees: number;
  /** Average adverse entry slippage vs the signal's price, in basis points. */
  avgSlippageBps: number;
  /** Closed trades that had a signal entry price (basis for avgSlippageBps). */
  slippageSampleSize: number;
}

/** One analytics row: performance for a group, symbol, or side. */
export interface AnalyticsBucket {
  key: string;
  label: string;
  stats: AdvancedStats;
  /** Cumulative realized-PnL curve for this bucket. */
  equityCurve: EquityPoint[];
}

export interface AnalyticsResponse {
  overall: AdvancedStats;
  byGroup: AnalyticsBucket[];
  bySymbol: AnalyticsBucket[];
  bySide: AnalyticsBucket[];
  equityCurve: EquityPoint[];
  /** Number of closed trades the analysis is based on. */
  closedTrades: number;
  /** Whether simulated (test-mode) trades are included. */
  includesSimulated: boolean;
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
  | { type: "log"; entry: LogEntry }
  | { type: "prices"; prices: Record<string, number> }
  | { type: "secondOpinion"; secondOpinion: SecondOpinion };

/** Payload to create/update a group from the desk. */
export interface GroupInput {
  name: string;
  telegramChannel: string;
  enabled: boolean;
  settings: GroupSettings;
}
