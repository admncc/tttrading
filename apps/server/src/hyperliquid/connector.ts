import * as hl from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { TradeSide } from "@tttrading/shared";
import { config, hyperliquidReady } from "../config.js";
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
}

export interface OrderResult {
  ok: boolean;
  filledPrice: number;
  size: number;
  orderId?: string;
  simulated: boolean;
  error?: string;
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
    } else {
      log.warn(
        `Hyperliquid connector in ${config.tradingEnv} mode (no signing) — orders are simulated.`,
      );
    }
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

  private async setLeverage(
    asset: AssetInfo,
    leverage: number,
    marginMode: "cross" | "isolated",
  ): Promise<void> {
    if (!this.exchange) return;
    const capped = Math.max(1, Math.min(leverage, asset.maxLeverage));
    await this.exchange.updateLeverage({
      asset: asset.index,
      isCross: marginMode === "cross",
      leverage: Math.round(capped),
    });
  }

  /** Place a market order (implemented as an aggressive IOC limit). */
  async placeMarketOrder(req: OrderRequest): Promise<OrderResult> {
    const asset = await this.getAsset(req.symbol);
    if (!asset) {
      return { ok: false, filledPrice: 0, size: 0, simulated: !this.live, error: `Unknown symbol ${req.symbol}` };
    }
    const mid = await this.getMidPrice(req.symbol);
    if (!mid || mid <= 0) {
      return { ok: false, filledPrice: 0, size: 0, simulated: !this.live, error: `No price for ${req.symbol}` };
    }

    const isBuy = req.side === "long";
    const size = roundSize(req.notionalUsd / mid, asset.szDecimals);
    if (size <= 0) {
      return { ok: false, filledPrice: mid, size: 0, simulated: !this.live, error: "Computed size is 0" };
    }
    // Aggressive limit price so the IOC order crosses the book.
    const slip = req.maxSlippage;
    const limitPx = roundPx(mid * (isBuy ? 1 + slip : 1 - slip), asset.szDecimals);

    if (!this.live || !this.exchange) {
      // Paper / unsigned: simulate a fill at mid.
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
            r: false,
            t: { limit: { tif: "Ioc" } },
          },
        ],
        grouping: "na",
      })) as unknown as HlOrderResponse;

      const parsed = parseOrderResponse(result, limitPx);
      return { ...parsed, size, simulated: false };
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
}

/* --------------------------- response parsing --------------------------- */

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

function parseOrderResponse(res: HlOrderResponse, fallbackPx: number): Omit<OrderResult, "size" | "simulated"> {
  const statuses = res.response?.data?.statuses ?? [];
  for (const s of statuses) {
    if ("filled" in s) {
      return { ok: true, filledPrice: Number(s.filled.avgPx), orderId: String(s.filled.oid) };
    }
    if ("resting" in s) {
      // IOC that didn't fill immediately (unlikely with slippage buffer).
      return { ok: true, filledPrice: fallbackPx, orderId: String(s.resting.oid) };
    }
    if ("error" in s) {
      return { ok: false, filledPrice: fallbackPx, error: s.error };
    }
  }
  const ok = res.status === "ok";
  return { ok, filledPrice: fallbackPx, error: ok ? undefined : `Unexpected response: ${res.status}` };
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
  const maxDecimals = Math.max(0, 6 - szDecimals);
  // 5 significant figures
  const sig = Number(px.toPrecision(5));
  const factor = 10 ** maxDecimals;
  return Math.round(sig * factor) / factor;
}

export const hyperliquid = new HyperliquidConnector();
