import crypto from "node:crypto";
import type { ExchangeName, TradeSide } from "@tttrading/shared";
import { config } from "../config.js";
import { settings } from "../db/repositories.js";
import { mexcApiKey, mexcApiSecret, mexcBaseUrl, mexcEnabled, mexcReady } from "./credentials.js";
import { log } from "../logger.js";
import { canonicalSymbol, symbolAliases } from "../symbols.js";
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
  /** Coins (base asset) per 1 contract — MEXC sizes orders in CONTRACTS. */
  contractSize: number;
  priceScale: number;
  volScale: number;
  priceUnit: number;
  volUnit: number;
  minVol: number;
}

interface ContractDetail {
  symbol: string;
  baseCoin?: string;
  quoteCoin?: string;
  contractSize?: number;
  maxLeverage?: number;
  priceScale?: number;
  volScale?: number;
  priceUnit?: number;
  volUnit?: number;
  minVol?: number;
}

/** Absolute per-order notional ceiling — a backstop against a bad size conversion. */
const MAX_ORDER_NOTIONAL = 10_000_000;

/**
 * MEXC (mexc.com) USDⓈ-M contract connector — the last backup, after Aster.
 *
 * MEXC's contract API differs from the Binance-style venues in three ways this
 * connector handles carefully:
 *  - orders are sized in CONTRACTS: coins = vol × contractSize (per symbol);
 *  - order side is a numeric code (1 open long / 2 close short / 3 open short /
 *    4 close long) — we never send reduceOnly, the close codes ARE the close;
 *  - signing is `HMAC_SHA256(secret, accessKey + timestamp + paramString)` with
 *    ApiKey / Request-Time / Signature headers (sorted query for GET, raw JSON
 *    body for POST).
 *
 * Same safety model as the other venues: reads market data without keys (routing
 * + simulation), and only sends real orders with a key+secret AND the global
 * test switch off. MEXC has NO public testnet — validate live with minimum size.
 * SL/TP are placed as reduce-only trigger (plan) orders; if that placement is
 * rejected the entry still opens (unprotected, surfaced) — verify on first use.
 */
export class MexcConnector implements ExchangeConnector {
  readonly name: ExchangeName = "mexc";
  private assets = new Map<string, MexcAsset>();
  private assetsLoadedAt = 0;

  constructor() {
    if (mexcEnabled()) {
      log.info(
        mexcReady()
          ? `MEXC connector LIVE (${mexcBaseUrl()}). No testnet — validate with minimum size.`
          : `MEXC connector in market-data/sim mode (${mexcBaseUrl()}) — no API key, orders simulated.`,
      );
    }
  }

  private get base(): string {
    return mexcBaseUrl();
  }

  get live(): boolean {
    return mexcReady();
  }

  simulating(): boolean {
    return settings.getShadowMode() || !this.live;
  }

  /* ------------------------------ HTTP core ------------------------------ */

  private async pub<T>(path: string, query?: Record<string, string | number>): Promise<T> {
    const qs = query
      ? "?" + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()
      : "";
    const res = await fetch(`${this.base}${path}${qs}`);
    return this.parse<T>(res);
  }

  private async signed<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: unknown = {},
  ): Promise<T> {
    const key = mexcApiKey();
    const secret = mexcApiSecret();
    if (!key || !secret) throw new Error("MEXC API key/secret not configured");
    const ts = String(Date.now());
    let url = `${this.base}${path}`;
    let body: string | undefined;
    let paramString: string;
    if (method === "GET" || method === "DELETE") {
      // Sorted key=value&… — the exact string signed AND appended to the URL.
      const entries = Object.entries((params ?? {}) as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      paramString = entries.map(([k, v]) => `${k}=${String(v)}`).join("&");
      if (paramString) url += `?${paramString}`;
    } else {
      // POST: sign the raw JSON body EXACTLY as transmitted.
      body = JSON.stringify(params);
      paramString = body;
    }
    const signature = crypto.createHmac("sha256", secret).update(key + ts + paramString).digest("hex");
    const headers: Record<string, string> = {
      ApiKey: key,
      "Request-Time": ts,
      Signature: signature,
    };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(url, { method, headers, body });
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let json: unknown;
    try {
      // MEXC returns 16+ digit order/deal ids UNQUOTED; JSON.parse would round
      // them past JS's safe-integer range and corrupt the id. Quote them first so
      // they survive as exact strings (cancellation & fill-matching depend on it).
      const safe = text.replace(/"(orderId|dealId|id)":\s*(\d{16,})/g, '"$1":"$2"');
      json = text ? JSON.parse(safe) : {};
    } catch {
      throw new Error(`MEXC ${res.status}: ${text.slice(0, 200)}`);
    }
    const wrap = json as { success?: boolean; code?: number; data?: unknown; message?: string; msg?: string };
    if (wrap.success === false || (typeof wrap.code === "number" && wrap.code !== 0 && wrap.code !== 200)) {
      throw new Error(`MEXC ${wrap.code}: ${wrap.message ?? wrap.msg ?? "error"}`);
    }
    if (!res.ok) throw new Error(`MEXC HTTP ${res.status}: ${text.slice(0, 200)}`);
    return (wrap.data ?? json) as T;
  }

  /* ------------------------------ metadata ------------------------------- */

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
        szDecimals: Math.min(8, Math.max(0, c.volScale ?? 0)),
        maxLeverage: c.maxLeverage ?? config.mexc.defaultMaxLeverage,
        mexcSymbol: c.symbol,
        contractSize: c.contractSize && c.contractSize > 0 ? c.contractSize : 1,
        priceScale: c.priceScale ?? 2,
        volScale: c.volScale ?? 0,
        priceUnit: c.priceUnit && c.priceUnit > 0 ? c.priceUnit : 0,
        volUnit: c.volUnit && c.volUnit > 0 ? c.volUnit : 1,
        minVol: c.minVol && c.minVol > 0 ? c.minVol : 1,
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
    for (const s of symbolAliases(symbol)) {
      const a = this.assets.get(s);
      if (a) return a;
    }
    return undefined;
  }

  async getAsset(symbol: string): Promise<AssetInfo | undefined> {
    return this.resolve(symbol);
  }

  /* ---------------------------- market data ------------------------------ */

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
      // Canonical key so the price ticker's canonical "want" set matches aliases.
      if (Number.isFinite(mid) && mid > 0) out[canonicalSymbol(coin)] = mid;
    }
    return out;
  }

  async getPositions(): Promise<Position[]> {
    if (!this.live) return [];
    await this.loadAssets();
    const bySymbol = new Map<string, MexcAsset>();
    for (const a of this.assets.values()) bySymbol.set(a.mexcSymbol, a);
    const rows = await this.signed<
      { symbol: string; holdVol: number; positionType: number; holdAvgPrice: number; leverage: number }[]
    >("GET", "/api/v1/private/position/open_positions");
    return (Array.isArray(rows) ? rows : [])
      .map((p) => {
        const asset = bySymbol.get(p.symbol);
        const cs = asset?.contractSize ?? 1;
        const coins = Number(p.holdVol) * cs;
        const signed = p.positionType === 2 ? -coins : coins; // 1=long, 2=short
        return {
          symbol: canonicalSymbol(asset?.name ?? p.symbol),
          size: signed,
          entryPrice: Number(p.holdAvgPrice),
          unrealizedPnl: 0,
          leverage: Number(p.leverage) || 0,
        };
      })
      .filter((p) => Number.isFinite(p.size) && p.size !== 0);
  }

  async getAccountSummary(): Promise<AccountSummary | null> {
    if (!this.live) return null;
    const rows = await this.signed<
      { currency: string; availableBalance?: number; equity?: number; positionMargin?: number }[]
    >("GET", "/api/v1/private/account/assets");
    const usdt = (Array.isArray(rows) ? rows : []).find((r) => r.currency?.toUpperCase() === "USDT");
    if (!usdt) return { address: "mexc", accountValue: 0, withdrawable: 0, totalMarginUsed: 0 };
    return {
      address: "mexc",
      accountValue: Number(usdt.equity ?? 0),
      withdrawable: Number(usdt.availableBalance ?? 0),
      totalMarginUsed: Number(usdt.positionMargin ?? 0),
    };
  }

  async getRecentFills(symbols?: string[]): Promise<FillLite[]> {
    if (!this.live) return [];
    const coins = [...new Set((symbols ?? []).map((s) => s.toUpperCase()))];
    if (coins.length === 0) return [];
    const out: FillLite[] = [];
    for (const coin of coins) {
      const asset = await this.resolve(coin);
      if (!asset) continue;
      try {
        const rows = await this.signed<
          { orderId: number | string; vol: number; price: number; side: number; profit?: number; fee?: number; timestamp?: number }[]
        >("GET", "/api/v1/private/order/list/order_deals", { symbol: asset.mexcSymbol, page_size: 100 });
        for (const r of Array.isArray(rows) ? rows : []) {
          out.push({
            oid: String(r.orderId),
            symbol: coin,
            size: Math.abs(Number(r.vol)) * asset.contractSize, // contracts → coins
            price: Number(r.price),
            side: r.side === 1 || r.side === 2 ? "B" : "A", // 1/2 buy, 3/4 sell
            closedPnl: Number(r.profit ?? 0),
            fee: Number(r.fee ?? 0),
            time: Number(r.timestamp ?? 0),
          });
        }
      } catch (err) {
        log.warn(`MEXC order_deals ${coin}:`, err instanceof Error ? err.message : err);
      }
    }
    return out;
  }

  async getOpenOrderIds(): Promise<Set<string>> {
    if (!this.live) return new Set();
    // Throws on failure so the monitor treats "open orders unknown" as undefined
    // (rather than wrongly concluding a resting order vanished).
    const rows = await this.signed<{ orderId: number | string }[]>(
      "GET",
      "/api/v1/private/order/list/open_orders",
    );
    return new Set((Array.isArray(rows) ? rows : []).map((o) => String(o.orderId)));
  }

  /* ------------------------------- orders -------------------------------- */

  private async setLeverage(asset: MexcAsset, leverage: number, marginMode: "cross" | "isolated", side: TradeSide): Promise<number> {
    const capped = Math.max(1, Math.floor(Math.min(leverage, asset.maxLeverage)));
    try {
      await this.signed("POST", "/api/v1/private/position/change_leverage", {
        symbol: asset.mexcSymbol,
        leverage: capped,
        openType: marginMode === "cross" ? 2 : 1,
        positionType: side === "long" ? 1 : 2,
      });
    } catch (err) {
      log.warn(`MEXC setLeverage ${asset.name}:`, err instanceof Error ? err.message : err);
    }
    // Return the leverage the venue will actually apply (clamped to the pair's
    // max) so the trade is recorded at the real leverage, not the requested one.
    return capped;
  }

  /** Actual filled price & coin size for an order (best-effort from its deals). */
  private async orderFill(asset: MexcAsset, orderId: string): Promise<{ price: number; coins: number } | undefined> {
    try {
      const deals = await this.signed<{ vol: number; price: number }[]>(
        "GET",
        `/api/v1/private/order/deal_details/${orderId}`,
      );
      const arr = Array.isArray(deals) ? deals : [];
      let vol = 0;
      let notional = 0;
      for (const d of arr) {
        const v = Number(d.vol);
        const p = Number(d.price);
        if (v > 0 && p > 0) {
          vol += v;
          notional += v * p;
        }
      }
      if (vol > 0) return { price: notional / vol, coins: vol * asset.contractSize };
    } catch {
      /* best-effort */
    }
    return undefined;
  }

  async placeMarketOrder(req: OrderRequest): Promise<OrderResult> {
    let asset: MexcAsset | undefined;
    let mid: number | undefined;
    try {
      asset = await this.resolve(req.symbol);
      if (asset) mid = await this.getMidPrice(req.symbol);
    } catch (err) {
      return { ok: false, filledPrice: 0, size: 0, simulated: !this.live, error: `Price feed error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!asset) return { ok: false, filledPrice: 0, size: 0, simulated: !this.live, error: `Unknown symbol ${req.symbol}` };
    if (!mid || mid <= 0) return { ok: false, filledPrice: 0, size: 0, simulated: !this.live, error: `No price for ${req.symbol}` };

    const vol = coinsToVol(req.notionalUsd / mid, asset);
    const coinSize = vol * asset.contractSize;
    if (!(vol > 0) || (!req.reduceOnly && vol < asset.minVol)) {
      return { ok: false, filledPrice: mid, size: 0, simulated: !this.live, error: "Computed size below MEXC minimum" };
    }
    if (coinSize * mid > MAX_ORDER_NOTIONAL) {
      return { ok: false, filledPrice: mid, size: 0, simulated: !this.live, error: "Order notional exceeds safety cap" };
    }

    const forceReal = !!req.force && !!req.reduceOnly;
    if (this.simulating() && !forceReal) {
      return { ok: true, filledPrice: mid, size: coinSize, simulated: true };
    }

    try {
      let effLev = req.leverage;
      if (!req.reduceOnly) effLev = await this.setLeverage(asset, req.leverage, req.marginMode, req.side);
      // Close codes (2/4) ARE reduce-only; open codes (1/3) open. We never send a
      // reduceOnly flag (it's one-way-mode only) — the side code carries intent.
      const side = mexcSide(req.side, !!req.reduceOnly);
      const body: Record<string, unknown> = {
        symbol: asset.mexcSymbol,
        price: roundToUnit(mid, asset.priceUnit, asset.priceScale), // ballpark; market ignores/uses as guard
        vol,
        side,
        type: 5, // market
        openType: req.marginMode === "cross" ? 2 : 1,
      };
      if (!req.reduceOnly) body.leverage = Math.max(1, Math.floor(Math.min(req.leverage, asset.maxLeverage)));
      const data = await this.signed<{ orderId: number | string } | number | string>(
        "POST",
        "/api/v1/private/order/create",
        body,
      );
      const orderId = orderIdOf(data);
      if (!orderId) return { ok: false, filledPrice: mid, size: 0, simulated: false, error: "no orderId in response" };
      const fill = await this.orderFill(asset, orderId);
      return {
        ok: true,
        filledPrice: fill?.price && fill.price > 0 ? fill.price : mid,
        size: fill?.coins && fill.coins > 0 ? fill.coins : coinSize,
        orderId,
        simulated: false,
        effectiveLeverage: req.reduceOnly ? undefined : effLev,
      };
    } catch (err) {
      return { ok: false, filledPrice: mid, size: 0, simulated: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async placeLimitOrder(req: LimitOrderRequest): Promise<LimitOrderResult> {
    const sim = this.simulating();
    let asset: MexcAsset | undefined;
    try {
      asset = await this.resolve(req.symbol);
    } catch (err) {
      return { ok: false, size: 0, simulated: sim, error: `Price feed error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!asset) return { ok: false, size: 0, simulated: sim, error: `Unknown symbol ${req.symbol}` };
    if (!(req.price > 0)) return { ok: false, size: 0, simulated: sim, error: "Invalid limit price" };

    const vol = coinsToVol(req.notionalUsd / req.price, asset);
    const coinSize = vol * asset.contractSize;
    if (!(vol > 0) || vol < asset.minVol) return { ok: false, size: 0, simulated: sim, error: "Computed size below MEXC minimum" };
    if (coinSize * req.price > MAX_ORDER_NOTIONAL) return { ok: false, size: 0, simulated: sim, error: "Order notional exceeds safety cap" };
    const limitPx = roundToUnit(req.price, asset.priceUnit, asset.priceScale, req.side === "long" ? "floor" : "ceil");

    if (sim) return { ok: true, status: "resting", size: coinSize, simulated: true };

    try {
      const effLev = await this.setLeverage(asset, req.leverage, req.marginMode, req.side);
      const data = await this.signed<{ orderId: number | string } | number | string>(
        "POST",
        "/api/v1/private/order/create",
        {
          symbol: asset.mexcSymbol,
          price: limitPx,
          vol,
          side: mexcSide(req.side, false),
          type: 1, // limit (GTC)
          openType: req.marginMode === "cross" ? 2 : 1,
          leverage: Math.max(1, Math.floor(Math.min(req.leverage, asset.maxLeverage))),
        },
      );
      const orderId = orderIdOf(data);
      if (!orderId) return { ok: false, size: 0, simulated: false, error: "no orderId in response" };
      // Treated as resting; the monitor promotes it from real fills.
      return { ok: true, status: "resting", orderId, size: coinSize, simulated: false, effectiveLeverage: effLev };
    } catch (err) {
      return { ok: false, size: 0, simulated: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async placeBracketOrders(params: BracketParams): Promise<BracketResult> {
    const { symbol, side, size, stopLoss, takeProfits, force } = params;
    const tps = takeProfits ?? [];
    if (stopLoss === undefined && tps.length === 0) return { tpOrderIds: [], protectedOnExchange: false };
    if (this.simulating() && !force) return { tpOrderIds: [], protectedOnExchange: false };

    let asset: MexcAsset | undefined;
    try {
      asset = await this.resolve(symbol);
    } catch (err) {
      return { tpOrderIds: [], protectedOnExchange: false, error: `Price feed error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!asset) return { tpOrderIds: [], protectedOnExchange: false, error: `Unknown symbol ${symbol}` };

    // Close side codes: long position → 4 (close long); short → 2 (close short).
    const closeSide = side === "long" ? 4 : 2;
    const openType = params.marginMode === "isolated" ? 1 : 2;
    let slOrderId: string | undefined;
    const tpOrderIds: string[] = [];
    let error: string | undefined;

    const plan = async (triggerPrice: number, triggerType: number, vol: number) => {
      const data = await this.signed<{ orderId: number | string } | number | string>(
        "POST",
        "/api/v1/private/planorder/place",
        {
          symbol: asset!.mexcSymbol,
          triggerPrice: roundToUnit(triggerPrice, asset!.priceUnit, asset!.priceScale),
          triggerType, // 1 = ≥, 2 = ≤
          trend: 2, // fair (mark) price
          orderType: 5, // market on trigger
          side: closeSide,
          vol,
          openType, // match the position's margin mode
        },
      );
      return orderIdOf(data);
    };

    if (stopLoss !== undefined) {
      // Long stops trigger when price falls (≤); short stops when it rises (≥).
      try {
        slOrderId = await plan(stopLoss, side === "long" ? 2 : 1, coinsToVol(size, asset));
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    if (tps.length > 0) {
      let remaining = coinsToVol(size, asset);
      for (let i = 0; i < tps.length; i++) {
        const isLast = i === tps.length - 1;
        const chunk = isLast ? remaining : stepFloor(coinsToVol(size, asset) / tps.length, asset.volUnit);
        remaining = Math.max(0, remaining - chunk);
        if (chunk <= 0) continue;
        try {
          // Long TPs trigger when price rises (≥); short TPs when it falls (≤).
          const id = await plan(tps[i]!, side === "long" ? 1 : 2, chunk);
          if (id) tpOrderIds.push(id);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      }
    }

    // A REQUESTED stop that produced no order id (thrown OR a silent null from
    // the plan endpoint) leaves the position naked even if a TP rested — report
    // it explicitly and never mask it as "protected".
    const stopMissing = stopLoss !== undefined && slOrderId === undefined;
    const protectedOnExchange = !stopMissing && (slOrderId !== undefined || tpOrderIds.length > 0);
    return {
      slOrderId,
      tpOrderIds,
      protectedOnExchange,
      stopMissing,
      error: stopMissing
        ? `Stop-loss REJECTED at entry — position unprotected${error ? `: ${error}` : ""}`
        : protectedOnExchange
          ? undefined
          : error,
    };
  }

  async cancelOrders(symbol: string, orderIds: string[]): Promise<void> {
    if (!this.live || orderIds.length === 0) return;
    const asset = await this.resolve(symbol);
    if (!asset) return;
    // Pass ids through as EXACT STRINGS — MEXC order ids exceed JS's safe integer
    // range, so Number() would corrupt them and cancel the wrong (non-existent) id.
    // An id may be a normal order or a trigger (plan) order — try both endpoints,
    // ignoring "unknown order" errors, so whichever it is gets cancelled.
    try {
      await this.signed("POST", "/api/v1/private/order/cancel", orderIds);
    } catch (err) {
      log.warn(`MEXC cancel(order) ${symbol}:`, err instanceof Error ? err.message : err);
    }
    try {
      await this.signed(
        "POST",
        "/api/v1/private/planorder/cancel",
        orderIds.map((o) => ({ symbol: asset.mexcSymbol, orderId: o })),
      );
    } catch {
      /* best-effort — it wasn't a plan order */
    }
  }
}

/* ------------------------------ helpers -------------------------------- */

/** Map (side, reduceOnly) to MEXC's numeric code. Close codes are reduce-only. */
function mexcSide(side: TradeSide, reduceOnly: boolean): number {
  if (!reduceOnly) return side === "long" ? 1 : 3; // open long / open short
  // A reduce-only close is called with the OPPOSITE side by the engine:
  // closing a long → side "short" → 4; closing a short → side "long" → 2.
  return side === "short" ? 4 : 2;
}

/** Coin size → whole contracts, floored to the venue's volUnit step. */
function coinsToVol(coinSize: number, asset: MexcAsset): number {
  if (!(coinSize > 0) || !(asset.contractSize > 0)) return 0;
  return stepFloor(coinSize / asset.contractSize, asset.volUnit);
}

function stepFloor(value: number, step: number): number {
  if (!(value > 0)) return 0;
  if (step > 0) return Math.floor(value / step + 1e-9) * step;
  return Math.floor(value);
}

/** Round a price to the venue's tick (priceUnit) + scale, directionally. */
function roundToUnit(px: number, unit: number, scale: number, mode: "floor" | "ceil" | "round" = "round"): number {
  if (!(px > 0)) return px;
  if (unit > 0) {
    const n = px / unit;
    const r = mode === "floor" ? Math.floor(n + 1e-9) : mode === "ceil" ? Math.ceil(n - 1e-9) : Math.round(n);
    return Number((r * unit).toFixed(Math.max(0, Math.min(12, scale))));
  }
  const f = 10 ** Math.max(0, Math.min(12, scale));
  return Math.round(px * f) / f;
}

function orderIdOf(data: unknown): string | undefined {
  if (data == null) return undefined;
  if (typeof data === "number" || typeof data === "string") return String(data);
  if (typeof data === "object" && "orderId" in data) {
    const id = (data as { orderId: unknown }).orderId;
    return id == null ? undefined : String(id);
  }
  return undefined;
}

export const mexc = new MexcConnector();
