import type { ExchangeName } from "@tttrading/shared";
import { config } from "../config.js";
import { mexcBaseUrl, mexcEnabled } from "./credentials.js";
import { log } from "../logger.js";
import type {
  AccountSummary,
  AssetInfo,
  BracketParams,
  BracketResult,
  ExchangeConnector,
  FillLite,
  LimitOrderRequest,
  LimitOrderResult,
  OrderRequest,
  OrderResult,
  Position,
} from "./types.js";

interface MexcAsset extends AssetInfo {
  /** Full venue symbol, e.g. "BTC_USDT". */
  mexcSymbol: string;
  /** Coins per contract — MEXC sizes orders in CONTRACTS, not coin units. */
  contractSize: number;
}

interface ContractDetail {
  symbol: string;
  baseCoin?: string;
  quoteCoin?: string;
  contractSize?: number;
  maxLeverage?: number;
  priceScale?: number;
  volScale?: number;
}

/**
 * MEXC (mexc.com) USDⓈ-M contract connector — the LAST backup, after Aster.
 *
 * IMPORTANT: real order execution is intentionally NOT enabled. MEXC's contract
 * API sizes orders in contracts (not coin units), uses numeric side codes and an
 * entry-attached SL/TP model that doesn't fit this desk's post-fill bracket
 * architecture, and its futures order API only reopened in Jan 2026 with no
 * public testnet to validate against. So this connector provides ROUTING +
 * MARKET DATA + SIMULATION only: a MEXC-only coin is caught and tracked (as a
 * simulated trade the monitor resolves against MEXC's live price) instead of
 * hard-failing. `live` is always false, so the engine/monitor never send real
 * orders here. Real sending is a separate, validated follow-up.
 */
export class MexcConnector implements ExchangeConnector {
  readonly name: ExchangeName = "mexc";
  readonly live = false; // market-data + simulation only (see class doc)
  private assets = new Map<string, MexcAsset>();
  private assetsLoadedAt = 0;

  constructor() {
    if (mexcEnabled()) {
      log.info(`MEXC connector in routing/market-data/sim mode (${mexcBaseUrl()}) — orders simulated.`);
    }
  }

  /** Base host, read live so a desk change applies without a restart. */
  private get base(): string {
    return mexcBaseUrl();
  }

  simulating(): boolean {
    return true;
  }

  private async pub<T>(path: string, query?: Record<string, string | number>): Promise<T> {
    const qs = query
      ? "?" + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()
      : "";
    const res = await fetch(`${this.base}${path}${qs}`);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`MEXC ${res.status}: ${text.slice(0, 200)}`);
    }
    const wrap = json as { success?: boolean; code?: number; data?: unknown; message?: string };
    if (wrap.success === false || (typeof wrap.code === "number" && wrap.code !== 0 && wrap.code !== 200)) {
      throw new Error(`MEXC ${wrap.code}: ${wrap.message ?? "error"}`);
    }
    if (!res.ok) throw new Error(`MEXC HTTP ${res.status}`);
    return (wrap.data ?? json) as T;
  }

  private async loadAssets(force = false): Promise<Map<string, MexcAsset>> {
    if (!force && this.assets.size > 0 && Date.now() - this.assetsLoadedAt < 300_000) {
      return this.assets;
    }
    const data = await this.pub<ContractDetail[]>("/api/v1/contract/detail");
    const next = new Map<string, MexcAsset>();
    for (const c of Array.isArray(data) ? data : []) {
      if (c.quoteCoin && c.quoteCoin.toUpperCase() !== "USDT") continue;
      const coin = (c.baseCoin ?? c.symbol.split("_")[0] ?? "").toUpperCase();
      if (!coin) continue;
      next.set(coin, {
        name: coin,
        index: 0,
        szDecimals: Math.min(8, Math.max(0, c.volScale ?? 4)),
        maxLeverage: c.maxLeverage ?? config.mexc.defaultMaxLeverage,
        mexcSymbol: c.symbol,
        contractSize: c.contractSize && c.contractSize > 0 ? c.contractSize : 1,
      });
    }
    if (next.size > 0) {
      this.assets = next;
      this.assetsLoadedAt = Date.now();
    }
    return this.assets;
  }

  private async resolve(symbol: string): Promise<MexcAsset | undefined> {
    await this.loadAssets();
    return this.assets.get(symbol.toUpperCase());
  }

  async getAsset(symbol: string): Promise<AssetInfo | undefined> {
    return this.resolve(symbol);
  }

  async getMidPrice(symbol: string): Promise<number | undefined> {
    const asset = await this.resolve(symbol);
    if (!asset) return undefined;
    const t = await this.pub<{ lastPrice?: number; bid1?: number; ask1?: number; fairPrice?: number }>(
      "/api/v1/contract/ticker",
      { symbol: asset.mexcSymbol },
    );
    const bid = Number(t.bid1);
    const ask = Number(t.ask1);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) return (bid + ask) / 2;
    for (const cand of [t.fairPrice, t.lastPrice]) {
      const n = Number(cand);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return undefined;
  }

  async getAllMids(): Promise<Record<string, number>> {
    await this.loadAssets();
    const bySymbol = new Map<string, string>();
    for (const a of this.assets.values()) bySymbol.set(a.mexcSymbol, a.name);
    const rows = await this.pub<
      { symbol: string; lastPrice?: number; fairPrice?: number; bid1?: number; ask1?: number }[]
    >("/api/v1/contract/ticker");
    const out: Record<string, number> = {};
    for (const r of Array.isArray(rows) ? rows : []) {
      const coin = bySymbol.get(r.symbol);
      if (!coin) continue;
      const bid = Number(r.bid1);
      const ask = Number(r.ask1);
      const mid =
        Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
          ? (bid + ask) / 2
          : Number(r.fairPrice) || Number(r.lastPrice);
      if (Number.isFinite(mid) && mid > 0) out[coin] = mid;
    }
    return out;
  }

  // --- Not live: reads return empty, orders simulate against the live price. ---

  async getPositions(): Promise<Position[]> {
    return [];
  }

  async getAccountSummary(): Promise<AccountSummary | null> {
    return null;
  }

  async getRecentFills(): Promise<FillLite[]> {
    return [];
  }

  async getOpenOrderIds(): Promise<Set<string>> {
    return new Set();
  }

  async placeMarketOrder(req: OrderRequest): Promise<OrderResult> {
    let asset: MexcAsset | undefined;
    let mid: number | undefined;
    try {
      asset = await this.resolve(req.symbol);
      if (asset) mid = await this.getMidPrice(req.symbol);
    } catch (err) {
      return { ok: false, filledPrice: 0, size: 0, simulated: true, error: `Price feed error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!asset) return { ok: false, filledPrice: 0, size: 0, simulated: true, error: `Unknown symbol ${req.symbol}` };
    if (!mid || mid <= 0) return { ok: false, filledPrice: 0, size: 0, simulated: true, error: `No price for ${req.symbol}` };
    const size = floorTo(req.notionalUsd / mid, asset.szDecimals);
    if (size <= 0) return { ok: false, filledPrice: mid, size: 0, simulated: true, error: "Computed size is 0" };
    return { ok: true, filledPrice: mid, size, simulated: true };
  }

  async placeLimitOrder(req: LimitOrderRequest): Promise<LimitOrderResult> {
    let asset: MexcAsset | undefined;
    try {
      asset = await this.resolve(req.symbol);
    } catch (err) {
      return { ok: false, size: 0, simulated: true, error: `Price feed error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!asset) return { ok: false, size: 0, simulated: true, error: `Unknown symbol ${req.symbol}` };
    if (!(req.price > 0)) return { ok: false, size: 0, simulated: true, error: "Invalid limit price" };
    const size = floorTo(req.notionalUsd / req.price, asset.szDecimals);
    if (size <= 0) return { ok: false, size: 0, simulated: true, error: "Computed size is 0" };
    return { ok: true, status: "resting", size, simulated: true };
  }

  async placeBracketOrders(_params: BracketParams): Promise<BracketResult> {
    return { tpOrderIds: [], protectedOnExchange: false };
  }

  async cancelOrders(): Promise<void> {
    /* nothing real to cancel — simulated brackets are enforced by the monitor */
  }
}

function floorTo(value: number, decimals: number): number {
  if (!(value > 0)) return 0;
  const f = 10 ** Math.max(0, Math.min(12, decimals));
  return Math.floor(value * f) / f;
}

export const mexc = new MexcConnector();
