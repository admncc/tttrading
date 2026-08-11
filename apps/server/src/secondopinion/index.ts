import type { Group, ParsedSignal, SecondOpinion, SecondOpinionTA, SecondOpinionVerdict } from "@tttrading/shared";
import { log } from "../logger.js";
import { activeHyperliquid } from "../exchanges/registry.js";
import { secondOpinions as repo } from "../db/repositories.js";
import { proAnalystReview, type SignalImage } from "../signals/llm.js";
import { broadcast } from "../ws/hub.js";

type Candle = { t: number; o: number; h: number; l: number; c: number };

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
  const slice = trs.slice(-period);
  return slice.reduce((s, x) => s + x, 0) / (slice.length || 1);
}

/** Pivot swing highs/lows (a bar that is the extreme of a ±window). */
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

function computeTA(candles: Candle[], parsed: ParsedSignal, interval: string): SecondOpinionTA | undefined {
  if (candles.length < 30) return undefined;
  const closes = candles.map((c) => c.c);
  const price = closes[closes.length - 1]!;
  const emaFast = ema(closes, 20);
  const emaMid = ema(closes, 50);
  const emaSlow = ema(closes, Math.min(200, closes.length));
  const a = atr(candles, 14);
  const { highs, lows } = pivots(candles, 3);
  const resAbove = highs.filter((h) => h > price).sort((x, y) => x - y);
  const supBelow = lows.filter((l) => l < price).sort((x, y) => y - x);
  const resistance = resAbove[0] ?? Math.max(...candles.map((c) => c.h));
  const support = supBelow[0] ?? Math.min(...candles.map((c) => c.l));

  let trend: SecondOpinionTA["trend"] = "sideways";
  if (emaFast > emaMid && emaMid > emaSlow && price > emaSlow) trend = "up";
  else if (emaFast < emaMid && emaMid < emaSlow && price < emaSlow) trend = "down";

  const entry = parsed.entry ?? price;
  const sl = parsed.stopLoss;
  const tp1 = parsed.takeProfits?.[0];
  const long = parsed.side === "long";
  const risk = sl !== undefined ? Math.abs(entry - sl) : undefined;
  const rrClaimed = risk && risk > 0 && tp1 !== undefined ? Math.abs(tp1 - entry) / risk : undefined;
  const rewardRealistic = long ? resistance - entry : entry - support;
  const rrRealistic = risk && risk > 0 && rewardRealistic > 0 ? rewardRealistic / risk : undefined;
  const slAtrMultiple = risk && a > 0 ? risk / a : undefined;

  // Entry location vs the nearest opposing structure (within ~0.6 ATR = "into").
  let entryLocation: string | undefined;
  const near = (x: number, y: number) => a > 0 && Math.abs(x - y) <= 0.6 * a;
  if (long) {
    if (near(entry, resistance) || entry >= resistance) entryLocation = "long into resistance (poor location)";
    else if (near(entry, support)) entryLocation = "long off support (good location)";
  } else {
    if (near(entry, support) || entry <= support) entryLocation = "short into support (poor location)";
    else if (near(entry, resistance)) entryLocation = "short off resistance (good location)";
  }

  const r = (n: number) => Number(n.toPrecision(6));
  return {
    interval,
    price: r(price),
    trend,
    emaFast: r(emaFast),
    emaMid: r(emaMid),
    emaSlow: r(emaSlow),
    atr: r(a),
    atrPct: r(a / price),
    support: r(support),
    resistance: r(resistance),
    slAtrMultiple: slAtrMultiple !== undefined ? r(slAtrMultiple) : undefined,
    rrClaimed: rrClaimed !== undefined ? r(rrClaimed) : undefined,
    rrRealistic: rrRealistic !== undefined ? r(rrRealistic) : undefined,
    entryLocation,
  };
}

/** Rules-only verdict when the LLM is unavailable. */
function heuristicVerdict(parsed: ParsedSignal, ta?: SecondOpinionTA): SecondOpinionVerdict {
  let score = 50;
  const red: string[] = [], good: string[] = [];
  if (ta) {
    const aligned = (parsed.side === "long" && ta.trend === "up") || (parsed.side === "short" && ta.trend === "down");
    if (aligned) { score += 15; good.push(`trend-aligned (${ta.trend})`); }
    else if (ta.trend !== "sideways") { score -= 15; red.push(`against the ${ta.trend}trend`); }
    if (ta.rrRealistic !== undefined) {
      if (ta.rrRealistic >= 2) { score += 15; good.push(`good R/R to next level (${ta.rrRealistic.toFixed(1)})`); }
      else if (ta.rrRealistic < 1) { score -= 15; red.push(`poor realistic R/R (${ta.rrRealistic.toFixed(1)})`); }
    }
    if (ta.slAtrMultiple !== undefined && ta.slAtrMultiple < 1) { score -= 10; red.push(`SL inside 1x ATR (${ta.slAtrMultiple.toFixed(2)}) — wick-out risk`); }
    if (ta.entryLocation?.includes("poor")) { score -= 10; red.push(ta.entryLocation); }
    if (ta.entryLocation?.includes("good")) { score += 8; good.push(ta.entryLocation); }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    stance: score >= 50 ? "positive" : "negative",
    score,
    summary: ta ? `Heuristic read: ${good.concat(red).join("; ") || "neutral setup"}.` : "No candle data — no technical read.",
    redFlags: red,
    strengths: good,
    source: "heuristic",
    confidence: ta ? 0.4 : 0.2,
  };
}

/* --------------------------- generation (A) ----------------------------- */

/** Build an independent Second Opinion for one signal. Observe-only; never trades. */
export async function generateSecondOpinion(
  group: Group,
  parsed: ParsedSignal,
  images?: SignalImage[],
  signalId?: string,
): Promise<void> {
  try {
    const symbol = parsed.symbol.toUpperCase();
    let candles: Candle[] = [];
    try {
      const end = Date.now();
      const start = end - 30 * 86_400_000; // ~30 days of 1h candles
      candles = await activeHyperliquid().getCandles(symbol, "1h", start, end);
    } catch (err) {
      log.warn(`second-opinion: no candles for ${symbol}: ${err instanceof Error ? err.message : err}`);
    }
    const ta = computeTA(candles, parsed, "1h");

    const brief =
      `Signal from channel "${group.name}": ${parsed.side.toUpperCase()} ${symbol}\n` +
      `Entry: ${parsed.entry ?? "CMP"} · SL: ${parsed.stopLoss ?? "none"} · TPs: ${parsed.takeProfits?.join(", ") ?? "none"}\n\n` +
      (ta
        ? `Objective indicators (1h candles):\n` +
          `- price ${ta.price}, trend ${ta.trend} (EMA20 ${ta.emaFast} / EMA50 ${ta.emaMid} / EMA200 ${ta.emaSlow})\n` +
          `- ATR ${ta.atr} (${(ta.atrPct * 100).toFixed(2)}% of price)\n` +
          `- nearest support ${ta.support}, nearest resistance ${ta.resistance}\n` +
          `- SL distance = ${ta.slAtrMultiple?.toFixed(2) ?? "?"}x ATR\n` +
          `- R/R claimed to TP1: ${ta.rrClaimed?.toFixed(2) ?? "?"}; realistic R/R to next level: ${ta.rrRealistic?.toFixed(2) ?? "?"}\n` +
          `- entry location: ${ta.entryLocation ?? "n/a"}\n`
        : `No candle data available for objective indicators — judge from the chart image if present.\n`) +
      `\nGive your independent professional assessment of THIS setup.`;

    const review = await proAnalystReview(brief, group.settings.instructions, images);
    const verdict: SecondOpinionVerdict = review
      ? { ...review, source: "llm" }
      : heuristicVerdict(parsed, ta);

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
    log.info(`Second Opinion ${symbol} ${parsed.side}: ${verdict.stance} (${verdict.score}/100, ${verdict.source})`);
  } catch (err) {
    log.warn("second-opinion generation failed:", err instanceof Error ? err.message : err);
  }
}

/* ------------------------ claim verification (B) ------------------------ */

async function verifyOne(op: SecondOpinion): Promise<void> {
  const entry = op.entry;
  const createdMs = new Date(op.createdAt).getTime();
  const ageMs = Date.now() - createdMs;
  let candles: Candle[] = [];
  try {
    candles = await activeHyperliquid().getCandles(op.symbol, "15m", createdMs, Date.now());
  } catch {
    return;
  }
  if (candles.length === 0) return;
  const base = entry ?? candles[0]!.o;
  if (!(base > 0)) return;
  const long = op.side === "long";
  const tp1 = op.takeProfits?.[0];
  const sl = op.stopLoss;

  let maxHigh = -Infinity, minLow = Infinity;
  let firstHit: "tp" | "sl" | "none" = "none";
  for (const c of candles) {
    maxHigh = Math.max(maxHigh, c.h);
    minLow = Math.min(minLow, c.l);
    if (firstHit === "none") {
      const tpTouched = tp1 !== undefined && (long ? c.h >= tp1 : c.l <= tp1);
      const slTouched = sl !== undefined && (long ? c.l <= sl : c.h >= sl);
      // If a single candle spans both, assume SL first (conservative).
      if (slTouched) firstHit = "sl";
      else if (tpTouched) firstHit = "tp";
    }
  }
  const mfePct = long ? (maxHigh - base) / base : (base - minLow) / base;
  const maePct = long ? (base - minLow) / base : (maxHigh - base) / base;
  const tp1Hit = tp1 !== undefined ? (long ? maxHigh >= tp1 : minLow <= tp1) : undefined;
  const slHit = sl !== undefined ? (long ? minLow <= sl : maxHigh >= sl) : undefined;
  const resolved = firstHit !== "none" || ageMs > 14 * 86_400_000;

  repo.setOutcome(op.id, {
    checkedAt: new Date().toISOString(),
    mfePct: Number((mfePct * 100).toFixed(2)),
    maePct: Number((maePct * 100).toFixed(2)),
    tp1Hit,
    slHit,
    firstHit,
    resolved,
  });
}

/** Refresh outcomes for unresolved opinions from the last ~14 days. */
export async function verifySecondOpinions(): Promise<void> {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const open = repo.unresolvedSince(since);
  for (const op of open) {
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
