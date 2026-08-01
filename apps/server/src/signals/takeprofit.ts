import type { TradeSide } from "@tttrading/shared";

/** Trim float noise while keeping enough precision for any price magnitude. */
function clean(x: number): number {
  return Number(x.toPrecision(8));
}

/**
 * Expand take-profit levels for execution.
 *
 * Many signal providers give only a single take-profit target and expect the
 * position to be scaled out over several levels. When exactly one TP is present
 * and auto-split is enabled, generate `levels` equally-spaced levels between the
 * entry and that target (the last level is the target itself). Signals that
 * already list multiple TPs are returned unchanged.
 *
 * Works for both directions: for a short the levels descend from entry towards
 * the (lower) target; for a long they ascend.
 */
export function expandTakeProfits(
  takeProfits: number[] | undefined,
  entry: number,
  _side: TradeSide,
  opts: { autoSplit: boolean; levels: number },
): number[] {
  const list = (takeProfits ?? []).filter((n) => Number.isFinite(n));
  if (!opts.autoSplit || list.length !== 1) return list;

  const n = Math.max(2, Math.floor(opts.levels));
  const target = list[0]!;
  if (!Number.isFinite(entry) || entry === target) return list;

  const step = (target - entry) / n;
  const out: number[] = [];
  for (let i = 1; i <= n; i++) out.push(clean(entry + step * i));
  out[out.length - 1] = target; // avoid accumulated rounding drift
  return out;
}
