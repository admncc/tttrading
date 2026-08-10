import type { ExchangeName, TradeSide } from "@tttrading/shared";

/**
 * Venue-agnostic trading surface. Each connector (Hyperliquid, Aster, …) speaks
 * this so the engine, monitor and price ticker can route a trade to whichever
 * exchange lists its symbol without knowing the venue's REST dialect.
 *
 * Prices and sizes are always in the venue's quote currency (USDC/USDT) and base
 * asset units respectively; symbols are the bare coin (e.g. "BTC", "LTC").
 */

export interface AssetInfo {
  /** Bare coin symbol, e.g. "BTC" or "GOLD". */
  name: string;
  /**
   * Venue asset index used in orders. For Hyperliquid main perps this is the
   * universe index; for HIP-3 builder-deployed perps it's the encoded id
   * (100000 + perpDexIndex*10000 + localIndex). 0 where not applicable.
   */
  index: number;
  /** Decimal places allowed for the order size. */
  szDecimals: number;
  /** Max leverage the venue allows for this asset. */
  maxLeverage: number;
  /** HIP-3 builder dex name (e.g. "xyz") when this is a builder perp; else undefined. */
  dex?: string;
  /** Full venue symbol incl. the dex prefix, e.g. "xyz:GOLD" (mids/positions/fills). */
  venueSymbol?: string;
}

export interface OrderRequest {
  symbol: string;
  side: TradeSide;
  notionalUsd: number;
  leverage: number;
  marginMode: "cross" | "isolated";
  maxSlippage: number;
  /** Reduce-only (for closing/scaling out) — never opens/flips a position. */
  reduceOnly?: boolean;
  /**
   * Force a real exchange order even when the global shadow/test switch is on.
   * Used ONLY to manage an already-real position (close/reduce), so flipping
   * test mode mid-trade can never strip a live position of its exit.
   */
  force?: boolean;
}

export interface OrderResult {
  ok: boolean;
  filledPrice: number;
  size: number;
  orderId?: string;
  simulated: boolean;
  /**
   * The leverage the venue ACTUALLY applied — the requested leverage clamped to
   * the asset's max (many pairs cap below the desk default, e.g. 5x/4x). Persist
   * this on the trade so margin figures match the exchange. Undefined when the
   * order didn't set leverage (reduce-only) or the venue doesn't report it.
   */
  effectiveLeverage?: number;
  error?: string;
}

export interface LimitOrderRequest {
  symbol: string;
  side: TradeSide;
  notionalUsd: number;
  price: number;
  leverage: number;
  marginMode: "cross" | "isolated";
}

export interface LimitOrderResult {
  ok: boolean;
  status?: "resting" | "filled";
  orderId?: string;
  filledPrice?: number;
  size: number;
  simulated: boolean;
  /** Leverage the venue actually applied (requested clamped to the asset max). */
  effectiveLeverage?: number;
  error?: string;
}

export interface BracketParams {
  symbol: string;
  side: TradeSide;
  size: number;
  stopLoss?: number;
  takeProfits?: number[];
  slippage: number;
  /** Position margin mode — some venues (MEXC) need it on the SL/TP orders too. */
  marginMode?: "cross" | "isolated";
  /**
   * Place the STOP as a stop-LIMIT at the exact stop price (fills at that price
   * or better, never worse) instead of a stop-market. Used for break-even stops
   * so a "SL to break-even" cannot slip into a loss — at the cost that a violent
   * gap through the level may leave it unfilled. Venues that don't support it
   * fall back to a market stop.
   */
  slLimit?: boolean;
  /** Force real placement even in test mode (managing an already-real position). */
  force?: boolean;
}

export interface BracketResult {
  slOrderId?: string;
  tpOrderIds: string[];
  protectedOnExchange: boolean;
  error?: string;
}

export interface FillLite {
  oid: string;
  symbol: string;
  size: number; // absolute
  price: number;
  side: "B" | "A"; // buy / sell
  closedPnl: number;
  fee: number;
  time: number;
}

export interface Position {
  symbol: string;
  size: number; // signed
  entryPrice: number;
  unrealizedPnl: number;
  leverage: number;
}

export interface AccountSummary {
  address: string;
  accountValue: number;
  withdrawable: number;
  totalMarginUsed: number;
}

/** The methods the execution engine, monitor and ticker rely on, per venue. */
export interface ExchangeConnector {
  readonly name: ExchangeName;
  /** True when this venue can sign & send real orders (keys present, not paper). */
  readonly live: boolean;
  /** True when orders must be simulated rather than sent (test switch or no key). */
  simulating(): boolean;

  getAsset(symbol: string): Promise<AssetInfo | undefined>;
  getMidPrice(symbol: string): Promise<number | undefined>;
  getAllMids(): Promise<Record<string, number>>;
  getPositions(): Promise<Position[]>;
  /**
   * Account equity + free collateral. `symbol` lets a venue with per-market
   * collateral pots (Hyperliquid HIP-3 builder dexs) return the balance of the
   * pot that symbol trades from; venues with one account ignore it.
   */
  getAccountSummary(symbol?: string): Promise<AccountSummary | null>;
  /**
   * Recent fills for the account. `symbols` is an optional hint of the coins we
   * currently care about — venues whose fills API is per-symbol (Aster/Binance)
   * use it; venues that return everything (Hyperliquid) may ignore it.
   */
  getRecentFills(symbols?: string[]): Promise<FillLite[]>;
  getOpenOrderIds(): Promise<Set<string>>;

  placeMarketOrder(req: OrderRequest): Promise<OrderResult>;
  placeLimitOrder(req: LimitOrderRequest): Promise<LimitOrderResult>;
  placeBracketOrders(params: BracketParams): Promise<BracketResult>;
  cancelOrders(symbol: string, orderIds: string[]): Promise<void>;
}

export type { ExchangeName };
