import type { SecondOpinionOutcome, TradeSide } from "@tttrading/shared";

/** A single OHLCV bar. */
export type OutcomeCandle = { t: number; o: number; h: number; l: number; c: number; v?: number };

/** The minimal signal shape the outcome engine needs. */
export interface OutcomeInput {
  side: TradeSide;
  /** Provider entry. Present ⇒ treated as a LIMIT (must trade through to fill).
   *  Absent ⇒ CMP/market (filled at the first bar's open, at the signal time). */
  entry?: number;
  stopLoss?: number;
  takeProfits?: number[];
  /** Signal timestamp (ms). */
  createdMs: number;
}

export interface OutcomeOptions {
  /** How long a limit may wait for a fill before it is `notFilled` (ms). Default 3 d. */
  fillWindowMs?: number;
  /** No TP/SL within this horizon ⇒ `timeout` measured to the last bar's close (ms). Default 14 d. */
  timeoutHorizonMs?: number;
  /** "now" for age math (ms). Default Date.now(). */
  nowMs?: number;
}

const DAY = 86_400_000;

/**
 * Compute a clean, look-ahead-free outcome for a second-opinion signal from
 * OHLCV bars, fixing the Phase-0 measurement bugs:
 *
 *  - SO-1: favorable excursion is cut at the SL bar for losers (and adverse at
 *    the TP bar for winners) — a stopped-out trade that later rallies does NOT
 *    count as favorable.
 *  - SO-2: `timeout` is its own class carrying `rAtClose` (R at the horizon
 *    close); it is neither a win nor a loss.
 *  - SO-3: a limit entry only starts measuring once a bar trades THROUGH the
 *    entry; never filled inside the validity window ⇒ `notFilled` (no outcome).
 *  - SO-3b: fill and SL in the same bar (order indeterminable without finer
 *    data) ⇒ `ambiguous`. TP and SL in the same resolving bar ⇒ `ambiguous`.
 *
 * Pure and deterministic: no DB, no network, no clock except `opts.nowMs`.
 */
export function computeOutcome(
  sig: OutcomeInput,
  candles: OutcomeCandle[],
  opts: OutcomeOptions = {},
): SecondOpinionOutcome | undefined {
  if (candles.length === 0) return undefined;
  const fillWindowMs = opts.fillWindowMs ?? 3 * DAY;
  const timeoutHorizonMs = opts.timeoutHorizonMs ?? 14 * DAY;
  const nowMs = opts.nowMs ?? Date.now();
  const long = sig.side === "long";
  const tps = (sig.takeProfits ?? []).filter((t) => Number.isFinite(t));
  const tp1 = tps[0];
  const sl = sig.stopLoss;

  // --- SO-3: fill detection -------------------------------------------------
  // CMP/market (no provider entry): filled at the first bar's open.
  // Limit (entry set): filled by the first bar that trades through the entry,
  // within the validity window.
  let fillIdx = 0;
  let base: number;
  let fillMs = candles[0]!.t;
  if (sig.entry === undefined) {
    base = candles[0]!.o;
  } else {
    base = sig.entry;
    const fillDeadline = sig.createdMs + fillWindowMs;
    let found = -1;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i]!;
      if (c.t > fillDeadline) break;
      if (c.l <= sig.entry && sig.entry <= c.h) {
        found = i;
        fillMs = c.t;
        break;
      }
    }
    if (found < 0) {
      // Never traded through the entry inside the window ⇒ no outcome at all.
      return {
        checkedAt: new Date(nowMs).toISOString(),
        mfePct: 0,
        maePct: 0,
        firstHit: "none",
        resolved: nowMs > fillDeadline, // terminal only once the window has passed
        outcomeClass: nowMs > fillDeadline ? "notFilled" : undefined,
        filled: false,
      };
    }
    fillIdx = found;
  }
  if (!(base > 0)) return undefined;

  const risk = sl !== undefined ? Math.abs(base - sl) : undefined;

  // --- SO-3b: fill and SL in the SAME bar ⇒ order indeterminable ------------
  const fillBar = candles[fillIdx]!;
  const slTouchedOnFill = sl !== undefined && (long ? fillBar.l <= sl : fillBar.h >= sl);
  // Only ambiguous when the fill itself needed intrabar travel (a limit): a
  // market fill at the open with SL also in that bar is a genuine fast loss.
  if (sig.entry !== undefined && slTouchedOnFill && fillBar.o !== sl) {
    return {
      checkedAt: new Date(nowMs).toISOString(),
      mfePct: 0,
      maePct: 0,
      firstHit: "none",
      resolved: true,
      outcomeClass: "ambiguous",
      filled: true,
    };
  }

  // --- walk from the fill bar, cutting excursion at the resolving bar (SO-1) -
  let maxHigh = -Infinity;
  let minLow = Infinity;
  let firstHit: "tp" | "sl" | "none" = "none";
  let hitMs: number | undefined;
  let ambiguousBar = false;
  for (let i = fillIdx; i < candles.length; i++) {
    const c = candles[i]!;
    maxHigh = Math.max(maxHigh, c.h);
    minLow = Math.min(minLow, c.l);
    const tpTouched = tp1 !== undefined && (long ? c.h >= tp1 : c.l <= tp1);
    const slTouched = sl !== undefined && (long ? c.l <= sl : c.h >= sl);
    if (tpTouched && slTouched) {
      // Both in one bar and we have no finer data → cannot order them.
      ambiguousBar = true;
      hitMs = c.t;
      break;
    }
    if (slTouched) { firstHit = "sl"; hitMs = c.t; break; }
    if (tpTouched) { firstHit = "tp"; hitMs = c.t; break; }
  }

  if (ambiguousBar) {
    return {
      checkedAt: new Date(nowMs).toISOString(),
      mfePct: 0,
      maePct: 0,
      firstHit: "none",
      resolved: true,
      outcomeClass: "ambiguous",
      filled: true,
    };
  }

  // Excursion is measured only through the resolving bar (loop breaks there),
  // so a later rally after an SL hit is excluded (SO-1), and vice-versa.
  const mfe = long ? maxHigh - base : base - minLow;
  const mae = long ? base - minLow : maxHigh - base;
  const mfePct = (mfe / base) * 100;
  const maePct = (mae / base) * 100;
  const mfeR = risk && risk > 0 ? mfe / risk : undefined;
  const maeR = risk && risk > 0 ? mae / risk : undefined;
  const maxR = mfeR; // kept for back-compat (best favorable excursion in R)
  const hoursToFirstHit = hitMs ? Number(((hitMs - fillMs) / 3_600_000).toFixed(1)) : undefined;

  const tp1Hit = firstHit === "tp" ? true : firstHit === "sl" ? false : undefined;
  const slHit = firstHit === "sl" ? true : firstHit === "tp" ? false : undefined;

  let outcomeClass: SecondOpinionOutcome["outcomeClass"];
  let rAtClose: number | undefined;
  let resolved: boolean;
  if (firstHit === "tp") {
    outcomeClass = "win";
    resolved = true;
  } else if (firstHit === "sl") {
    outcomeClass = "loss";
    resolved = true;
  } else {
    // No TP/SL touched anywhere in the fetched window.
    const ageFromFill = nowMs - fillMs;
    if (ageFromFill >= timeoutHorizonMs) {
      outcomeClass = "timeout";
      resolved = true;
      // R at the last observed close within the horizon.
      const last = candles[candles.length - 1]!;
      const signed = long ? last.c - base : base - last.c;
      rAtClose = risk && risk > 0 ? Number((signed / risk).toFixed(2)) : undefined;
    } else {
      outcomeClass = undefined; // still open, keep verifying
      resolved = false;
    }
  }

  const allTpHit =
    tps.length > 0 && firstHit === "tp"
      ? tps.every((t) => (long ? maxHigh >= t : minLow <= t))
      : firstHit === "sl"
        ? false
        : undefined;

  return {
    checkedAt: new Date(nowMs).toISOString(),
    mfePct: Number(mfePct.toFixed(2)),
    maePct: Number(maePct.toFixed(2)),
    tp1Hit,
    slHit,
    firstHit,
    resolved,
    hoursToFirstHit,
    maxR: maxR !== undefined ? Number(maxR.toFixed(2)) : undefined,
    maeR: maeR !== undefined ? Number(maeR.toFixed(2)) : undefined,
    allTpHit,
    outcomeClass,
    filled: true,
    rAtClose,
  };
}
