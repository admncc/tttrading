import * as hl from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { TradeSide } from "@tttrading/shared";
import { config, hyperliquidReady } from "../config.js";
import { settings } from "../db/repositories.js";
import { log } from "../logger.js";

export interface AssetInfo {
  name: string;
  index: number;
  szDecimals: number;
  maxLeverage: number;
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
  error?: string;
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

/**
 * Thin wrapper around @nktkas/hyperliquid. Reads market data with a read-only
 * InfoClient (works without a wallet) and only signs/sends orders when a
 * private key is configured and we're not in paper mode. In paper mode orders
 * are simulated against the live mid price so the desk still reflects reality.
 */
export class HyperliquidConnector {
  private transport: hl.HttpTransport;
  private info: hl.PublicClient;
  private exchange?: hl.WalletClient;
  private assets = new Map<string, AssetInfo>();
  private assetsLoadedAt = 0;
  readonly live: boolean;

  constructor() {
    this.transport = new hl.HttpTransport({ isTestnet: config.isTestnet });
    this.info = new hl.PublicClient({ transport: this.transport });
    this.live = hyperliquidReady();

    if (this.live) {
      const account = privateKeyToAccount(
        config.hyperliquid.privateKey as `0x${string}`,
      );
      this.exchange = new hl.WalletClient({
        wallet: account,
        transport: this.transport,
        isTestnet: config.isTestnet,
      });
      log.info(`Hyperliquid connector LIVE on ${config.tradingEnv}.`);
      if (!config.hyperliquid.accountAddress) {
        const signer = account.address;
        log.warn(
          `HL_ACCOUNT_ADDRESS not set — reading state from the signer address ${signer}. ` +
            `If HL_PRIVATE_KEY is an agent/API wallet, positions & balance live on the MASTER ` +
            `account; set HL_ACCOUNT_ADDRESS to the master address or the desk will show zero exposure.`,
        );
      }
    } else {
      log.warn(
        `Hyperliquid connector in ${config.tradingEnv} mode (no signing) — orders are simulated.`,
      );
    }
  }

  /**
   * True when orders must be simulated rather than sent: either the global
   * shadow/test switch is on, or there's no signing capability (paper/no key).
   */
  simulating(): boolean {
    return settings.getShadowMode() || !this.live;
  }

  private accountAddress(): `0x${string}` {
    const addr = config.hyperliquid.accountAddress || "";
    if (addr) return addr as `0x${string}`;
    if (this.live) {
      return privateKeyToAccount(config.hyperliquid.privateKey as `0x${string}`).address;
    }
    throw new Error("No Hyperliquid account address configured.");
  }

  /** Load perpetual metadata (asset index + size decimals). Cached for 5 min. */
  async loadAssets(force = false): Promise<Map<string, AssetInfo>> {
    if (!force && this.assets.size > 0 && Date.now() - this.assetsLoadedAt < 300_000) {
      return this.assets;
    }
    const meta = (await this.info.meta()) as unknown as {
      universe: { name: string; szDecimals: number; maxLeverage: number }[];
    };
    this.assets.clear();
    meta.universe.forEach((a, index) => {
      this.assets.set(a.name.toUpperCase(), {
        name: a.name,
        index,
        szDecimals: a.szDecimals,
        maxLeverage: a.maxLeverage,
      });
    });
    this.assetsLoadedAt = Date.now();
    return this.assets;
  }

  async getAsset(symbol: string): Promise<AssetInfo | undefined> {
    await this.loadAssets();
    return this.assets.get(symbol.toUpperCase());
  }

  /** Current mid price for a symbol. */
  async getMidPrice(symbol: string): Promise<number | undefined> {
    const mids = (await this.info.allMids()) as unknown as Record<string, string>;
    const raw = mids[symbol.toUpperCase()] ?? mids[symbol];
    return raw ? Number(raw) : undefined;
  }

  /** Open positions for the configured account. */
  async getPositions(): Promise<Position[]> {
    if (!this.live && !config.hyperliquid.accountAddress) return [];
    const state = (await this.info.clearinghouseState({
      user: this.accountAddress(),
    })) as unknown as {
      assetPositions: {
        position: {
          coin: string;
          szi: string;
          entryPx: string | null;
          unrealizedPnl: string;
          leverage: { value: number };
        };
      }[];
    };
    return state.assetPositions.map((p) => ({
      symbol: p.position.coin,
      size: Number(p.position.szi),
      entryPrice: Number(p.position.entryPx ?? 0),
      unrealizedPnl: Number(p.position.unrealizedPnl),
      leverage: p.position.leverage?.value ?? 0,
    }));
  }

  /** The address that SIGNS orders (derived from HL_PRIVATE_KEY), or null. */
  signerAddress(): string | null {
    if (!this.live) return null;
    try {
      return privateKeyToAccount(config.hyperliquid.privateKey as `0x${string}`).address;
    } catch {
      return null;
    }
  }

  /** The account address we read state for, or null if none is resolvable. */
  publicAddress(): string | null {
    try {
      return this.accountAddress();
    } catch {
      return null;
    }
  }

  /** Account equity + free collateral for the configured account. */
  async getAccountSummary(): Promise<{
    address: string;
    accountValue: number;
    withdrawable: number;
    totalMarginUsed: number;
  } | null> {
    const address = this.publicAddress();
    if (!address) return null;
    const state = (await this.info.clearinghouseState({
      user: address as `0x${string}`,
    })) as unknown as {
      marginSummary?: { accountValue?: string; totalMarginUsed?: string };
      withdrawable?: string;
    };
    return {
      address,
      accountValue: Number(state.marginSummary?.accountValue ?? 0),
      withdrawable: Number(state.withdrawable ?? 0),
      totalMarginUsed: Number(state.marginSummary?.totalMarginUsed ?? 0),
    };
  }

  /**
   * Move USDC between the spot/unified wallet and the perps margin account.
   * toPerp=true funds perp trading (Spot -> Perp). Requires a signing key.
   */
  async transferUsd(amount: number, toPerp: boolean): Promise<{ ok: boolean; error?: string }> {
    if (!this.live || !this.exchange) return { ok: false, error: "not connected (no signing key)" };
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "amount must be > 0" };
    try {
      // USDC has 6 decimals; fixed precision avoids scientific-notation payloads.
      await this.exchange.usdClassTransfer({ amount: amount.toFixed(6), toPerp });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Spot USDC balance (the unified/spot wallet) for the configured account. */
  async getSpotUsdc(): Promise<number | null> {
    const address = this.publicAddress();
    if (!address) return null;
    const state = (await this.info.spotClearinghouseState({
      user: address as `0x${string}`,
    })) as unknown as { balances?: { coin: string; total?: string }[] };
    const usdc = state.balances?.find((b) => b.coin?.toUpperCase() === "USDC");
    return usdc ? Number(usdc.total ?? 0) : 0;
  }

  private async setLeverage(
    asset: AssetInfo,
    leverage: number,
    marginMode: "cross" | "isolated",
  ): Promise<void> {
    if (!this.exchange) return;
    // Round DOWN to an integer so actual leverage never exceeds what was asked.
    const capped = Math.max(1, Math.floor(Math.min(leverage, asset.maxLeverage)));
    await this.exchange.updateLeverage({
      asset: asset.index,
      isCross: marginMode === "cross",
      leverage: capped,
    });
  }

  /** Place a market order (implemented as an aggressive IOC limit). */
  async placeMarketOrder(req: OrderRequest): Promise<OrderResult> {
    let asset: AssetInfo | undefined;
    let mid: number | undefined;
    try {
      asset = await this.getAsset(req.symbol);
      if (asset) mid = await this.getMidPrice(req.symbol);
    } catch (err) {
      // Network / API failure while pricing the order — fail cleanly.
      return {
        ok: false,
        filledPrice: 0,
        size: 0,
        simulated: !this.live,
        error: `Price feed error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!asset) {
      return { ok: false, filledPrice: 0, size: 0, simulated: !this.live, error: `Unknown symbol ${req.symbol}` };
    }
    if (!mid || mid <= 0) {
      return { ok: false, filledPrice: 0, size: 0, simulated: !this.live, error: `No price for ${req.symbol}` };
    }

    const isBuy = req.side === "long";
    const size = roundSize(req.notionalUsd / mid, asset.szDecimals);
    if (size <= 0) {
      return { ok: false, filledPrice: mid, size: 0, simulated: !this.live, error: "Computed size is 0" };
    }
    // Hyperliquid rejects orders below ~$10 notional. Guard opens only — a
    // reduce-only close of a small remaining position must always be allowed.
    if (!req.reduceOnly && size * mid < 10) {
      return {
        ok: false,
        filledPrice: mid,
        size: 0,
        simulated: !this.live,
        error: `Order value ${(size * mid).toFixed(2)} below Hyperliquid's $10 minimum`,
      };
    }
    // Aggressive limit price so the IOC order crosses the book.
    const slip = req.maxSlippage;
    const limitPx = roundPx(mid * (isBuy ? 1 + slip : 1 - slip), asset.szDecimals);

    // Simulate unless there's a signing key AND (test mode is off OR this is a
    // forced management order on an already-real position).
    if (!this.exchange || (this.simulating() && !req.force)) {
      return { ok: true, filledPrice: mid, size, simulated: true };
    }

    try {
      await this.setLeverage(asset, req.leverage, req.marginMode);
      const result = (await this.exchange.order({
        orders: [
          {
            a: asset.index,
            b: isBuy,
            p: String(limitPx),
            s: String(size),
            r: req.reduceOnly ?? false,
            t: { limit: { tif: "Ioc" } },
          },
        ],
        grouping: "na",
      })) as unknown as HlOrderResponse;

      const parsed = parseOrderResponse(result);
      if (!parsed.ok) {
        return { ok: false, filledPrice: limitPx, size: 0, simulated: false, error: parsed.error };
      }
      // Use the ACTUAL filled size, not the requested size (partial fills).
      const filledSize = parsed.filledSize && parsed.filledSize > 0 ? parsed.filledSize : size;
      return {
        ok: true,
        filledPrice: parsed.filledPrice,
        size: filledSize,
        orderId: parsed.orderId,
        simulated: false,
      };
    } catch (err) {
      return {
        ok: false,
        filledPrice: limitPx,
        size,
        simulated: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Place reduce-only SL/TP trigger orders that protect an open position.
   * The stop-loss covers the full size; take-profits split the size evenly.
   * No-op (returns unprotected) in paper/unsigned mode.
   */
  async placeBracketOrders(params: {
    symbol: string;
    side: TradeSide;
    size: number;
    stopLoss?: number;
    takeProfits?: number[];
    slippage: number;
    /** Force real placement even in test mode (managing an already-real position). */
    force?: boolean;
  }): Promise<BracketResult> {
    const { symbol, side, size, stopLoss, takeProfits, slippage, force } = params;
    const tps = takeProfits ?? [];
    if (stopLoss === undefined && tps.length === 0) {
      return { tpOrderIds: [], protectedOnExchange: false };
    }
    if (!this.exchange || (this.simulating() && !force)) {
      return { tpOrderIds: [], protectedOnExchange: false };
    }

    let asset: AssetInfo | undefined;
    try {
      asset = await this.getAsset(symbol);
    } catch (err) {
      return {
        tpOrderIds: [],
        protectedOnExchange: false,
        error: `Price feed error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!asset) return { tpOrderIds: [], protectedOnExchange: false, error: `Unknown symbol ${symbol}` };

    // Closing a long means selling; closing a short means buying.
    const closeIsBuy = side === "short";
    const orders: HlOrderParams[] = [];
    const kinds: ("sl" | "tp")[] = []; // parallel to `orders`, to map responses back

    const worstPx = (triggerPx: number) =>
      roundPx(triggerPx * (closeIsBuy ? 1 + slippage : 1 - slippage), asset.szDecimals);

    if (stopLoss !== undefined) {
      orders.push({
        a: asset.index,
        b: closeIsBuy,
        p: String(worstPx(stopLoss)),
        s: String(roundSize(size, asset.szDecimals)),
        r: true,
        t: { trigger: { isMarket: true, triggerPx: String(roundPx(stopLoss, asset.szDecimals)), tpsl: "sl" } },
      });
      kinds.push("sl");
    }

    if (tps.length > 0) {
      let remaining = size;
      tps.forEach((tp, i) => {
        const isLast = i === tps.length - 1;
        const chunk = isLast ? remaining : roundSize(size / tps.length, asset.szDecimals);
        remaining = roundSize(remaining - chunk, asset.szDecimals);
        if (chunk <= 0) return;
        orders.push({
          a: asset.index,
          b: closeIsBuy,
          p: String(worstPx(tp)),
          s: String(chunk),
          r: true,
          t: { trigger: { isMarket: true, triggerPx: String(roundPx(tp, asset.szDecimals)), tpsl: "tp" } },
        });
        kinds.push("tp");
      });
    }

    if (orders.length === 0) return { tpOrderIds: [], protectedOnExchange: false };

    try {
      const res = (await this.exchange.order({ orders, grouping: "na" })) as unknown as HlOrderResponse;
      const statuses = res.response?.data?.statuses ?? [];
      let slOrderId: string | undefined;
      const tpOrderIds: string[] = [];
      statuses.forEach((s, i) => {
        let oid: string | undefined;
        if ("resting" in s) oid = String(s.resting.oid);
        else if ("filled" in s) oid = String(s.filled.oid);
        if (!oid) return;
        if (kinds[i] === "sl") slOrderId = oid;
        else tpOrderIds.push(oid);
      });
      const protectedOnExchange = slOrderId !== undefined || tpOrderIds.length > 0;
      return { slOrderId, tpOrderIds, protectedOnExchange };
    } catch (err) {
      return {
        tpOrderIds: [],
        protectedOnExchange: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Historical OHLC candles for a symbol, oldest first. */
  async getCandles(
    symbol: string,
    interval: string,
    startMs: number,
    endMs: number,
  ): Promise<{ t: number; o: number; h: number; l: number; c: number }[]> {
    const raw = (await this.info.candleSnapshot({
      coin: symbol.toUpperCase(),
      interval: interval as Parameters<typeof this.info.candleSnapshot>[0]["interval"],
      startTime: startMs,
      endTime: endMs,
    })) as unknown as { t: number; o: string; h: string; l: string; c: string }[];
    return raw.map((k) => ({
      t: k.t,
      o: Number(k.o),
      h: Number(k.h),
      l: Number(k.l),
      c: Number(k.c),
    }));
  }

  /** Recent fills for the configured account (most recent first). */
  async getRecentFills(): Promise<FillLite[]> {
    if (!this.live && !config.hyperliquid.accountAddress) return [];
    const fills = (await this.info.userFills({
      user: this.accountAddress(),
    })) as unknown as {
      oid: number;
      coin: string;
      sz: string;
      px: string;
      side: "B" | "A";
      closedPnl: string;
      fee: string;
      time: number;
    }[];
    return fills.map((f) => ({
      oid: String(f.oid),
      symbol: f.coin,
      size: Math.abs(Number(f.sz)),
      price: Number(f.px),
      side: f.side,
      closedPnl: Number(f.closedPnl),
      fee: Number(f.fee),
      time: f.time,
    }));
  }

  /** Cancel resting orders (e.g. SL/TP) for a symbol. */
  async cancelOrders(symbol: string, orderIds: string[]): Promise<void> {
    if (!this.live || !this.exchange || orderIds.length === 0) return;
    const asset = await this.getAsset(symbol);
    if (!asset) return;
    try {
      await this.exchange.cancel({
        cancels: orderIds.map((oid) => ({ a: asset.index, o: Number(oid) })),
      });
    } catch (err) {
      log.warn(`Failed to cancel orders for ${symbol}:`, err instanceof Error ? err.message : err);
    }
  }
}

/* --------------------------- response parsing --------------------------- */

type HlOrderParams = {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t:
    | { limit: { tif: "Gtc" | "Ioc" | "Alo" } }
    | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
};

interface HlOrderResponse {
  status: string;
  response?: {
    data?: {
      statuses?: Array<
        | { filled: { avgPx: string; totalSz: string; oid: number } }
        | { resting: { oid: number } }
        | { error: string }
      >;
    };
  };
}

interface ParsedOrder {
  ok: boolean;
  filledPrice: number;
  filledSize?: number;
  orderId?: string;
  error?: string;
}

function parseOrderResponse(res: HlOrderResponse): ParsedOrder {
  const statuses = res.response?.data?.statuses ?? [];
  for (const s of statuses) {
    if ("filled" in s) {
      return {
        ok: true,
        filledPrice: Number(s.filled.avgPx),
        filledSize: Number(s.filled.totalSz),
        orderId: String(s.filled.oid),
      };
    }
    // An IOC order that rests did NOT fill immediately — treat as no fill.
    if ("resting" in s) {
      return { ok: false, filledPrice: 0, error: "IOC order did not fill immediately" };
    }
    if ("error" in s) {
      return { ok: false, filledPrice: 0, error: s.error };
    }
  }
  // No per-order status => no confirmed fill; never book a phantom position.
  return { ok: false, filledPrice: 0, error: `No fill in response (status: ${res.status})` };
}

/* ------------------------------ rounding ------------------------------- */

/** Floor size to the asset's size decimals. */
export function roundSize(size: number, szDecimals: number): number {
  const factor = 10 ** szDecimals;
  return Math.floor(size * factor) / factor;
}

/**
 * Hyperliquid price rules: max 5 significant figures, and for perps at most
 * (6 - szDecimals) decimal places.
 */
export function roundPx(px: number, szDecimals: number): number {
  if (px <= 0) return px;
  // Hyperliquid allows integer prices with more than 5 sig figs; only reduce to
  // 5 significant figures for sub-100000 prices, then cap decimal places.
  if (px >= 100000) return Math.round(px);
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const sig = Number(px.toPrecision(5));
  const factor = 10 ** maxDecimals;
  return Math.round(sig * factor) / factor;
}

export const hyperliquid = new HyperliquidConnector();
