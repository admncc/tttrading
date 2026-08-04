import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { ExchangeName } from "@tttrading/shared";
import { config } from "../config.js";
import { settings } from "../db/repositories.js";
import { asterUser, asterSigner, asterPrivateKey, asterBaseUrl, asterEnabled, asterReady } from "./credentials.js";
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

/** Per-asset trading rules resolved from Aster's exchangeInfo. */
interface AsterAsset extends AssetInfo {
  /** Full venue symbol, e.g. "BTCUSDT". */
  asterSymbol: string;
  pricePrecision: number;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

interface ExchangeInfoSymbol {
  symbol: string;
  contractType?: string;
  status?: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  filters: { filterType: string; [k: string]: unknown }[];
}

/**
 * Aster (asterdex.com) USDⓈ-M futures connector, V3 API. Endpoints are all
 * under `/fapi/v3/*`. Public market data needs no auth; SIGNED requests use
 * Aster's V3 EIP-712 scheme (no API-key header): business params + nonce + user
 * + signer are urlencoded and signed with the API-wallet private key, and the
 * signature is appended. Only signs/sends orders when the API wallet is
 * configured and the global test switch is off — mirroring the HL connector.
 */
export class AsterConnector implements ExchangeConnector {
  readonly name: ExchangeName = "aster";
  private assets = new Map<string, AsterAsset>();
  private assetsLoadedAt = 0;
  private signerAccount?: PrivateKeyAccount;
  private signerKey = "";
  private lastNonceMs = 0;
  private nonceCounter = 0;

  constructor() {
    if (asterEnabled()) {
      log.info(
        asterReady()
          ? `Aster connector LIVE (${asterBaseUrl()}).`
          : `Aster connector in market-data/sim mode (${asterBaseUrl()}) — no API key, orders simulated.`,
      );
    }
  }

  /** Base host, read live so a desk change (Settings → Exchanges) applies at once. */
  private get base(): string {
    return asterBaseUrl();
  }

  /** True when a key+secret are configured (desk or env) and not in paper mode. */
  get live(): boolean {
    return asterReady();
  }

  simulating(): boolean {
    return settings.getShadowMode() || !this.live;
  }

  /* ------------------------------ HTTP core ------------------------------ */

  private async pub<T>(path: string, query?: Record<string, string | number>): Promise<T> {
    const qs = query
      ? "?" + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()
      : "";
    const res = await fetch(`${this.base}${path}${qs}`, {
      headers: { "User-Agent": "ttdesk/1.0" },
    });
    return this.parse<T>(res);
  }

  /** EIP-712 domain for V3 signing (chainId differs by network). */
  private domain() {
    const testnet = this.base.includes("testnet");
    return {
      name: "AsterSignTransaction",
      version: "1",
      chainId: testnet ? 714 : 1666,
      verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    } as const;
  }

  /** (Re)build the signing account when the desk-configured private key changes. */
  private ensureSigner(): PrivateKeyAccount | undefined {
    const pk = asterPrivateKey();
    if (!pk) {
      this.signerAccount = undefined;
      this.signerKey = "";
      return undefined;
    }
    if (this.signerAccount && this.signerKey === pk) return this.signerAccount;
    try {
      const norm = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
      this.signerAccount = privateKeyToAccount(norm);
      this.signerKey = pk;
    } catch (err) {
      log.error("Aster: invalid API-wallet private key:", err instanceof Error ? err.message : err);
      this.signerAccount = undefined;
      this.signerKey = "";
    }
    return this.signerAccount;
  }

  /** Strictly-increasing microsecond nonce (monotonic even across clock steps). */
  private lastNonce = 0;
  private nextNonce(): string {
    const ms = Date.now();
    if (ms === this.lastNonceMs) this.nonceCounter++;
    else {
      this.lastNonceMs = ms;
      this.nonceCounter = 0;
    }
    // Never emit a value ≤ the last one (guards a backward clock step or the
    // counter overflowing past 1000 within a single millisecond).
    const n = Math.max(ms * 1000 + this.nonceCounter, this.lastNonce + 1);
    this.lastNonce = n;
    return String(n);
  }

  /**
   * V3 SIGNED request — EIP-712 signature auth (no API-key header). Business
   * params + nonce + user + signer are urlencoded in insertion order, signed
   * with the API-wallet private key, and the 0x signature is appended (never
   * itself signed). GET → query string; POST/DELETE → form-urlencoded body.
   */
  private async signed<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<T> {
    const account = this.ensureSigner();
    const signerAddr = asterSigner();
    if (!account || !signerAddr) {
      throw new Error("Aster API wallet not configured (need signer address + private key)");
    }
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) body[k] = String(v);
    body.nonce = this.nextNonce();
    const user = asterUser();
    if (user) body.user = user;
    body.signer = signerAddr;
    const msg = new URLSearchParams(body).toString();
    const signature = await account.signTypedData({
      domain: this.domain(),
      types: { Message: [{ name: "msg", type: "string" }] },
      primaryType: "Message",
      message: { msg },
    });
    const signedBody = new URLSearchParams({ ...body, signature }).toString();
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "ttdesk/1.0",
    };
    const res =
      method === "GET"
        ? await fetch(`${this.base}${path}?${signedBody}`, { method, headers })
        : await fetch(`${this.base}${path}`, { method, headers, body: signedBody });
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Aster ${res.status}: ${text.slice(0, 200)}`);
    }
    // Binance-style error payloads: { code: <negative>, msg: "..." }.
    if (
      json &&
      typeof json === "object" &&
      "code" in json &&
      typeof (json as { code: unknown }).code === "number" &&
      (json as { code: number }).code < 0
    ) {
      const j = json as { code: number; msg?: string };
      throw new Error(`Aster ${j.code}: ${j.msg ?? "error"}`);
    }
    if (!res.ok) throw new Error(`Aster HTTP ${res.status}: ${text.slice(0, 200)}`);
    return json as T;
  }

  /* ------------------------------ metadata ------------------------------- */

  private async loadAssets(force = false): Promise<Map<string, AsterAsset>> {
    if (!force && this.assets.size > 0 && Date.now() - this.assetsLoadedAt < 300_000) {
      return this.assets;
    }
    const info = await this.pub<{ symbols: ExchangeInfoSymbol[] }>("/fapi/v3/exchangeInfo");
    const next = new Map<string, AsterAsset>();
    for (const s of info.symbols ?? []) {
      if (s.quoteAsset !== "USDT") continue;
      if (s.status && s.status !== "TRADING") continue;
      if (s.contractType && s.contractType !== "PERPETUAL") continue;
      const price = s.filters.find((f) => f.filterType === "PRICE_FILTER") as
        | { tickSize?: string }
        | undefined;
      const lot = s.filters.find((f) => f.filterType === "LOT_SIZE") as
        | { stepSize?: string; minQty?: string }
        | undefined;
      const notional = s.filters.find(
        (f) => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL",
      ) as { notional?: string; minNotional?: string } | undefined;
      next.set(s.baseAsset.toUpperCase(), {
        name: s.baseAsset.toUpperCase(),
        index: 0,
        szDecimals: s.quantityPrecision,
        maxLeverage: config.aster.defaultMaxLeverage,
        asterSymbol: s.symbol,
        pricePrecision: s.pricePrecision,
        tickSize: Number(price?.tickSize ?? 0) || 0,
        stepSize: Number(lot?.stepSize ?? 0) || 0,
        minQty: Number(lot?.minQty ?? 0) || 0,
        minNotional: Number(notional?.notional ?? notional?.minNotional ?? 5) || 5,
      });
    }
    if (next.size > 0) {
      this.assets = next;
      this.assetsLoadedAt = Date.now();
    }
    return this.assets;
  }

  private async resolve(symbol: string): Promise<AsterAsset | undefined> {
    await this.loadAssets();
    return this.assets.get(symbol.toUpperCase());
  }

  async getAsset(symbol: string): Promise<AssetInfo | undefined> {
    return this.resolve(symbol);
  }

  /* ---------------------------- market data ------------------------------ */

  async getMidPrice(symbol: string): Promise<number | undefined> {
    const asset = await this.resolve(symbol);
    if (!asset) return undefined;
    // Prefer the true mid (best bid/ask) — it drives sizing and the slippage
    // gates, so last-trade skew on a thin book shouldn't leak in.
    try {
      const b = await this.pub<{ bidPrice: string; askPrice: string }>("/fapi/v3/ticker/bookTicker", {
        symbol: asset.asterSymbol,
      });
      const bid = Number(b.bidPrice);
      const ask = Number(b.askPrice);
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) return (bid + ask) / 2;
    } catch {
      /* fall back to last price */
    }
    const t = await this.pub<{ price: string }>("/fapi/v3/ticker/price", {
      symbol: asset.asterSymbol,
    });
    const n = Number(t.price);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  async getAllMids(): Promise<Record<string, number>> {
    await this.loadAssets();
    // Reverse map venue-symbol -> bare coin so we can key the result by coin.
    const bySymbol = new Map<string, string>();
    for (const a of this.assets.values()) bySymbol.set(a.asterSymbol, a.name);
    const arr = await this.pub<{ symbol: string; price: string }[]>("/fapi/v3/ticker/price");
    const out: Record<string, number> = {};
    for (const row of Array.isArray(arr) ? arr : []) {
      const coin = bySymbol.get(row.symbol);
      if (!coin) continue;
      const n = Number(row.price);
      if (Number.isFinite(n) && n > 0) out[coin] = n;
    }
    return out;
  }

  async getPositions(): Promise<Position[]> {
    if (!this.live) return [];
    await this.loadAssets();
    const bySymbol = new Map<string, string>();
    for (const a of this.assets.values()) bySymbol.set(a.asterSymbol, a.name);
    const rows = await this.signed<
      { symbol: string; positionAmt: string; entryPrice: string; unRealizedProfit: string; leverage: string }[]
    >("GET", "/fapi/v3/positionRisk");
    return (Array.isArray(rows) ? rows : [])
      .map((p) => ({
        symbol: bySymbol.get(p.symbol) ?? p.symbol,
        size: Number(p.positionAmt),
        entryPrice: Number(p.entryPrice),
        unrealizedPnl: Number(p.unRealizedProfit),
        leverage: Number(p.leverage) || 0,
      }))
      .filter((p) => Number.isFinite(p.size) && p.size !== 0);
  }

  async getAccountSummary(): Promise<AccountSummary | null> {
    if (!this.live) return null;
    const a = await this.signed<{
      totalMarginBalance?: string;
      totalWalletBalance?: string;
      availableBalance?: string;
      totalPositionInitialMargin?: string;
    }>("GET", "/fapi/v3/accountWithJoinMargin");
    return {
      address: "aster",
      accountValue: Number(a.totalMarginBalance ?? a.totalWalletBalance ?? 0),
      withdrawable: Number(a.availableBalance ?? 0),
      totalMarginUsed: Number(a.totalPositionInitialMargin ?? 0),
    };
  }

  async getRecentFills(symbols?: string[]): Promise<FillLite[]> {
    if (!this.live) return [];
    // Aster's fills API is per-symbol; only query the coins we currently hold.
    const coins = [...new Set((symbols ?? []).map((s) => s.toUpperCase()))];
    if (coins.length === 0) return [];
    const out: FillLite[] = [];
    for (const coin of coins) {
      const asset = await this.resolve(coin);
      if (!asset) continue;
      try {
        const rows = await this.signed<
          {
            orderId: number;
            symbol: string;
            qty: string;
            price: string;
            side: string; // BUY / SELL
            realizedPnl: string;
            commission: string;
            time: number;
          }[]
        >("GET", "/fapi/v3/userTrades", { symbol: asset.asterSymbol, limit: 100 });
        for (const r of Array.isArray(rows) ? rows : []) {
          out.push({
            oid: String(r.orderId),
            symbol: coin,
            size: Math.abs(Number(r.qty)),
            price: Number(r.price),
            side: r.side === "BUY" ? "B" : "A",
            closedPnl: Number(r.realizedPnl),
            fee: Number(r.commission),
            time: r.time,
          });
        }
      } catch (err) {
        log.warn(`Aster userTrades ${coin}:`, err instanceof Error ? err.message : err);
      }
    }
    return out;
  }

  async getOpenOrderIds(): Promise<Set<string>> {
    if (!this.live) return new Set();
    const rows = await this.signed<{ orderId: number }[]>("GET", "/fapi/v3/openOrders");
    return new Set((Array.isArray(rows) ? rows : []).map((o) => String(o.orderId)));
  }

  /* ------------------------------- orders -------------------------------- */

  private async setLeverage(asset: AsterAsset, leverage: number, marginMode: "cross" | "isolated") {
    const capped = Math.max(1, Math.floor(Math.min(leverage, asset.maxLeverage)));
    try {
      await this.signed("POST", "/fapi/v3/leverage", { symbol: asset.asterSymbol, leverage: capped });
    } catch (err) {
      log.warn(`Aster setLeverage ${asset.name}:`, err instanceof Error ? err.message : err);
    }
    try {
      await this.signed("POST", "/fapi/v3/marginType", {
        symbol: asset.asterSymbol,
        marginType: marginMode === "cross" ? "CROSSED" : "ISOLATED",
      });
    } catch {
      // -4046 "No need to change margin type" is expected & harmless.
    }
  }

  async placeMarketOrder(req: OrderRequest): Promise<OrderResult> {
    let asset: AsterAsset | undefined;
    let mid: number | undefined;
    try {
      asset = await this.resolve(req.symbol);
      if (asset) mid = await this.getMidPrice(req.symbol);
    } catch (err) {
      return {
        ok: false,
        filledPrice: 0,
        size: 0,
        simulated: !this.live,
        error: `Price feed error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!asset) return { ok: false, filledPrice: 0, size: 0, simulated: !this.live, error: `Unknown symbol ${req.symbol}` };
    if (!mid || mid <= 0) return { ok: false, filledPrice: 0, size: 0, simulated: !this.live, error: `No price for ${req.symbol}` };

    const size = roundStep(req.notionalUsd / mid, asset.stepSize, asset.szDecimals, "floor");
    // A reduce-only close of a small remainder must always be attempted — never
    // block it on minQty, or cancelling its brackets first would orphan an
    // unprotected position that can't be closed. (Opens still respect minQty.)
    if (size <= 0 || (!req.reduceOnly && size < asset.minQty)) {
      return { ok: false, filledPrice: mid, size: 0, simulated: !this.live, error: "Computed size below minimum" };
    }
    if (!req.reduceOnly && size * mid < asset.minNotional) {
      return {
        ok: false,
        filledPrice: mid,
        size: 0,
        simulated: !this.live,
        error: `Order value ${(size * mid).toFixed(2)} below Aster's ${asset.minNotional} minimum`,
      };
    }

    // `force` only sends a real reduce-only order when the venue can actually
    // sign (live). Without creds there's no real position here — simulate.
    const forceReal = !!req.force && !!req.reduceOnly && this.live;
    if (this.simulating() && !forceReal) {
      return { ok: true, filledPrice: mid, size, simulated: true };
    }

    try {
      if (!req.reduceOnly) await this.setLeverage(asset, req.leverage, req.marginMode);
      const params: Record<string, string | number | boolean> = {
        symbol: asset.asterSymbol,
        side: req.side === "long" ? "BUY" : "SELL",
        type: "MARKET",
        quantity: fmt(size, asset.szDecimals),
        newOrderRespType: "RESULT",
      };
      if (req.reduceOnly) params.reduceOnly = "true";
      const res = await this.signed<{ orderId: number; avgPrice?: string; executedQty?: string; status?: string }>(
        "POST",
        "/fapi/v3/order",
        params,
      );
      const avg = Number(res.avgPrice);
      const exec = Number(res.executedQty);
      const filledPrice = Number.isFinite(avg) && avg > 0 ? avg : mid;
      const filledSize = Number.isFinite(exec) && exec > 0 ? exec : size;
      return { ok: true, filledPrice, size: filledSize, orderId: String(res.orderId), simulated: false };
    } catch (err) {
      return { ok: false, filledPrice: mid, size, simulated: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async placeLimitOrder(req: LimitOrderRequest): Promise<LimitOrderResult> {
    const sim = this.simulating();
    let asset: AsterAsset | undefined;
    try {
      asset = await this.resolve(req.symbol);
    } catch (err) {
      return { ok: false, size: 0, simulated: sim, error: `Price feed error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!asset) return { ok: false, size: 0, simulated: sim, error: `Unknown symbol ${req.symbol}` };
    if (!(req.price > 0)) return { ok: false, size: 0, simulated: sim, error: "Invalid limit price" };

    const size = roundStep(req.notionalUsd / req.price, asset.stepSize, asset.szDecimals, "floor");
    if (size <= 0 || size < asset.minQty) return { ok: false, size: 0, simulated: sim, error: "Computed size below minimum" };
    // Round the resting price so tick-rounding never nudges it toward the market.
    const limitPx = roundTick(req.price, asset.tickSize, asset.pricePrecision, req.side === "long" ? "floor" : "ceil");
    if (size * limitPx < asset.minNotional) {
      return { ok: false, size: 0, simulated: sim, error: `Order value ${(size * limitPx).toFixed(2)} below Aster's ${asset.minNotional} minimum` };
    }

    if (sim) return { ok: true, status: "resting", size, simulated: true };

    try {
      await this.setLeverage(asset, req.leverage, req.marginMode);
      const res = await this.signed<{
        orderId: number;
        status?: string;
        avgPrice?: string;
        executedQty?: string;
      }>("POST", "/fapi/v3/order", {
        symbol: asset.asterSymbol,
        side: req.side === "long" ? "BUY" : "SELL",
        type: "LIMIT",
        timeInForce: "GTC",
        quantity: fmt(size, asset.szDecimals),
        price: fmt(limitPx, asset.pricePrecision),
        newOrderRespType: "RESULT",
      });
      const status = res.status;
      const exec = Number(res.executedQty);
      const avg = Number(res.avgPrice);
      if (status === "FILLED" || (status === "PARTIALLY_FILLED" && exec > 0)) {
        const filledSize = Number.isFinite(exec) && exec > 0 ? exec : size;
        const filledPrice = Number.isFinite(avg) && avg > 0 ? avg : limitPx;
        // A partial cross leaves the remainder resting under the same id — cancel
        // it so no untracked, unprotected residual position can appear.
        if (filledSize < size * 0.999) {
          try {
            await this.cancelOrders(req.symbol, [String(res.orderId)]);
          } catch {
            /* best-effort */
          }
        }
        return { ok: true, status: "filled", orderId: String(res.orderId), filledPrice, size: filledSize, simulated: false };
      }
      // NEW / accepted → resting working order.
      return { ok: true, status: "resting", orderId: String(res.orderId), size, simulated: false };
    } catch (err) {
      return { ok: false, size: 0, simulated: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async placeBracketOrders(params: BracketParams): Promise<BracketResult> {
    const { symbol, side, size, stopLoss, takeProfits, force } = params;
    const tps = takeProfits ?? [];
    if (stopLoss === undefined && tps.length === 0) return { tpOrderIds: [], protectedOnExchange: false };
    if (this.simulating() && !force) return { tpOrderIds: [], protectedOnExchange: false };

    let asset: AsterAsset | undefined;
    try {
      asset = await this.resolve(symbol);
    } catch (err) {
      return { tpOrderIds: [], protectedOnExchange: false, error: `Price feed error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!asset) return { tpOrderIds: [], protectedOnExchange: false, error: `Unknown symbol ${symbol}` };

    // Closing a long means selling; closing a short means buying.
    const closeSide = side === "long" ? "SELL" : "BUY";
    let slOrderId: string | undefined;
    const tpOrderIds: string[] = [];
    let error: string | undefined;

    if (stopLoss !== undefined) {
      try {
        const res = await this.signed<{ orderId: number }>("POST", "/fapi/v3/order", {
          symbol: asset.asterSymbol,
          side: closeSide,
          type: "STOP_MARKET",
          stopPrice: fmt(roundTick(stopLoss, asset.tickSize, asset.pricePrecision, "round"), asset.pricePrecision),
          closePosition: "true",
          workingType: "MARK_PRICE",
        });
        slOrderId = String(res.orderId);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }

    if (tps.length > 0) {
      let remaining = size;
      for (let i = 0; i < tps.length; i++) {
        const isLast = i === tps.length - 1;
        const chunk = isLast
          ? roundStep(remaining, asset.stepSize, asset.szDecimals, "floor")
          : roundStep(size / tps.length, asset.stepSize, asset.szDecimals, "floor");
        remaining = Math.max(0, remaining - chunk);
        if (chunk <= 0) continue;
        try {
          const res = await this.signed<{ orderId: number }>("POST", "/fapi/v3/order", {
            symbol: asset.asterSymbol,
            side: closeSide,
            type: "TAKE_PROFIT_MARKET",
            stopPrice: fmt(roundTick(tps[i]!, asset.tickSize, asset.pricePrecision, "round"), asset.pricePrecision),
            quantity: fmt(chunk, asset.szDecimals),
            reduceOnly: "true",
            workingType: "MARK_PRICE",
          });
          tpOrderIds.push(String(res.orderId));
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      }
    }

    const protectedOnExchange = slOrderId !== undefined || tpOrderIds.length > 0;
    return { slOrderId, tpOrderIds, protectedOnExchange, error: protectedOnExchange ? undefined : error };
  }

  async cancelOrders(symbol: string, orderIds: string[]): Promise<void> {
    if (!this.live || orderIds.length === 0) return;
    const asset = await this.resolve(symbol);
    if (!asset) return;
    for (const oid of orderIds) {
      try {
        await this.signed("DELETE", "/fapi/v3/order", { symbol: asset.asterSymbol, orderId: oid });
      } catch (err) {
        // -2011 "Unknown order" (already filled/canceled) is expected & harmless.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("-2011")) log.warn(`Aster cancel ${symbol} ${oid}:`, msg);
      }
    }
  }
}

/* ------------------------------ rounding ------------------------------- */

/** Round a size to the venue's lot step (and precision), directionally. */
function roundStep(value: number, step: number, precision: number, mode: "floor" | "ceil"): number {
  if (!(value > 0)) return 0;
  if (step > 0) {
    const n = value / step;
    const r = mode === "floor" ? Math.floor(n + 1e-9) : Math.ceil(n - 1e-9);
    return Number((r * step).toFixed(precision));
  }
  const f = 10 ** precision;
  return mode === "floor" ? Math.floor(value * f) / f : Math.ceil(value * f) / f;
}

/** Round a price to the venue's tick, floor/ceil/round as needed. */
function roundTick(px: number, tick: number, precision: number, mode: "floor" | "ceil" | "round"): number {
  if (!(px > 0)) return px;
  if (tick > 0) {
    const n = px / tick;
    const r = mode === "floor" ? Math.floor(n + 1e-9) : mode === "ceil" ? Math.ceil(n - 1e-9) : Math.round(n);
    return Number((r * tick).toFixed(precision));
  }
  const f = 10 ** precision;
  return Math.round(px * f) / f;
}

/** Format a number to a fixed number of decimals without scientific notation. */
function fmt(value: number, precision: number): string {
  return value.toFixed(Math.max(0, Math.min(18, precision)));
}

export const aster = new AsterConnector();
