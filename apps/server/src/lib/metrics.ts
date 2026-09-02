/**
 * Pure trade-metrics maths shared by the server (Risk Insights API) and the web
 * desk (Risk Insights page). Kept dependency-free and deterministic so both
 * sides compute identical numbers and the formulas can be frozen as regression
 * tests (the Phase-0 audit verified SQN, R-sign and slippage as correct).
 */

export type TradeOutcomeClass = "win" | "loss" | "scratch";

/**
 * R-multiple = realised net PnL / INITIAL risk (RI-3). Using the risk at entry —
 * not the post-partial size — keeps R, expectancy and SQN honest when a trade is
 * scaled out: 50% off at +1R then the rest at +2R is +1.5R, not +2R.
 */
export function rMultiple(net: number, initialRisk: number | undefined): number | undefined {
  if (initialRisk === undefined || !(initialRisk > 0) || !Number.isFinite(net)) return undefined;
  return net / initialRisk;
}

/**
 * Classify a settled trade (RI-4). A near-zero result is `scratch` — neither win
 * nor loss — so it is excluded from win-rate but still counts in expectancy.
 * Threshold is in R when an R-multiple is known, else a tiny USD epsilon.
 */
export function classifyOutcome(
  net: number,
  r: number | undefined,
  scratchR = 0.1,
): TradeOutcomeClass {
  if (r !== undefined && Number.isFinite(r)) {
    if (Math.abs(r) <= scratchR) return "scratch";
    return r > 0 ? "win" : "loss";
  }
  if (Math.abs(net) < 1e-9) return "scratch";
  return net > 0 ? "win" : "loss";
}

/** Sample mean. */
export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

/** Sample standard deviation (Bessel-corrected, n−1). Undefined for n < 2. */
export function stdSample(xs: number[]): number | undefined {
  const n = xs.length;
  if (n < 2) return undefined;
  const m = mean(xs);
  const varr = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1);
  return Math.sqrt(varr);
}

/**
 * Van Tharp System Quality Number = mean(R) / std(R) × √N, with N capped at 100
 * so a large sample can't inflate the score. Undefined when < 2 R-values or a
 * degenerate (zero) spread.
 */
export function sqn(rs: number[]): number | undefined {
  if (rs.length < 2) return undefined;
  const m = mean(rs);
  const sd = stdSample(rs);
  if (sd === undefined || !(sd > 0)) return undefined;
  return (m / sd) * Math.sqrt(Math.min(rs.length, 100));
}

/** Profit factor = gross wins / gross losses. Undefined with no losing $. */
export function profitFactor(nets: number[]): number | undefined {
  const grossWin = nets.filter((n) => n > 0).reduce((s, n) => s + n, 0);
  const grossLoss = -nets.filter((n) => n < 0).reduce((s, n) => s + n, 0);
  return grossLoss > 0 ? grossWin / grossLoss : undefined;
}

/**
 * Geometry / gambler's-ruin baseline P(TP first) with no drift = slDist /
 * (slDist + tpDist). A 3R setup ⇒ 25% baseline win-rate. Every model must beat
 * this in Brier to be worth anything (dev-brief 4.1 / P1-R5).
 */
export function geoBaselineP(entry: number, stop: number, tp: number): number | undefined {
  const slDist = Math.abs(entry - stop);
  const tpDist = Math.abs(tp - entry);
  const denom = slDist + tpDist;
  return denom > 0 ? slDist / denom : undefined;
}

/** Brier score = mean((p − outcome)²) over binary outcomes. Lower is better. */
export function brier(preds: { p: number; win: boolean }[]): number | undefined {
  if (!preds.length) return undefined;
  return preds.reduce((s, x) => s + (x.p - (x.win ? 1 : 0)) ** 2, 0) / preds.length;
}

/**
 * Honest top-vs-bottom discrimination sentence (P1-R3): derived from the actual
 * win-rate delta, never a hard-coded direction, and suppressed when either zone
 * is below `minN` (leitplanke 5). Returns { text, direction } where direction is
 * +1 (top wins more), −1 (bottom wins more) or 0 (tie / too small).
 */
export function discriminationNote(
  wrTop: number | undefined, nTop: number,
  wrBottom: number | undefined, nBottom: number,
  minN = 15,
): { text: string; direction: -1 | 0 | 1 } {
  if (nTop < minN || nBottom < minN || wrTop === undefined || wrBottom === undefined) {
    return { text: `n too small for a directional read (top n=${nTop}, bottom n=${nBottom}; need ≥${minN} each)`, direction: 0 };
  }
  const d = wrTop - wrBottom;
  const dir = d > 0 ? 1 : d < 0 ? -1 : 0;
  const word = dir > 0 ? "correct direction (top zone wins more)" : dir < 0 ? "WRONG direction (bottom zone wins more)" : "no separation";
  return { text: `top ${(wrTop * 100).toFixed(1)}% vs bottom ${(wrBottom * 100).toFixed(1)}% → ${word}`, direction: dir };
}

export interface WilsonInterval { p: number; lo: number; hi: number; n: number }

/**
 * Wilson score interval for a proportion — the honest error bar on a win-rate
 * from a small sample (the dev-brief mandates n + CI on every rate). z = 1.96 is
 * the 95% interval.
 */
export function wilson(successes: number, n: number, z = 1.96): WilsonInterval {
  if (n <= 0) return { p: 0, lo: 0, hi: 0, n: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return { p, lo: Math.max(0, (centre - margin) / denom), hi: Math.min(1, (centre + margin) / denom), n };
}
