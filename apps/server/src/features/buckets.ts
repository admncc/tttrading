/**
 * Phase 2 — pure bucket statistics for feature reports (dev-brief §7). Given
 * per-signal feature values + outcomes, produce win-rate and expectancy per
 * bucket with n + Wilson CI. No modelling — this only describes the data.
 */
import { wilson, mean } from "../lib/metrics.js";

export interface SignalDatum {
  win: boolean | undefined; // undefined = not a scored win/loss
  rR?: number;              // realised R under the standard proxy
  feats: Record<string, number | string | undefined>;
}

export interface BucketStat {
  label: string;
  n: number;
  wins: number;
  winRate?: number;
  ciLo?: number;
  ciHi?: number;
  expectancyR?: number;
}

export interface FeatureReport {
  feature: string;
  kind: "numeric" | "categorical";
  buckets: BucketStat[];
  n: number;
}

const MIN_BUCKET = 15; // dev-brief leitplanke 5 — below this it's not a "finding"

function statOf(label: string, rows: SignalDatum[]): BucketStat {
  const scored = rows.filter((r) => r.win !== undefined);
  const wins = scored.filter((r) => r.win).length;
  const w = wilson(wins, scored.length);
  const rs = rows.map((r) => r.rR).filter((x): x is number => x !== undefined);
  return {
    label,
    n: scored.length,
    wins,
    winRate: scored.length ? w.p : undefined,
    ciLo: scored.length ? w.lo : undefined,
    ciHi: scored.length ? w.hi : undefined,
    expectancyR: rs.length ? mean(rs) : undefined,
  };
}

/** Quantile edges (quartiles by default) of a numeric array. */
function quantileEdges(vals: number[], q = 4): number[] {
  const s = [...vals].sort((a, b) => a - b);
  const edges: number[] = [];
  for (let i = 1; i < q; i++) edges.push(s[Math.floor((i / q) * s.length)] ?? s[s.length - 1]!);
  return [...new Set(edges)];
}

export function bucketFeature(signals: SignalDatum[], feature: string): FeatureReport {
  const present = signals.filter((s) => s.feats[feature] !== undefined);
  const numeric = present.filter((s) => typeof s.feats[feature] === "number");
  const distinctNums = new Set(numeric.map((s) => s.feats[feature] as number));
  // Low-cardinality numerics (0/1 flags, small integer codes) read better as
  // discrete buckets than as quantiles.
  const isNumeric = numeric.length >= present.length * 0.8 && present.length > 0 && distinctNums.size > 3;

  if (!isNumeric) {
    const byVal = new Map<string, SignalDatum[]>();
    for (const s of present) {
      const k = String(s.feats[feature]);
      (byVal.get(k) ?? byVal.set(k, []).get(k)!).push(s);
    }
    const buckets = [...byVal.entries()]
      .map(([label, rows]) => statOf(label, rows))
      .sort((a, b) => b.n - a.n);
    return { feature, kind: "categorical", buckets, n: present.length };
  }

  const vals = numeric.map((s) => s.feats[feature] as number);
  const edges = quantileEdges(vals, 4);
  const label = (lo: number | undefined, hi: number | undefined) =>
    lo === undefined ? `≤ ${hi!.toFixed(3)}` : hi === undefined ? `> ${lo.toFixed(3)}` : `${lo.toFixed(3)}–${hi.toFixed(3)}`;
  const bounds = [undefined, ...edges, undefined] as (number | undefined)[];
  const buckets: BucketStat[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i], hi = bounds[i + 1];
    const rows = numeric.filter((s) => {
      const v = s.feats[feature] as number;
      return (lo === undefined || v >= lo) && (hi === undefined || v < hi);
    });
    if (rows.length) buckets.push(statOf(label(lo, hi), rows));
  }
  return { feature, kind: "numeric", buckets, n: present.length };
}

/** Render a feature report to markdown lines. */
export function renderFeatureReport(r: FeatureReport): string[] {
  const L: string[] = [];
  L.push(`### ${r.feature} (${r.kind}, n=${r.n})`);
  L.push(`| bucket | n | win-rate (95% CI) | expectancy R |`);
  L.push(`|---|---|---|---|`);
  for (const b of r.buckets) {
    const wr = b.winRate === undefined || b.n === 0
      ? "—"
      : `${(b.winRate * 100).toFixed(1)}% (${(b.ciLo! * 100).toFixed(0)}–${(b.ciHi! * 100).toFixed(0)})${b.n < MIN_BUCKET ? " ·small" : ""}`;
    const e = b.expectancyR === undefined ? "—" : `${b.expectancyR >= 0 ? "+" : ""}${b.expectancyR.toFixed(2)}R`;
    L.push(`| ${b.label} | ${b.n} | ${wr} | ${e} |`);
  }
  return L;
}

export { MIN_BUCKET };
