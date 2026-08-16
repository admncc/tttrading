import type {
  Group, ParsedSignal, SecondOpinion, SecondOpinionSuggestion, SecondOpinionTA, SecondOpinionTFrame, SecondOpinionVerdict,
} from "@tttrading/shared";
import { log, event } from "../logger.js";
import { activeHyperliquid } from "../exchanges/registry.js";
import { secondOpinions as repo } from "../db/repositories.js";
import { proAnalystReview, type SignalImage } from "../signals/llm.js";
import { broadcast } from "../ws/hub.js";

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

const TF_MS: Record<string, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
const FRAMES = ["15m", "1h", "4h", "1d"];
const BARS = 320; // per timeframe — enough for EMA200

/* ------------------------------ TA helpers ------------------------------ */

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
  const s = trs.slice(-period);
  return s.reduce((a, x) => a + x, 0) / (s.length || 1);
}
function rsi(closes: number[], period = 14): number {
  if (closes.length <= period) return 50;
  let gain = 0, loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d; else loss -= d;
  }
  const rs = loss === 0 ? 100 : gain / loss;
  return 100 - 100 / (1 + rs);
}
function pivots(candles: Candle[], w = 3): { highs: number[]; lows: number[] } {
  const highs: number[] = [], lows: number[] = [];
  for (let i = w; i < candles.length - w; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - w; j <= i + w; j++) {
      if (candles[j]!.h > candles[i]!.h) isHigh = false;
      if (candles[j]!.l < candles[i]!.l) isLow = false;
    }
    if (isHigh) highs.push(candles[i]!.h);
    if (isLow) lows.push(candles[i]!.l);
  }
  return { highs, lows };
}
function levels(candles: Candle[], price: number): { support: number; resistance: number } {
  const { highs, lows } = pivots(candles, 3);
  const resAbove = highs.filter((h) => h > price).sort((a, b) => a - b);
  const supBelow = lows.filter((l) => l < price).sort((a, b) => b - a);
  return {
    resistance: resAbove[0] ?? Math.max(...candles.map((c) => c.h)),
    support: supBelow[0] ?? Math.min(...candles.map((c) => c.l)),
  };
}
function trendOf(closes: number[], price: number): "up" | "down" | "sideways" {
  const f = ema(closes, 20), m = ema(closes, 50), s = ema(closes, Math.min(200, closes.length));
  if (f > m && m > s && price > s) return "up";
  if (f < m && m < s && price < s) return "down";
  return "sideways";
}
const r6 = (n: number) => Number(n.toPrecision(6));

export function computeFrame(interval: string, candles: Candle[]): SecondOpinionTFrame | undefined {
  if (candles.length < 30) return undefined;
  const closes = candles.map((c) => c.c);
  const price = closes[closes.length - 1]!;
  const { support, resistance } = levels(candles, price);
  return {
    interval,
    trend: trendOf(closes, price),
    ema20: r6(ema(closes, 20)),
    ema50: r6(ema(closes, 50)),
    ema200: r6(ema(closes, Math.min(200, closes.length))),
    atr: r6(atr(candles, 14)),
    support: r6(support),
    resistance: r6(resistance),
    rsi: Math.round(rsi(closes, 14)),
  };
}

export function buildTA(
  parsed: ParsedSignal,
  primary: Candle[],
  frames: SecondOpinionTFrame[],
  ctx: { funding?: number; openInterest?: number; premiumBps?: number },
): SecondOpinionTA | undefined {
  if (primary.length < 30) return undefined;
  const closes = primary.map((c) => c.c);
  const price = closes[closes.length - 1]!;
  const emaFast = ema(closes, 20), emaMid = ema(closes, 50), emaSlow = ema(closes, Math.min(200, closes.length));
  const a = atr(primary, 14);
  const { support, resistance } = levels(primary, price);
  const trend = trendOf(closes, price);

  const long = parsed.side === "long";
  const entry = parsed.entry ?? price;
  const sl = parsed.stopLoss;
  const tp1 = parsed.takeProfits?.[0];
  const risk = sl !== undefined ? Math.abs(entry - sl) : undefined;
  const rrClaimed = risk && risk > 0 && tp1 !== undefined ? Math.abs(tp1 - entry) / risk : undefined;
  const rewardReal = long ? resistance - entry : entry - support;
  const rrRealistic = risk && risk > 0 && rewardReal > 0 ? rewardReal / risk : undefined;
  const slAtrMultiple = risk && a > 0 ? risk / a : undefined;

  // Stale-entry check: a limit entry far from the live market means price has
  // moved past the intended fill — the signal is stale / mismatched (e.g. a long
  // limit well below a market that has already run away, or a chase far above it).
  const entryVsPricePct = parsed.entry !== undefined ? ((parsed.entry - price) / price) * 100 : undefined;
  const entryAtrDist = parsed.entry !== undefined && a > 0 ? Math.abs(parsed.entry - price) / a : undefined;
  // Only a limit sitting FAR from the market is stale — a normal scale-in add a
  // few % below/above price is intentional, not a mismatch. Require a genuinely
  // large gap (>4% or >4× ATR) so deliberate lower/upper legs aren't flagged.
  const entryStale =
    entryVsPricePct !== undefined && (Math.abs(entryVsPricePct) > 4 || (entryAtrDist !== undefined && entryAtrDist > 4));

  const near = (x: number, y: number) => a > 0 && Math.abs(x - y) <= 0.6 * a;
  let entryLocation: string | undefined;
  if (long) {
    if (near(entry, resistance) || entry >= resistance) entryLocation = "long into resistance (poor location)";
    else if (near(entry, support)) entryLocation = "long off support (good location)";
  } else {
    if (near(entry, support) || entry <= support) entryLocation = "short into support (poor location)";
    else if (near(entry, resistance)) entryLocation = "short off resistance (good location)";
  }

  // Range position & volume trend on the primary timeframe.
  const look = primary.slice(-100);
  const hi = Math.max(...look.map((c) => c.h)), lo = Math.min(...look.map((c) => c.l));
  const rangePosition = hi > lo ? (price - lo) / (hi - lo) : 0.5;
  const vols = primary.slice(-20).map((c) => c.v);
  const avgVol = vols.reduce((s, x) => s + x, 0) / (vols.length || 1);
  const lastVol = primary[primary.length - 1]!.v;
  const volumeTrendPct = avgVol > 0 ? (lastVol / avgVol - 1) * 100 : 0;

  // Our OWN plan: SL just beyond structure (0.5 ATR), TP at the nearest opposing level.
  let suggestion: SecondOpinionSuggestion | undefined;
  if (a > 0) {
    const ourSL = long ? support - 0.5 * a : resistance + 0.5 * a;
    const ourTP = long ? resistance : support;
    const ourRisk = Math.abs(entry - ourSL);
    const ourReward = long ? ourTP - entry : entry - ourTP;
    if (ourRisk > 0 && ourReward > 0) {
      suggestion = {
        stopLoss: r6(ourSL),
        takeProfit: r6(ourTP),
        rr: r6(ourReward / ourRisk),
        note: `Ours: SL ${r6(ourSL)} (beyond structure), TP ${r6(ourTP)} (next level) → R/R ${(ourReward / ourRisk).toFixed(2)}`,
      };
    }
  }

  const aligned = frames.filter((f) => (long ? f.trend === "up" : f.trend === "down")).length;
  const mtfAlignment = frames.length ? `${aligned}/${frames.length} timeframes aligned with the trade` : undefined;

  return {
    interval: "1h",
    price: r6(price),
    trend,
    emaFast: r6(emaFast),
    emaMid: r6(emaMid),
    emaSlow: r6(emaSlow),
    atr: r6(a),
    atrPct: r6(a / price),
    support: r6(support),
    resistance: r6(resistance),
    slAtrMultiple: slAtrMultiple !== undefined ? r6(slAtrMultiple) : undefined,
    rrClaimed: rrClaimed !== undefined ? r6(rrClaimed) : undefined,
    rrRealistic: rrRealistic !== undefined ? r6(rrRealistic) : undefined,
    entryLocation,
    entryVsPricePct: entryVsPricePct !== undefined ? r6(entryVsPricePct) : undefined,
    entryStale,
    rsi: Math.round(rsi(closes, 14)),
    rangePosition: r6(rangePosition),
    volumeTrendPct: r6(volumeTrendPct),
    funding: ctx.funding,
    openInterest: ctx.openInterest !== undefined ? r6(ctx.openInterest) : undefined,
    premiumBps: ctx.premiumBps !== undefined ? r6(ctx.premiumBps) : undefined,
    frames,
    mtfAlignment,
    suggestion,
  };
}

export function heuristicVerdict(parsed: ParsedSignal, ta?: SecondOpinionTA): SecondOpinionVerdict {
  let score = 50;
  const red: string[] = [], good: string[] = [];
  if (ta) {
    const long = parsed.side === "long";
    const withTrend = long ? ta.trend === "up" : ta.trend === "down";
    const alignedFrames = (ta.frames ?? []).filter((f) => (long ? f.trend === "up" : f.trend === "down")).length;
    const totalFrames = ta.frames?.length ?? 0;

    // 1) Multi-timeframe confluence — a real edge, but a counter-trend entry is a
    // legitimate mean-reversion play, so the against-trend penalty is soft (a
    // strong R/R off support can still be a good short-term long).
    if (totalFrames) {
      if (alignedFrames >= Math.ceil(totalFrames * 0.75)) { score += 16; good.push(ta.mtfAlignment ?? "multi-timeframe aligned"); }
      else if (alignedFrames <= Math.floor(totalFrames * 0.25)) { score -= 8; red.push(`limited timeframe support (${ta.mtfAlignment})`); }
    }

    // 2) Trading WITH the primary trend is the single most reliable positive.
    if (withTrend) { score += 12; good.push(`with the ${ta.trend} trend`); }

    // 3) Risk/reward — the trader's stated R/R to TP1 is the primary geometry
    // signal. The reward to the NEAREST pivot (rrRealistic) is only a waypoint —
    // in a trend price runs well past it — so it is context, never a hard veto.
    if (ta.rrClaimed !== undefined) {
      if (ta.rrClaimed >= 3) { score += 14; good.push(`strong R/R (${ta.rrClaimed.toFixed(1)})`); }
      else if (ta.rrClaimed >= 2) { score += 10; good.push(`good R/R (${ta.rrClaimed.toFixed(1)})`); }
      else if (ta.rrClaimed < 1) { score -= 12; red.push(`weak R/R to TP1 (${ta.rrClaimed.toFixed(1)})`); }
    }
    if (ta.rrRealistic !== undefined) {
      if (ta.rrRealistic >= 2) { score += 6; good.push(`clean room to the next level (${ta.rrRealistic.toFixed(1)}R)`); }
      // Only a concern when BOTH the pivot room AND the stated R/R are poor.
      else if (ta.rrRealistic < 0.5 && (ta.rrClaimed ?? 0) < 1.5) { score -= 6; red.push(`little room before the next level`); }
    }

    // 4) Stop placement vs volatility — sweet spot ~1.2–3.5× ATR.
    if (ta.slAtrMultiple !== undefined) {
      if (ta.slAtrMultiple >= 1.2 && ta.slAtrMultiple <= 3.5) { score += 6; good.push(`stop well-placed (${ta.slAtrMultiple.toFixed(1)}×ATR)`); }
      else if (ta.slAtrMultiple < 1) { score -= 8; red.push(`SL inside 1× ATR — noise risk (${ta.slAtrMultiple.toFixed(2)})`); }
      else if (ta.slAtrMultiple > 5) { score -= 6; red.push(`SL very wide (${ta.slAtrMultiple.toFixed(1)}×ATR)`); }
    }

    // 5) Entry location vs structure.
    if (ta.entryLocation?.includes("poor")) { score -= 8; red.push(ta.entryLocation); }
    if (ta.entryLocation?.includes("good")) { score += 10; good.push(ta.entryLocation); }

    // 6) Where in the recent range — buying low / selling high is a plus.
    if (ta.rangePosition !== undefined) {
      const rp = ta.rangePosition;
      if (long && rp <= 0.4) { score += 5; good.push(`buying the lower range (${Math.round(rp * 100)}%)`); }
      else if (long && rp >= 0.9) { score -= 5; red.push(`buying the very top of the range (${Math.round(rp * 100)}%)`); }
      else if (!long && rp >= 0.6) { score += 5; good.push(`selling the upper range (${Math.round(rp * 100)}%)`); }
      else if (!long && rp <= 0.1) { score -= 5; red.push(`selling the very bottom of the range (${Math.round(rp * 100)}%)`); }
    }

    // 7) RSI — only an EXTREME reading, and only when it fights the entry, is a
    // flag. Overbought in an uptrend is momentum, not a reason to fade.
    if (ta.rsi !== undefined) {
      if (long && ta.rsi >= 82) { score -= 8; red.push(`extremely overbought (RSI ${ta.rsi})`); }
      if (!long && ta.rsi <= 18) { score -= 8; red.push(`extremely oversold (RSI ${ta.rsi})`); }
    }

    // 8) Stale limit far from market (deliberate scale-in adds are not stale).
    if (ta.entryStale) {
      score -= 8;
      red.push(`stale/mismatched entry — ${ta.entryVsPricePct! > 0 ? "+" : ""}${ta.entryVsPricePct?.toFixed(1)}% from live price`);
    }

    // 9) Funding crowding — a mild contrarian flag.
    if (ta.funding !== undefined) {
      const crowded = long ? ta.funding > 0.0004 : ta.funding < -0.0004;
      if (crowded) { score -= 5; red.push(`crowded funding (${(ta.funding * 100).toFixed(3)}%)`); }
    }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    stance: score >= 50 ? "positive" : "negative",
    score,
    summary: ta ? `Heuristic: ${good.concat(red).join("; ") || "neutral setup"}.` : "No candle data — no technical read.",
    redFlags: red,
    strengths: good,
    source: "heuristic",
    confidence: ta ? 0.45 : 0.2,
  };
}

/* --------------------------- generation (A) ----------------------------- */

export async function generateSecondOpinion(
  group: Group,
  parsed: ParsedSignal,
  images?: SignalImage[],
  signalId?: string,
): Promise<void> {
  try {
    const symbol = parsed.symbol.toUpperCase();
    const hl = activeHyperliquid();
    const now = Date.now();

    event(
      "review",
      `Second Opinion: analyzing ${parsed.side.toUpperCase()} ${symbol} (${group.name})`,
      { symbol, side: parsed.side, entry: parsed.entry, stopLoss: parsed.stopLoss, takeProfits: parsed.takeProfits, hasChart: (images?.length ?? 0) > 0 },
      { level: "info", groupId: group.id, signalId },
    );

    const byTf: Record<string, Candle[]> = {};
    await Promise.all(
      FRAMES.map(async (tf) => {
        try {
          byTf[tf] = await hl.getCandles(symbol, tf, now - BARS * (TF_MS[tf] ?? 3_600_000), now);
        } catch {
          byTf[tf] = [];
        }
      }),
    );
    const ctx = await hl.getMarketContext(symbol).catch(() => ({}));

    const frames = FRAMES.map((tf) => computeFrame(tf, byTf[tf] ?? [])).filter((f): f is SecondOpinionTFrame => !!f);
    const ta = buildTA(parsed, byTf["1h"] ?? [], frames, ctx);

    event(
      "review",
      ta
        ? `Data: candles [${FRAMES.map((tf) => `${tf}:${byTf[tf]?.length ?? 0}`).join(" ")}] · MTF ${ta.mtfAlignment} · trend ${ta.trend} · RSI ${ta.rsi} · SL ${ta.slAtrMultiple?.toFixed(2)}xATR · R/R ${ta.rrClaimed?.toFixed(1) ?? "?"}→${ta.rrRealistic?.toFixed(1) ?? "?"}` +
            (ta.entryStale ? ` · ⚠ STALE entry (${ta.entryVsPricePct! > 0 ? "+" : ""}${ta.entryVsPricePct?.toFixed(1)}% vs live)` : "") +
            (ta.funding !== undefined ? ` · funding ${(ta.funding * 100).toFixed(4)}%` : "")
        : `Data: no usable candles for ${symbol} — judging from chart/heuristic only`,
      { candleCounts: Object.fromEntries(FRAMES.map((tf) => [tf, byTf[tf]?.length ?? 0])), marketContext: ctx, ta },
      { level: "info", groupId: group.id, signalId },
    );

    const frameLine = frames.map((f) => `${f.interval}:${f.trend}(rsi ${f.rsi})`).join(", ");
    const brief =
      `Signal from channel "${group.name}": ${parsed.side.toUpperCase()} ${symbol}\n` +
      `Provider plan — Entry: ${parsed.entry ?? "CMP"} · SL: ${parsed.stopLoss ?? "none"} · TPs: ${parsed.takeProfits?.join(", ") ?? "none"}\n\n` +
      (ta
        ? `Objective indicators:\n` +
          `- multi-timeframe trend: ${frameLine} — ${ta.mtfAlignment}\n` +
          `- 1h price ${ta.price}, EMA20/50/200 ${ta.emaFast}/${ta.emaMid}/${ta.emaSlow}, RSI ${ta.rsi}\n` +
          `- ATR ${ta.atr} (${(ta.atrPct * 100).toFixed(2)}%); SL distance = ${ta.slAtrMultiple?.toFixed(2) ?? "?"}x ATR\n` +
          `- support ${ta.support} / resistance ${ta.resistance}; range position ${(ta.rangePosition! * 100).toFixed(0)}%\n` +
          `- R/R to TP1 (stated targets) ${ta.rrClaimed?.toFixed(2) ?? "?"}; reward to the NEAREST pivot ${ta.rrRealistic?.toFixed(2) ?? "?"} (a waypoint only — in a trend price runs past it, so judge reward by the stated targets/structure, not this figure)\n` +
          `- entry location: ${ta.entryLocation ?? "n/a"}; volume vs avg ${ta.volumeTrendPct?.toFixed(0)}%\n` +
          (ta.entryVsPricePct !== undefined
            ? `- provider entry is ${ta.entryVsPricePct > 0 ? "+" : ""}${ta.entryVsPricePct.toFixed(2)}% vs live price${ta.entryStale ? " → STALE/MISMATCHED (market has moved past the intended fill)" : ""}\n`
            : "") +
          (ta.funding !== undefined ? `- funding ${(ta.funding * 100).toFixed(4)}%, premium ${ta.premiumBps?.toFixed(1)} bps, OI ${ta.openInterest?.toFixed(0)}\n` : "") +
          (ta.suggestion ? `- OUR independent plan: ${ta.suggestion.note}\n` : "")
        : `No candle data — judge from the chart image if present.\n`) +
      `\nGive your independent professional assessment of THIS setup and whether the provider's levels are sound.`;

    const review = await proAnalystReview(brief, group.settings.instructions, images);
    const verdict: SecondOpinionVerdict = review ? { ...review, source: "llm" } : heuristicVerdict(parsed, ta);

    const op = repo.create({
      signalId,
      groupId: group.id,
      groupName: group.name,
      symbol,
      side: parsed.side,
      entry: parsed.entry,
      stopLoss: parsed.stopLoss,
      takeProfits: parsed.takeProfits,
      ta,
      verdict,
    });
    broadcast({ type: "secondOpinion", secondOpinion: op });
    event(
      "review",
      `Verdict ${symbol} ${parsed.side.toUpperCase()}: ${verdict.stance.toUpperCase()} ${verdict.score}/100 (${verdict.source}, conf ${verdict.confidence.toFixed(2)}) — ${verdict.summary}` +
        (verdict.redFlags.length ? ` · ⚠ ${verdict.redFlags.join("; ")}` : "") +
        (verdict.strengths.length ? ` · ✓ ${verdict.strengths.join("; ")}` : "") +
        (ta?.suggestion ? ` · ${ta.suggestion.note}` : ""),
      { verdict, providerLevels: { entry: parsed.entry, stopLoss: parsed.stopLoss, takeProfits: parsed.takeProfits }, ourLevels: ta?.suggestion },
      { level: verdict.stance === "negative" ? "warn" : "info", groupId: group.id, signalId },
    );
  } catch (err) {
    log.warn("second-opinion generation failed:", err instanceof Error ? err.message : err);
  }
}

/* ------------------------ claim verification (B) ------------------------ */

async function verifyOne(op: SecondOpinion): Promise<void> {
  const createdMs = new Date(op.createdAt).getTime();
  const ageMs = Date.now() - createdMs;
  let candles: Candle[] = [];
  try {
    candles = await activeHyperliquid().getCandles(op.symbol, "15m", createdMs, Date.now());
  } catch {
    return;
  }
  if (candles.length === 0) return;
  const base = op.entry ?? candles[0]!.o;
  if (!(base > 0)) return;
  const long = op.side === "long";
  const tps = op.takeProfits ?? [];
  const tp1 = tps[0];
  const sl = op.stopLoss;
  const risk = sl !== undefined ? Math.abs(base - sl) : undefined;

  let maxHigh = -Infinity, minLow = Infinity;
  let firstHit: "tp" | "sl" | "none" = "none";
  let hitMs: number | undefined;
  for (const c of candles) {
    maxHigh = Math.max(maxHigh, c.h);
    minLow = Math.min(minLow, c.l);
    if (firstHit === "none") {
      const tpTouched = tp1 !== undefined && (long ? c.h >= tp1 : c.l <= tp1);
      const slTouched = sl !== undefined && (long ? c.l <= sl : c.h >= sl);
      if (slTouched) { firstHit = "sl"; hitMs = c.t; }
      else if (tpTouched) { firstHit = "tp"; hitMs = c.t; }
    }
  }
  const mfe = long ? maxHigh - base : base - minLow;
  const mfePct = (mfe / base) * 100;
  const maePct = ((long ? base - minLow : maxHigh - base) / base) * 100;
  const tp1Hit = tp1 !== undefined ? (long ? maxHigh >= tp1 : minLow <= tp1) : undefined;
  const slHit = sl !== undefined ? (long ? minLow <= sl : maxHigh >= sl) : undefined;
  const allTpHit = tps.length > 0 ? tps.every((t) => (long ? maxHigh >= t : minLow <= t)) : undefined;
  const maxR = risk && risk > 0 ? mfe / risk : undefined;
  const resolved = firstHit !== "none" || ageMs > 14 * 86_400_000;
  const hoursToFirstHit = hitMs ? Number(((hitMs - createdMs) / 3_600_000).toFixed(1)) : undefined;

  const outcome = {
    checkedAt: new Date().toISOString(),
    mfePct: Number(mfePct.toFixed(2)),
    maePct: Number(maePct.toFixed(2)),
    tp1Hit,
    slHit,
    firstHit,
    resolved,
    hoursToFirstHit,
    maxR: maxR !== undefined ? Number(maxR.toFixed(2)) : undefined,
    allTpHit,
  };
  repo.setOutcome(op.id, outcome);

  // Log the moment a call RESOLVES (once), so the full lifecycle is traceable.
  if (!op.outcome?.resolved && resolved) {
    const called = op.verdict?.stance;
    // Favorable = provider TP hit first OR the trade reached at least 1R in its favor.
    const good = firstHit === "tp" || (maxR ?? 0) >= 1;
    const rightWrong = called ? (good === (called === "positive") ? "our call RIGHT" : "our call WRONG") : "no stance";
    event(
      "review",
      `Outcome ${op.symbol} ${op.side.toUpperCase()}: ${firstHit === "tp" ? "TP hit first" : firstHit === "sl" ? "SL hit first" : "no hit (timeout)"}` +
        (hoursToFirstHit !== undefined ? ` after ${hoursToFirstHit}h` : "") +
        ` · MFE ${outcome.mfePct}% / MAE ${outcome.maePct}% · maxR ${outcome.maxR ?? "?"} · ${rightWrong} (we were ${called ?? "—"})`,
      { outcome, ourStance: called },
      { level: "info", groupId: op.groupId, signalId: op.signalId },
    );
  }
}

export async function verifySecondOpinions(): Promise<void> {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  for (const op of repo.unresolvedSince(since)) {
    try {
      await verifyOne(op);
    } catch (err) {
      log.warn(`second-opinion verify ${op.symbol}:`, err instanceof Error ? err.message : err);
    }
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startSecondOpinionTracker(): void {
  if (timer) return;
  timer = setInterval(() => void verifySecondOpinions(), 5 * 60_000);
  void verifySecondOpinions();
  log.info("Second Opinion tracker started (verifies outcomes every 5 min).");
}
export function stopSecondOpinionTracker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
