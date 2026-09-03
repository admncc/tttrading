import type {
  Group, ParsedSignal, SecondOpinion, SecondOpinionSuggestion, SecondOpinionTA, SecondOpinionTFrame, SecondOpinionVerdict,
} from "@tttrading/shared";
import { nanoid } from "nanoid";
import { log, event } from "../logger.js";
import { activeHyperliquid } from "../exchanges/registry.js";
import { secondOpinions as repo } from "../db/repositories.js";
import { proAnalystReview, type SignalImage } from "../signals/llm.js";
import { broadcast } from "../ws/hub.js";
import { computeOutcome } from "./outcome.js";
import { logSignalFeatures } from "../features/logger.js";

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
export function rsi(closes: number[], period = 14): number | undefined {
  if (closes.length <= period) return undefined;
  let gain = 0, loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d; else loss -= d;
  }
  // SO-4: a dead-flat window (no gains AND no losses) has no meaningful RSI —
  // return undefined so no rule fires on it (was 99 via the loss===0 shortcut).
  if (gain === 0 && loss === 0) return undefined;
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
    rsi: rsiRound(rsi(closes, 14)),
  };
}

/** Round RSI for display, propagating undefined (SO-4: a flat window has no RSI). */
function rsiRound(v: number | undefined): number | undefined {
  return v === undefined ? undefined : Math.round(v);
}

export function buildTA(
  parsed: ParsedSignal,
  primary: Candle[],
  frames: SecondOpinionTFrame[],
  ctx: { funding?: number; openInterest?: number; premiumBps?: number; horizonTf?: string },
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

  // SO-6 / 1.2: measure the stop against the TRADER-HORIZON ATR, not the 1h ATR.
  // ATR scales ~√time, so a normal multi-day swing stop is 5–7× the 1h ATR but
  // only ~1× the daily ATR. Default horizon = 4h (a middle ground) unless caller
  // overrides; fall back to scaling the 1h ATR when that frame is missing.
  const horizonTf = ctx.horizonTf ?? "4h";
  const ATR_SCALE: Record<string, number> = { "15m": 0.5, "1h": 1, "4h": 2, "1d": 4.5 };
  const horizonFrame = frames.find((f) => f.interval === horizonTf);
  const atrHorizon = horizonFrame?.atr ?? (a > 0 ? a * (ATR_SCALE[horizonTf] ?? 2) : undefined);
  const slAtrH = risk && atrHorizon && atrHorizon > 0 ? risk / atrHorizon : undefined;
  // 1.3: signed distance to the nearest opposing level in horizon ATR. Positive =
  // the level is still ahead (room to run); negative = price has already traded
  // through it (a breakout/retest, NOT "into resistance").
  const oppLevel = long ? resistance : support;
  const signedToLevel = long ? oppLevel - entry : entry - oppLevel;
  const distToLevelAtrH = atrHorizon && atrHorizon > 0 ? signedToLevel / atrHorizon : undefined;

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
    slAtrH: slAtrH !== undefined ? r6(slAtrH) : undefined,
    atrHorizonTf: slAtrH !== undefined ? horizonTf : undefined,
    distToLevelAtrH: distToLevelAtrH !== undefined ? r6(distToLevelAtrH) : undefined,
    rrClaimed: rrClaimed !== undefined ? r6(rrClaimed) : undefined,
    rrRealistic: rrRealistic !== undefined ? r6(rrRealistic) : undefined,
    entryLocation,
    entryVsPricePct: entryVsPricePct !== undefined ? r6(entryVsPricePct) : undefined,
    entryStale,
    rsi: rsiRound(rsi(closes, 14)),
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

/** No single rule may move the score by more than this (dev-brief 1.4). */
const RULE_CAP = 25;

export function heuristicVerdict(parsed: ParsedSignal, ta?: SecondOpinionTA): SecondOpinionVerdict {
  let score = 50;
  const red: string[] = [], good: string[] = [];
  const contributions: { rule: string; delta: number }[] = [];
  // Every rule goes through add(): it is capped at ±RULE_CAP and recorded for the
  // explainability breakdown (leitplanke 8). One concept = one add() call (SO-8).
  const add = (rule: string, deltaRaw: number, note: string, positive: boolean) => {
    const delta = Math.max(-RULE_CAP, Math.min(RULE_CAP, deltaRaw));
    if (delta === 0) return;
    score += delta;
    contributions.push({ rule, delta });
    (positive ? good : red).push(note);
  };

  if (ta) {
    const long = parsed.side === "long";
    const frames = ta.frames ?? [];
    const totalFrames = frames.length;

    // SO-7: confluence/trend signals need at least TWO computed timeframes; a lone
    // frame is not "confluence". When we can't see ≥2, we award/deduct nothing and
    // flag it, rather than crediting a single-frame illusion.
    const mtfAvailable = totalFrames >= 2;

    // SO-10: ONE trade-with-trend feature — sum of (+1 with / −1 against / 0 flat)
    // across the computed frames, scaled. Replaces the old stack of overlapping
    // with-trend / against-trend / confluence penalties.
    if (mtfAvailable) {
      let twt = 0;
      for (const f of frames) {
        if (f.trend === "up") twt += long ? 1 : -1;
        else if (f.trend === "down") twt += long ? -1 : 1;
      }
      const per = 6; // points per net-aligned frame, capped by RULE_CAP
      if (twt > 0) add("tradeWithTrend", twt * per, `with the trend on ${twt}/${totalFrames} frames (${ta.mtfAlignment})`, true);
      else if (twt < 0) add("tradeWithTrend", twt * per, `against the trend on ${-twt}/${totalFrames} frames (${ta.mtfAlignment})`, false);
    } else {
      red.push("multi-timeframe unavailable (mtfUnavailable)");
    }

    // Trend-context flag used to gate the R/R credit (a great R/R while fighting
    // the tape is usually a trap). Only meaningful with the MTF view.
    const primaryWithTrend = long ? ta.trend === "up" : ta.trend === "down";
    const againstTrend = mtfAvailable && !primaryWithTrend && ta.trend !== "sideways";

    // SO-6 + 1.2: stop sanity on the HORIZON ATR. Two flags, no legacy 1h rule.
    //   stopTooTight (< 0.7 horizon-ATR)  — a noise stop, likely to get wicked out.
    //   stopTooWide  (> 3.5 horizon-ATR)  — genuinely oversized for the horizon.
    // Thresholds are start-hypotheses to be refined from bucket stats (not tuned
    // against outcomes here). A normal multi-day swing stop now reads ~1× and
    // scores neither flag — the whole point of the horizon fix.
    if (ta.slAtrH !== undefined) {
      if (ta.slAtrH < 0.7) add("stopTooTight", -10, `stop tight for the horizon (${ta.slAtrH.toFixed(2)}× ${ta.atrHorizonTf}-ATR)`, false);
      else if (ta.slAtrH > 3.5) add("stopTooWide", -8, `stop wide for the horizon (${ta.slAtrH.toFixed(1)}× ${ta.atrHorizonTf}-ATR)`, false);
      else add("stopWellPlaced", 5, `stop sized to the horizon (${ta.slAtrH.toFixed(1)}× ${ta.atrHorizonTf}-ATR)`, true);
    }

    // SO-8: risk/reward is ONE feature (no more double-counting a weak R/R). The
    // stated R/R to TP1 counts only when the stop is sane and we're not fighting
    // the tape.
    const rrCredit = !(ta.slAtrH !== undefined && ta.slAtrH > 3.5) && !againstTrend;
    if (ta.rrClaimed !== undefined) {
      if (rrCredit && ta.rrClaimed >= 3) add("riskReward", 14, `strong R/R (${ta.rrClaimed.toFixed(1)})`, true);
      else if (rrCredit && ta.rrClaimed >= 2) add("riskReward", 10, `good R/R (${ta.rrClaimed.toFixed(1)})`, true);
      else if (ta.rrClaimed < 1) add("riskReward", -12, `weak R/R to TP1 (${ta.rrClaimed.toFixed(1)})`, false);
    }

    // 1.3: entry location as a CONTINUOUS signed distance to the opposing level,
    // in horizon ATR. Negative distance = price has already traded THROUGH the
    // level (a breakout/retest) — the opposite of "into resistance", and it must
    // NOT be penalised (SO-9-style false negative). Positive & very small = the
    // entry is jammed right under the level (little room) → a mild flag.
    if (ta.distToLevelAtrH !== undefined) {
      const d = ta.distToLevelAtrH;
      if (d < -0.25) add("breakout", 8, `${long ? "above resistance" : "below support"} — breakout/retest, room opened`, true);
      else if (d >= 0 && d < 0.5) add("intoLevel", -8, `entry jammed into the ${long ? "resistance" : "support"} (${d.toFixed(2)}×ATR room)`, false);
      else if (d >= 1.5) add("roomToLevel", 6, `clean room to the next level (${d.toFixed(1)}×ATR)`, true);
    }

    // Where in the recent range — buying low / selling high is a small plus.
    if (ta.rangePosition !== undefined) {
      const rp = ta.rangePosition;
      if (long && rp <= 0.4) add("rangePos", 5, `buying the lower range (${Math.round(rp * 100)}%)`, true);
      else if (long && rp >= 0.9) add("rangePos", -5, `buying the very top of the range (${Math.round(rp * 100)}%)`, false);
      else if (!long && rp >= 0.6) add("rangePos", 5, `selling the upper range (${Math.round(rp * 100)}%)`, true);
      else if (!long && rp <= 0.1) add("rangePos", -5, `selling the very bottom of the range (${Math.round(rp * 100)}%)`, false);
    }

    // SO-9: NO blanket "RSI ≥ 82 → penalty". Overbought in an uptrend is healthy
    // momentum, not a reason to fade. RSI only matters when the entry FIGHTS an
    // extreme reading (fading a rip / catching a knife) — one feature, extremes
    // only, and only counter-trend.
    if (!primaryWithTrend && ta.rsi !== undefined) {
      const extreme = (!long && ta.rsi >= 80) || (long && ta.rsi <= 20);
      if (extreme) add("fadingExtreme", -12, `fading extreme momentum (RSI ${ta.rsi})`, false);
    }

    // Stale limit far from market (deliberate scale-in adds are not stale).
    if (ta.entryStale) {
      add("staleEntry", -8, `stale/mismatched entry — ${ta.entryVsPricePct! > 0 ? "+" : ""}${ta.entryVsPricePct?.toFixed(1)}% from live price`, false);
    }

    // Funding crowding — a mild contrarian flag.
    if (ta.funding !== undefined) {
      const crowded = long ? ta.funding > 0.0004 : ta.funding < -0.0004;
      if (crowded) add("funding", -5, `crowded funding (${(ta.funding * 100).toFixed(3)}%)`, false);
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  // Three zones (1.4): the model is allowed to say "no edge detectable".
  const stance: SecondOpinionVerdict["stance"] = score > 60 ? "positive" : score < 40 ? "negative" : "neutral";
  return {
    stance,
    score,
    summary: ta ? `Heuristic: ${good.concat(red).join("; ") || "neutral setup"}.` : "No candle data — no technical read.",
    redFlags: red,
    strengths: good,
    source: "heuristic",
    confidence: ta ? 0.45 : 0.2,
    contributions,
  };
}

/**
 * Degeneration alarm (dev-brief 1.4): if the share of POSITIVE verdicts over the
 * last N signals collapses (< 15%) or saturates (> 85%), the scorer has drifted
 * into a rubber-stamp — exactly the "74/81 negative" state that went unnoticed.
 * Logs a warning so it can never happen silently again.
 */
function checkDegeneration(): void {
  const recent = repo.list(30).filter((o) => o.verdict);
  if (recent.length < 20) return; // too few to judge
  const pos = recent.filter((o) => o.verdict!.stance === "positive").length;
  const share = pos / recent.length;
  if (share < 0.15 || share > 0.85) {
    event(
      "review",
      `⚠ Second Opinion degeneration: only ${(share * 100).toFixed(0)}% positive over the last ${recent.length} verdicts — the scorer has drifted to a rubber-stamp. Review the rule calibration.`,
      { positiveShare: share, sample: recent.length },
      { level: "warn" },
    );
  }
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
    // The SO runs at parse time, before the branch-specific signal record exists,
    // so callers often have no signalId yet. Use a stable correlation id so the
    // SO row and its point-in-time features share a key (Phase-2 joins depend on
    // it); it falls back to a fresh id only when none was supplied.
    const sid = signalId ?? nanoid();

    event(
      "review",
      `Second Opinion: analyzing ${parsed.side.toUpperCase()} ${symbol} (${group.name})`,
      { symbol, side: parsed.side, entry: parsed.entry, stopLoss: parsed.stopLoss, takeProfits: parsed.takeProfits, hasChart: (images?.length ?? 0) > 0 },
      { level: "info", groupId: group.id, signalId: sid },
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

    // Phase 2: log point-in-time features (observe-only, never blocks the SO).
    if (sid) {
      void logSignalFeatures(group, parsed, sid, {
        byTf,
        ctx,
        frames: frames.map((f) => ({ interval: f.interval, trend: f.trend })),
        price: ta?.price ?? byTf["1h"]?.[byTf["1h"].length - 1]?.c ?? 0,
        atrHorizon: undefined,
      });
    }

    event(
      "review",
      ta
        ? `Data: candles [${FRAMES.map((tf) => `${tf}:${byTf[tf]?.length ?? 0}`).join(" ")}] · MTF ${ta.mtfAlignment} · trend ${ta.trend} · RSI ${ta.rsi} · SL ${ta.slAtrMultiple?.toFixed(2)}xATR · R/R ${ta.rrClaimed?.toFixed(1) ?? "?"}→${ta.rrRealistic?.toFixed(1) ?? "?"}` +
            (ta.entryStale ? ` · ⚠ STALE entry (${ta.entryVsPricePct! > 0 ? "+" : ""}${ta.entryVsPricePct?.toFixed(1)}% vs live)` : "") +
            (ta.funding !== undefined ? ` · funding ${(ta.funding * 100).toFixed(4)}%` : "")
        : `Data: no usable candles for ${symbol} — judging from chart/heuristic only`,
      { candleCounts: Object.fromEntries(FRAMES.map((tf) => [tf, byTf[tf]?.length ?? 0])), marketContext: ctx, ta },
      { level: "info", groupId: group.id, signalId: sid },
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
      signalId: sid,
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
    checkDegeneration();
    event(
      "review",
      `Verdict ${symbol} ${parsed.side.toUpperCase()}: ${verdict.stance.toUpperCase()} ${verdict.score}/100 (${verdict.source}, conf ${verdict.confidence.toFixed(2)}) — ${verdict.summary}` +
        (verdict.redFlags.length ? ` · ⚠ ${verdict.redFlags.join("; ")}` : "") +
        (verdict.strengths.length ? ` · ✓ ${verdict.strengths.join("; ")}` : "") +
        (ta?.suggestion ? ` · ${ta.suggestion.note}` : ""),
      { verdict, providerLevels: { entry: parsed.entry, stopLoss: parsed.stopLoss, takeProfits: parsed.takeProfits }, ourLevels: ta?.suggestion },
      { level: verdict.stance === "negative" ? "warn" : "info", groupId: group.id, signalId: sid },
    );
  } catch (err) {
    log.warn("second-opinion generation failed:", err instanceof Error ? err.message : err);
  }
}

/* ------------------------ claim verification (B) ------------------------ */

/** Timeout horizon per second-opinion (ms). Default 14 d (SO-2); overridable
 *  later from a trader's median hold time. */
const TIMEOUT_HORIZON_MS = 14 * 86_400_000;
/** How long a limit entry may wait for a fill before it is `notFilled` (SO-3). */
const FILL_WINDOW_MS = 3 * 86_400_000;

async function verifyOne(op: SecondOpinion): Promise<void> {
  const createdMs = new Date(op.createdAt).getTime();
  let candles: Candle[] = [];
  try {
    candles = await activeHyperliquid().getCandles(op.symbol, "15m", createdMs, Date.now());
  } catch {
    return;
  }
  if (candles.length === 0) return;

  // SO-1/2/3/3b: clean, look-ahead-free outcome via the pure engine.
  const outcome = computeOutcome(
    {
      side: op.side,
      entry: op.entry,
      stopLoss: op.stopLoss,
      takeProfits: op.takeProfits,
      createdMs,
    },
    candles,
    { timeoutHorizonMs: TIMEOUT_HORIZON_MS, fillWindowMs: FILL_WINDOW_MS },
  );
  if (!outcome) return;
  repo.setOutcome(op.id, outcome);

  // Log the moment a call RESOLVES (once), so the full lifecycle is traceable.
  if (!op.outcome?.resolved && outcome.resolved) {
    const called = op.verdict?.stance;
    const cls = outcome.outcomeClass;
    // Only win/loss are scored against the stance; timeout/scratch/notFilled/
    // ambiguous carry no verdict judgement (SO-2/SO-3).
    let rightWrong = "no scored outcome";
    if (called && (cls === "win" || cls === "loss")) {
      const good = cls === "win";
      const positive = called === "positive";
      rightWrong = called === "neutral" ? "neutral call" : good === positive ? "our call RIGHT" : "our call WRONG";
    }
    const headline =
      cls === "win"
        ? "WIN (TP first)"
        : cls === "loss"
          ? "LOSS (SL first)"
          : cls === "timeout"
            ? `TIMEOUT (${outcome.rAtClose ?? "?"}R at close)`
            : cls === "notFilled"
              ? "NOT FILLED (limit never traded through)"
              : cls === "ambiguous"
                ? "AMBIGUOUS (fill/SL same bar)"
                : "resolved";
    event(
      "review",
      `Outcome ${op.symbol} ${op.side.toUpperCase()}: ${headline}` +
        (outcome.hoursToFirstHit !== undefined ? ` after ${outcome.hoursToFirstHit}h` : "") +
        ` · MFE ${outcome.mfePct}% / MAE ${outcome.maePct}% · mfeR ${outcome.maxR ?? "?"} / maeR ${outcome.maeR ?? "?"}` +
        (cls === "win" || cls === "loss" ? ` · ${rightWrong} (we were ${called ?? "—"})` : ""),
      { outcome, ourStance: called },
      { level: "info", groupId: op.groupId, signalId: op.signalId },
    );
  }
}

export async function verifySecondOpinions(): Promise<void> {
  // SO-2: the fetch/verify window must exceed the timeout horizon + fill window
  // so chop trades actually reach a `timeout` resolution instead of hanging.
  const since = new Date(Date.now() - 21 * 86_400_000).toISOString();
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
