/**
 * Phase 2 — point-in-time feature computation (dev-brief §2/§3). Pure functions:
 * they take already-fetched candles / context / trader stats and return feature
 * name→value pairs. No DB, no network, no clock (times are passed in) so every
 * feature is unit-testable and look-ahead-free by construction.
 *
 * Only bucket-reportable features live here — no model integration (§11.3).
 */

export type Feat = { name: string; num?: number; text?: string };
export const FEATURE_VERSION = "p2.1";

type Candle = { t: number; o: number; h: number; l: number; c: number; v?: number };

/* ------------------------------ helpers -------------------------------- */
function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0]!;
  for (let i = 1; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}
function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!, p = candles[i - 1]!;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  return trs.slice(-period).reduce((a, x) => a + x, 0) / (Math.min(period, trs.length) || 1);
}
function pctReturn(closes: number[], back: number): number | undefined {
  if (closes.length <= back) return undefined;
  const now = closes[closes.length - 1]!, then = closes[closes.length - 1 - back]!;
  return then > 0 ? (now - then) / then : undefined;
}
function dailyReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1]! > 0) r.push(closes[i]! / closes[i - 1]! - 1);
  return r;
}

/* ------------------------------ 2.4 time ------------------------------- */
/** Session/weekday/hour/weekend from the signal time (UTC). */
export function timeFeatures(signalMs: number): Feat[] {
  const d = new Date(signalMs);
  const h = d.getUTCHours();
  const dow = d.getUTCDay(); // 0=Sun
  const session = h < 7 ? "asia" : h < 13 ? "london" : h < 21 ? "ny" : "offhours";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow]!;
  return [
    { name: "session", text: session },
    { name: "weekday", text: weekday },
    { name: "hourUtc", num: h },
    { name: "weekend", num: dow === 0 || dow === 6 ? 1 : 0 },
  ];
}

/* --------------------------- 3.6 geometry ------------------------------ */
/** Trade geometry in horizon-ATR terms + fee drag in R. */
export function geometryFeatures(
  side: "long" | "short",
  entry: number | undefined,
  stopLoss: number | undefined,
  tp1: number | undefined,
  price: number,
  atrHorizon: number | undefined,
  roundTripFee = 0.0009,
): Feat[] {
  const e = entry ?? price;
  const out: Feat[] = [];
  const slDist = stopLoss !== undefined ? Math.abs(e - stopLoss) : undefined;
  const tpDist = tp1 !== undefined ? Math.abs(tp1 - e) : undefined;
  if (slDist && tpDist && slDist > 0) out.push({ name: "rr", num: tpDist / slDist });
  if (slDist && atrHorizon && atrHorizon > 0) out.push({ name: "slAtrH", num: slDist / atrHorizon });
  if (tpDist && atrHorizon && atrHorizon > 0) out.push({ name: "tpAtrH", num: tpDist / atrHorizon });
  if (slDist && slDist > 0 && e > 0) out.push({ name: "feeDragR", num: (roundTripFee * e) / slDist });
  return out;
}

/* --------------------- 3.1–3.3 multi-timeframe TA ---------------------- */
/** frames: [{interval, trend}] already computed; primary1h for extension/RSI. */
export function taFeatures(
  side: "long" | "short",
  frames: { interval: string; trend: "up" | "down" | "sideways" }[],
  primary1h: Candle[],
): Feat[] {
  const out: Feat[] = [];
  const long = side === "long";
  // mtfAlignment: −3..+3 net across D1/4h/1h (signed by trade direction).
  const wanted = ["1h", "4h", "1d"];
  let align = 0, seen = 0;
  for (const tf of wanted) {
    const f = frames.find((x) => x.interval === tf);
    if (!f) continue;
    seen++;
    if (f.trend === "up") align += long ? 1 : -1;
    else if (f.trend === "down") align += long ? -1 : 1;
  }
  if (seen > 0) out.push({ name: "mtfAlignment", num: align });
  const d1 = frames.find((f) => f.interval === "1d");
  if (d1) out.push({ name: "tradeWithTrendD1", num: d1.trend === "sideways" ? 0 : (long ? d1.trend === "up" : d1.trend === "down") ? 1 : -1 });

  if (primary1h.length >= 21) {
    const closes = primary1h.map((c) => c.c);
    const price = closes[closes.length - 1]!;
    const e20 = ema(closes, 20);
    const a = atr(primary1h, 14);
    if (a > 0) out.push({ name: "distToEma20Atr", num: (price - e20) / a }); // signed: + above EMA20
    // consecutive green candles (exhaustion / chasing proxy)
    let green = 0;
    for (let i = primary1h.length - 1; i >= 0; i--) { if (primary1h[i]!.c > primary1h[i]!.o) green++; else break; }
    out.push({ name: "consecutiveGreen", num: green });
    // z-score of price vs the last 20 closes
    const win = closes.slice(-20);
    const m = win.reduce((s, x) => s + x, 0) / win.length;
    const sd = Math.sqrt(win.reduce((s, x) => s + (x - m) ** 2, 0) / (win.length - 1 || 1));
    if (sd > 0) out.push({ name: "extensionZ20", num: (price - m) / sd });
  }
  return out;
}

/* ---------------------------- 2.1 BTC regime --------------------------- */
/** BTC market regime from BTC daily candles (trend, vol regime, returns). */
export function btcRegimeFeatures(btcD1: Candle[]): Feat[] {
  if (btcD1.length < 60) return [];
  const closes = btcD1.map((c) => c.c);
  const price = closes[closes.length - 1]!;
  const e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, Math.min(200, closes.length));
  const trend = e20 > e50 && e50 > e200 && price > e200 ? "up" : e20 < e50 && e50 < e200 && price < e200 ? "down" : "sideways";
  // Vol regime: current ATR% vs its own 1-year percentile distribution.
  const atrs: number[] = [];
  for (let i = 20; i < btcD1.length; i++) atrs.push(atr(btcD1.slice(0, i + 1), 14) / (btcD1[i]!.c || 1));
  const curAtr = atrs[atrs.length - 1] ?? 0;
  const sorted = [...atrs].sort((a, b) => a - b);
  const rank = sorted.findIndex((x) => x >= curAtr);
  const pctl = sorted.length ? (rank < 0 ? 1 : rank / sorted.length) : 0;
  const volRegime = pctl < 0.25 ? "low" : pctl < 0.6 ? "normal" : pctl < 0.85 ? "high" : "extreme";
  const out: Feat[] = [
    { name: "btcTrendD1", text: trend },
    { name: "btcVolRegime", text: volRegime },
    { name: "btcAtrPctile", num: Number(pctl.toFixed(3)) },
  ];
  const r1 = pctReturn(closes, 1), r7 = pctReturn(closes, 7);
  if (r1 !== undefined) out.push({ name: "btcRet24h", num: r1 });
  if (r7 !== undefined) out.push({ name: "btcRet7d", num: r7 });
  return out;
}

/** Coin beta & correlation to BTC on ~30 daily returns, + coin 7d return / RS. */
export function betaFeatures(coinD1: Candle[], btcD1: Candle[]): Feat[] {
  const n = Math.min(coinD1.length, btcD1.length);
  if (n < 20) return [];
  const cr = dailyReturns(coinD1.slice(-31).map((c) => c.c));
  const br = dailyReturns(btcD1.slice(-31).map((c) => c.c));
  const m = Math.min(cr.length, br.length);
  if (m < 15) return [];
  const c = cr.slice(-m), b = br.slice(-m);
  const mc = c.reduce((s, x) => s + x, 0) / m, mb = b.reduce((s, x) => s + x, 0) / m;
  let cov = 0, varB = 0, varC = 0;
  for (let i = 0; i < m; i++) { cov += (c[i]! - mc) * (b[i]! - mb); varB += (b[i]! - mb) ** 2; varC += (c[i]! - mc) ** 2; }
  const beta = varB > 0 ? cov / varB : undefined;
  const corr = varB > 0 && varC > 0 ? cov / Math.sqrt(varB * varC) : undefined;
  const out: Feat[] = [];
  if (beta !== undefined) out.push({ name: "betaToBtc30d", num: Number(beta.toFixed(3)) });
  if (corr !== undefined) out.push({ name: "corrToBtc30d", num: Number(corr.toFixed(3)) });
  const coinR7 = pctReturn(coinD1.map((c) => c.c), 7), btcR7 = pctReturn(btcD1.map((c) => c.c), 7);
  if (coinR7 !== undefined) out.push({ name: "coinRet7d", num: coinR7 });
  if (coinR7 !== undefined && btcR7 !== undefined) out.push({ name: "coinVsBtcRs7d", num: coinR7 - btcR7 });
  return out;
}

/* -------------------------- 2.2 derivatives ---------------------------- */
export function derivativeFeatures(
  side: "long" | "short",
  ctx: { funding?: number; openInterest?: number; premiumBps?: number },
): Feat[] {
  const out: Feat[] = [];
  if (ctx.funding !== undefined) {
    out.push({ name: "funding", num: ctx.funding });
    const crowded = side === "long" ? ctx.funding > 0.0004 : ctx.funding < -0.0004;
    out.push({ name: "fundingCrowded", num: crowded ? 1 : 0 });
  }
  if (ctx.openInterest !== undefined) out.push({ name: "openInterest", num: ctx.openInterest });
  if (ctx.premiumBps !== undefined) out.push({ name: "premiumBps", num: ctx.premiumBps });
  return out;
}

/** Funding context from history (2.2): 7d-avg and where the current rate sits in
 *  its own recent distribution. Extreme funding into the trade = crowding risk. */
export function fundingHistoryFeatures(
  side: "long" | "short",
  currentFunding: number | undefined,
  history: { time: number; rate: number }[],
  nowMs: number,
): Feat[] {
  if (currentFunding === undefined || history.length < 10) return [];
  const out: Feat[] = [];
  const last7d = history.filter((h) => h.time >= nowMs - 7 * 86_400_000).map((h) => h.rate);
  if (last7d.length) out.push({ name: "funding7dAvg", num: Number((last7d.reduce((s, x) => s + x, 0) / last7d.length).toExponential(3)) });
  const rates = history.map((h) => h.rate).sort((a, b) => a - b);
  const rank = rates.filter((r) => r <= currentFunding).length;
  const pctl = rank / rates.length;
  out.push({ name: "fundingPercentile", num: Number(pctl.toFixed(3)) });
  // Crowded INTO the trade: a long paying top-decile funding, or a short paying
  // (receiving negative) bottom-decile — the side that's expensive to hold.
  const crowdedExtreme = side === "long" ? pctl >= 0.9 : pctl <= 0.1;
  out.push({ name: "fundingExtremeVsTrade", num: crowdedExtreme ? 1 : 0 });
  return out;
}

/* -------------------------- 2.6 trader stats --------------------------- */
export interface TraderStats {
  resolved: number;       // resolved trades used for the stats
  wins: number;
  expectancyR?: number;   // mean R over resolved (with initial risk)
  medianHoldHours?: number;
  signalsPerWeek?: number;
  concurrentSameDir?: number; // same coin+direction in a short window around this signal
}
/** Trader-level features with Bayes shrinkage to the population base rate. */
export function traderStatsFeatures(s: TraderStats, priorMean = 0.48, priorStrength = 10): Feat[] {
  const out: Feat[] = [];
  const shrunk = (s.wins + priorStrength * priorMean) / (s.resolved + priorStrength);
  out.push({ name: "traderWinrateShrunk", num: Number(shrunk.toFixed(4)) });
  out.push({ name: "traderResolvedN", num: s.resolved });
  if (s.expectancyR !== undefined) out.push({ name: "traderExpectancyR", num: Number(s.expectancyR.toFixed(4)) });
  if (s.medianHoldHours !== undefined) out.push({ name: "traderMedianHoldH", num: Number(s.medianHoldHours.toFixed(2)) });
  if (s.signalsPerWeek !== undefined) out.push({ name: "traderSignalsPerWeek", num: Number(s.signalsPerWeek.toFixed(2)) });
  if (s.concurrentSameDir !== undefined) out.push({ name: "concurrentSignalsSameDir", num: s.concurrentSameDir });
  return out;
}

/* --------------------------- 2.5 asset master -------------------------- */
// Static sector map (no external feed). Unknown coins fall to "other" — the
// bucket report will show if "other" needs splitting. kX = 1000x meme variants.
const SECTORS: Record<string, string> = {};
const put = (sector: string, coins: string[]) => coins.forEach((c) => (SECTORS[c] = sector));
put("l1", ["BTC", "ETH", "SOL", "BNB", "AVAX", "ADA", "SUI", "APT", "SEI", "TON", "NEAR", "ICP", "INJ", "TIA", "DOT", "ATOM", "TRX", "LTC", "BCH", "XRP", "HYPE", "EGLD", "KAS", "ALGO", "XLM", "HBAR"]);
put("l2", ["OP", "ARB", "MANTA", "STRK", "ZK", "MNT", "METIS", "BLAST", "POL", "MATIC"]);
put("defi", ["AAVE", "UNI", "LINK", "ONDO", "JTO", "RAY", "JUP", "ENA", "PENDLE", "CRV", "MKR", "LDO", "SYRUP", "VELVET", "AERO", "CAKE", "DYDX", "GMX", "MORPHO"]);
put("ai", ["FET", "RENDER", "RNDR", "TAO", "GRASS", "WLD", "AR", "VIRTUAL", "AIXBT", "AI16Z", "IO", "AKT"]);
put("meme", ["PEPE", "SHIB", "WIF", "BONK", "DOGE", "PUMP", "FARTCOIN", "POPCAT", "MEW", "FLOKI", "BRETT", "SPX", "TRUMP", "MOODENG", "PNUT", "GOAT", "TURBO", "MANA", "JASMY"]);

/** Sector + cap tier for the coin (2.5). capTier passed in to avoid a dep here. */
export function assetFeatures(symbol: string, capTier: string): Feat[] {
  const s = symbol.toUpperCase().replace(/^K/, ""); // kPEPE → PEPE
  return [
    { name: "sector", text: SECTORS[symbol.toUpperCase()] ?? SECTORS[s] ?? "other" },
    { name: "capTier", text: capTier },
  ];
}

export interface CoinBaseRate { resolved: number; tpFirst: number }
/** Coin base rate: historical share of signals on this coin that hit TP first,
 *  Bayes-shrunk to the population base rate (2.5 / dev-brief 4.1). */
export function coinBaseRateFeatures(s: CoinBaseRate, priorMean = 0.48, priorStrength = 10): Feat[] {
  const shrunk = (s.tpFirst + priorStrength * priorMean) / (s.resolved + priorStrength);
  return [
    { name: "coinBaseRateShrunk", num: Number(shrunk.toFixed(4)) },
    { name: "coinResolvedN", num: s.resolved },
  ];
}

/* ------------------------- 2.1 market breadth -------------------------- */
/** ETH/BTC ratio regime — a cheap breadth proxy (alt-season vs BTC-season). */
export function ethBtcFeatures(ethD1: Candle[], btcD1: Candle[]): Feat[] {
  const n = Math.min(ethD1.length, btcD1.length);
  if (n < 30) return [];
  const eth = ethD1.slice(-n).map((c) => c.c), btc = btcD1.slice(-n).map((c) => c.c);
  const ratio = eth.map((e, i) => (btc[i]! > 0 ? e / btc[i]! : 0));
  const cur = ratio[ratio.length - 1]!;
  const e20 = ema(ratio, 20), e50 = ema(ratio, Math.min(50, ratio.length));
  const trend = cur > e20 && e20 > e50 ? "eth-strong" : cur < e20 && e20 < e50 ? "btc-strong" : "mixed";
  const r7 = pctReturn(ratio, 7);
  const out: Feat[] = [{ name: "ethBtcRegime", text: trend }];
  if (r7 !== undefined) out.push({ name: "ethBtcRet7d", num: r7 });
  return out;
}

/** Map a horizon timeframe to a rough hold-time class (for atrHorizon selection). */
export function horizonForHold(medianHoldHours: number | undefined): "1h" | "4h" | "1d" {
  if (medianHoldHours === undefined) return "4h";
  if (medianHoldHours <= 8) return "1h";
  if (medianHoldHours <= 72) return "4h";
  return "1d";
}
