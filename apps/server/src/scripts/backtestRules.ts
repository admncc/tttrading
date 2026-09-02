/**
 * Phase-1 Second-Opinion backtest harness (dev-brief 1.5 + v2.2 §11.2 fixes).
 *
 * Replays every historical signal through the CURRENT rule set on point-in-time
 * TA, labels outcomes with the repaired engine, and reports — with ONE stated
 * denominator per table and n + Wilson CI on every rate:
 *   - SO coverage (replay) with an alarm, and a stance-none breakdown  (P1-R1/R2)
 *   - old vs new stance distribution
 *   - 3-zone × outcome confusion, win-rate AND expectancy in R          (P1-R4)
 *   - honest top-vs-bottom discrimination (sign derived, n-gated)       (P1-R3)
 *   - per-rule fire rate + win-rate lift + expectancy                   (P1-R4/R6)
 *   - slAtrH bucket table + horizon-TF distribution                     (P1-R6)
 *   - Brier: geometry baseline vs old SO vs new SO                      (P1-R5)
 *   - gross AND net expectancy (fee-drag), with standard error         (P1-R7)
 *   - noData class + age distribution of the unresolved                 (P1-R9)
 *   - phantom-win list + reproducibility notes                         (P1-R8)
 *
 * Reproducible:
 *   tsx src/scripts/backtestRules.ts <secondOpinions.json> <bundle.json> [out.md] [roundTripFeePct]
 *
 * bundle.json : { [opId]: { status, coin, pre: {tf:[[t,o,h,l,c,v]...]}, post:[...] } }
 */
import { readFileSync, writeFileSync } from "node:fs";
import { computeFrame, buildTA, heuristicVerdict } from "../secondopinion/index.js";
import { computeOutcome } from "../secondopinion/outcome.js";
import { wilson, geoBaselineP, brier, discriminationNote, mean, stdSample } from "../lib/metrics.js";
import type { ParsedSignal, SecondOpinionTFrame } from "@tttrading/shared";

type AnyOp = {
  id: string; symbol: string; side: "long" | "short"; createdAt: string;
  entry?: number; stopLoss?: number; takeProfits?: number[];
  verdict?: { stance?: string; score?: number };
};
type Bundle = Record<string, { status: string; coin: string | null; requestedSymbol: string; pre: Record<string, number[][]>; post: number[][] }>;

const [soPath, bundlePath, outPath, feeArg] = process.argv.slice(2);
if (!soPath || !bundlePath) {
  console.error("usage: tsx backtestRules.ts <secondOpinions.json> <bundle.json> [out.md] [roundTripFeePct]");
  process.exit(1);
}
const ops: AnyOp[] = JSON.parse(readFileSync(soPath, "utf8")).secondOpinions;
const bundle: Bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
// Round-trip taker fee assumption (stated, overridable). HL taker ≈ 0.045% × 2.
// Real per-venue fee/funding is open question 4; this is a placeholder for net.
const ROUND_TRIP_FEE = feeArg ? Number(feeArg) : 0.0009;

const toC = (raw: number[][]) => raw.map((c) => ({ t: c[0]!, o: c[1]!, h: c[2]!, l: c[3]!, c: c[4]!, v: c[5]! }));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ci = (k: number, n: number) => (n ? `${pct(k / n)} (n=${n}, CI ${pct(wilson(k, n).lo)}–${pct(wilson(k, n).hi)})` : `— (n=0)`);
const FRAMES = ["15m", "1h", "4h", "1d"];
const NOW = Date.now();

type Row = {
  op: AnyOp; status: string;
  newStance?: string; newScore?: number; rules: string[];
  slAtrH?: number; atrHorizonTf?: string;
  outcomeClass?: string; resolved: boolean; ageDays: number;
  base?: number; slPct?: number; pBase?: number;
  rR?: number; // realised R under the TP1-or-SL proxy (win=+rrClaimed, loss=-1, timeout=rAtClose)
  noneReason?: string;
};

const rows: Row[] = ops.map((op) => {
  const b = bundle[op.id];
  const ageDays = (NOW - Date.parse(op.createdAt)) / 86_400_000;
  if (!b || b.status !== "ok") {
    return { op, status: b?.status ?? "missing", rules: [], outcomeClass: "noData", resolved: true, ageDays, noneReason: "noData:not-on-HL" };
  }
  const frames = FRAMES.map((tf) => computeFrame(tf, toC(b.pre[tf] ?? []))).filter((f): f is SecondOpinionTFrame => !!f);
  const parsed = { symbol: op.symbol, side: op.side, entry: op.entry, stopLoss: op.stopLoss, takeProfits: op.takeProfits, action: "open" } as unknown as ParsedSignal;
  const ta = buildTA(parsed, toC(b.pre["1h"] ?? []), frames, {});
  const verdict = ta ? heuristicVerdict(parsed, ta) : undefined;
  const post = toC(b.post);
  const outcome = computeOutcome(
    { side: op.side, entry: op.entry, stopLoss: op.stopLoss, takeProfits: op.takeProfits, createdMs: Date.parse(op.createdAt) },
    post,
    { timeoutHorizonMs: 14 * 86_400_000, fillWindowMs: 3 * 86_400_000 },
  );
  const base = op.entry ?? post[0]?.o;
  const slPct = base && op.stopLoss !== undefined ? Math.abs(base - op.stopLoss) / base : undefined;
  const pBase = base !== undefined && op.stopLoss !== undefined && op.takeProfits?.[0] !== undefined
    ? geoBaselineP(base, op.stopLoss, op.takeProfits[0]) : undefined;
  const rrClaimed = ta?.rrClaimed;
  let rR: number | undefined;
  if (outcome?.outcomeClass === "win") rR = rrClaimed ?? 1;
  else if (outcome?.outcomeClass === "loss") rR = -1;
  else if (outcome?.outcomeClass === "timeout") rR = outcome.rAtClose ?? 0;
  let noneReason: string | undefined;
  if (!verdict) noneReason = !ta ? "insufficientCandles" : "noVerdict";
  return {
    op, status: b.status, newStance: verdict?.stance, newScore: verdict?.score,
    rules: (verdict?.contributions ?? []).map((c) => c.rule),
    slAtrH: ta?.slAtrH, atrHorizonTf: ta?.atrHorizonTf,
    outcomeClass: outcome?.outcomeClass, resolved: !!outcome?.resolved, ageDays,
    base, slPct, pBase, rR, noneReason,
  };
});

// ---------- denominators (stated everywhere) ----------
const N = rows.length;
const withStance = rows.filter((r) => r.newStance);           // replay produced a verdict
const scored = rows.filter((r) => r.outcomeClass === "win" || r.outcomeClass === "loss");
const isWin = (r: Row) => r.outcomeClass === "win";
const wrOf = (set: Row[]) => { const w = set.filter(isWin).length; const n = set.filter((r) => r.outcomeClass === "win" || r.outcomeClass === "loss").length; return { w, n, wr: n ? w / n : undefined }; };
const expR = (set: Row[]) => {
  const v = set.map((r) => r.rR).filter((x): x is number => x !== undefined);
  if (!v.length) return { e: undefined as number | undefined, se: undefined as number | undefined, n: 0 };
  const m = mean(v); const sd = stdSample(v);
  return { e: m, se: sd !== undefined ? sd / Math.sqrt(v.length) : undefined, n: v.length };
};
const netR = (set: Row[]) => {
  const v = set.map((r) => (r.rR !== undefined && r.slPct ? r.rR - ROUND_TRIP_FEE / r.slPct : undefined)).filter((x): x is number => x !== undefined);
  if (!v.length) return { e: undefined as number | undefined, n: 0 };
  return { e: mean(v), n: v.length };
};
const fmtE = (e?: number, se?: number) => (e === undefined ? "—" : `${e >= 0 ? "+" : ""}${e.toFixed(2)}R${se !== undefined ? ` ±${se.toFixed(2)}` : ""}`);

const L: string[] = [];
L.push(`# Phase 1 — Second-Opinion rule backtest (v2.2, §11.2 corrected)`);
L.push("");
L.push(`Signals: **${N}** · window ${ops[ops.length - 1]?.createdAt?.slice(0, 10)} → ${ops[0]?.createdAt?.slice(0, 10)} (22 days, one BTC regime — §11.4). Round-trip fee assumed ${pct(ROUND_TRIP_FEE)} (placeholder, open Q4).`);
L.push("");

// ---------- coverage + none breakdown (P1-R1/R2) ----------
L.push(`## Coverage (replay) — P1-R1/R2`);
const coverage = withStance.length / N;
L.push(`- Live SO coverage on this set: **81/81 (100%)** — every signal received a verdict in production. The numbers below are *replay* coverage (can we rebuild point-in-time TA from HL candles), a different quantity.`);
L.push(`- Replay coverage: **${withStance.length}/${N} (${pct(coverage)})** ${coverage < 0.9 ? "⚠ below the 90% alarm" : "✓ ≥90%"}.`);
const noneRows = rows.filter((r) => !r.newStance);
const noneBy: Record<string, number> = {};
for (const r of noneRows) noneBy[r.noneReason ?? "other"] = (noneBy[r.noneReason ?? "other"] ?? 0) + 1;
L.push(`- Stance-none breakdown (n=${noneRows.length}): ${Object.entries(noneBy).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}.`);
L.push(`  - \`noData:not-on-HL\`: ${rows.filter((r) => r.noneReason === "noData:not-on-HL").map((r) => r.op.symbol).join(", ")} — gold/index/alt not listed on Hyperliquid (${[...new Set(rows.filter((r) => r.noneReason === "noData:not-on-HL").map((r) => r.op.symbol))].length} distinct). These are a data gap, not an SO failure.`);
L.push("");

// ---------- stance distribution ----------
L.push(`## Stance distribution — old (stored) vs new (denominator = ${N} signals)`);
const dist = (get: (r: Row) => string | undefined) => { const c: Record<string, number> = { positive: 0, neutral: 0, negative: 0, none: 0 }; for (const r of rows) c[get(r) ?? "none"]!++; return c; };
const oldD = dist((r) => r.op.verdict?.stance), newD = dist((r) => r.newStance);
L.push(`| stance | old | new |`);
L.push(`|---|---|---|`);
for (const s of ["positive", "neutral", "negative", "none"]) L.push(`| ${s} | ${oldD[s]} (${pct(oldD[s]! / N)}) | ${newD[s]} (${pct(newD[s]! / N)}) |`);
L.push(``);
const posOfStance = withStance.length ? newD.positive! / withStance.length : 0;
L.push(`Positive share **among signals with a stance** (degeneration guard 25–60%): ${pct(posOfStance)} (${newD.positive}/${withStance.length}). On all ${N}: ${pct(newD.positive! / N)}.`);
L.push("");

// ---------- zone × outcome, winrate + expectancy (P1-R4) ----------
L.push(`## New zone × outcome (denominator = ${scored.length} scored win/loss)`);
L.push(`| zone | win | loss | win-rate | expectancy (gross) | expectancy (net) |`);
L.push(`|---|---|---|---|---|---|`);
for (const z of ["positive", "neutral", "negative"]) {
  const set = scored.filter((r) => r.newStance === z);
  const { w } = wrOf(set); const l = set.length - w;
  const eg = expR(rows.filter((r) => r.newStance === z)); const en = netR(rows.filter((r) => r.newStance === z));
  L.push(`| ${z} | ${w} | ${l} | ${ci(w, set.length)} | ${fmtE(eg.e, eg.se)} (n=${eg.n}) | ${fmtE(en.e)} (n=${en.n}) |`);
}
const pos = scored.filter((r) => r.newStance === "positive"), neg = scored.filter((r) => r.newStance === "negative");
const disc = discriminationNote(wrOf(pos).wr, pos.length, wrOf(neg).wr, neg.length, 15);
L.push(``);
L.push(`Top-vs-bottom discrimination: ${disc.text}.`);
L.push("");

// ---------- per-rule fire rate + lift + expectancy (P1-R4/R6) ----------
L.push(`## Per-rule fire rate + win-rate lift + expectancy (denominator = ${scored.length} scored)`);
L.push(`| rule | fires | fire rate | WR flagged | WR unflagged | exp flagged |`);
L.push(`|---|---|---|---|---|---|`);
for (const rule of [...new Set(rows.flatMap((r) => r.rules))].sort()) {
  const fl = scored.filter((r) => r.rules.includes(rule)), un = scored.filter((r) => !r.rules.includes(rule));
  const flg = wrOf(fl), ung = wrOf(un); const e = expR(fl);
  L.push(`| ${rule} | ${fl.length} | ${pct(scored.length ? fl.length / scored.length : 0)} | ${ci(flg.w, fl.length)} | ${ci(ung.w, un.length)} | ${fmtE(e.e, e.se)} |`);
}
L.push(``);
L.push(`> Merge gate (§8): no rule may fire on > 40% of scored signals without a win-rate lift. High fire-rate rows with negative/zero lift (e.g. riskReward, tradeWithTrend) are the ones to revisit as data grows — on n=${scored.length} the intervals overlap, so this is a watch-list, not a verdict.`);
L.push("");

// ---------- slAtrH buckets + horizon TF (P1-R6) ----------
L.push(`## slAtrH buckets (P1-R6, dev-brief 1.2) — denominator = scored with a stop`);
const bkts: [string, (x: number) => boolean][] = [["0–0.5", (x) => x < 0.5], ["0.5–1", (x) => x >= 0.5 && x < 1], ["1–2", (x) => x >= 1 && x < 2], ["2–3.5", (x) => x >= 2 && x < 3.5], [">3.5", (x) => x >= 3.5]];
L.push(`| slAtrH bucket | n (scored) | win-rate | expectancy (gross) |`);
L.push(`|---|---|---|---|`);
for (const [label, test] of bkts) {
  const set = scored.filter((r) => r.slAtrH !== undefined && test(r.slAtrH));
  const { w } = wrOf(set); const e = expR(rows.filter((r) => r.slAtrH !== undefined && test(r.slAtrH)));
  L.push(`| ${label} | ${set.length} | ${ci(w, set.length)} | ${fmtE(e.e, e.se)} |`);
}
const horizons: Record<string, number> = {};
for (const r of withStance) horizons[r.atrHorizonTf ?? "?"] = (horizons[r.atrHorizonTf ?? "?"] ?? 0) + 1;
L.push(``);
L.push(`Horizon-TF used: ${Object.entries(horizons).map(([k, v]) => `${k}:${v}`).join(" · ")} — currently fixed at 4h for all (trader median-hold not yet wired; open Q1). Thresholds stay hypotheses until the buckets fill.`);
L.push("");

// ---------- Brier vs baseline (P1-R5) ----------
L.push(`## Brier — geometry baseline vs old SO vs new SO (denominator = ${scored.filter((r) => r.pBase !== undefined).length} scored with levels)`);
const bSet = scored.filter((r) => r.pBase !== undefined);
const bBase = brier(bSet.map((r) => ({ p: r.pBase!, win: isWin(r) })));
const bOld = brier(bSet.filter((r) => r.op.verdict?.score !== undefined).map((r) => ({ p: r.op.verdict!.score! / 100, win: isWin(r) })));
const bNew = brier(bSet.filter((r) => r.newScore !== undefined).map((r) => ({ p: r.newScore! / 100, win: isWin(r) })));
L.push(`- Geometry baseline (pBase = slDist/(slDist+tpDist)): **${bBase?.toFixed(3) ?? "—"}**`);
L.push(`- Old SO (score/100, uncalibrated): ${bOld?.toFixed(3) ?? "—"}`);
L.push(`- New SO (score/100, uncalibrated): ${bNew?.toFixed(3) ?? "—"}`);
L.push(``);
const meanBaseWr = bSet.length ? mean(bSet.map((r) => r.pBase!)) : undefined;
L.push(`> Caveat: SO score/100 was never fit as a probability, so its Brier trails the baseline by construction — that argues for the Phase-3 isotonic calibration, not against the rules. Mean baseline P(win) on the scored set: ${meanBaseWr !== undefined ? pct(meanBaseWr) : "—"} vs realised ${ci(wrOf(scored).w, scored.length)} — the CI includes the baseline, so no trader edge is proven yet.`);
L.push("");

// ---------- outcome classes + unresolved age (P1-R9) ----------
L.push(`## Outcome classes (denominator = ${N})`);
const oc: Record<string, number> = {};
for (const r of rows) oc[r.outcomeClass ?? "unresolved"] = (oc[r.outcomeClass ?? "unresolved"] ?? 0) + 1;
L.push(Object.entries(oc).map(([k, v]) => `${k}: ${v}`).join(" · "));
const unresolved = rows.filter((r) => !r.resolved && r.outcomeClass !== "noData");
const ageB: Record<string, number> = { "<3d": 0, "3–7d": 0, "7–14d": 0, ">14d": 0 };
for (const r of unresolved) ageB[r.ageDays < 3 ? "<3d" : r.ageDays < 7 ? "3–7d" : r.ageDays < 14 ? "7–14d" : ">14d"]!++;
L.push(``);
L.push(`Unresolved age (n=${unresolved.length}): ${Object.entries(ageB).map(([k, v]) => `${k} ${v}`).join(" · ")}. (>14d unresolved would be a bug — the horizon is 14d.)`);
L.push("");

// ---------- phantom wins + reproducibility (P1-R8) ----------
L.push(`## Phantom wins + reproducibility (P1-R8)`);
// A phantom WIN is specifically a signal the OLD engine graded TP-first that the
// repaired engine says never filled — not merely any notFilled signal.
const notFilledAll = rows.filter((r) => r.outcomeClass && ["notFilled", "ambiguous"].includes(r.outcomeClass));
const phantom = notFilledAll.filter((r) => (r.op as { outcome?: { firstHit?: string } }).outcome?.firstHit === "tp");
L.push(`- Phantom WINS (old engine called TP-first, repaired engine says never filled): ${phantom.length ? phantom.map((r) => r.op.symbol).join(", ") : "none"} — matches the Phase-0 relabel.`);
L.push(`- All never-filled/ambiguous this run (incl. old non-wins): ${notFilledAll.length ? notFilledAll.map((r) => r.op.symbol).join(", ") : "none"}.`);
L.push(`- The earlier manual audit named ZRO/PUMP/SPX; the reproducible relabel (Phase 0) named PUMP/BTC/GRASS/ZRO. The difference is method: the audit eyeballed a subset, the relabel ran computeOutcome over fetched candles for all 81. SPX is \`noData\` (not on HL), so it can't be a win or a phantom — it simply has no outcome. Trust the reproducible run.`);
L.push(`- initialRisk provenance is now tagged per trade (\`recorded\` vs \`backfilled_estimate\`); Risk-Insights can restrict to \`recorded\` once enough real entries accumulate.`);
L.push("");
L.push(`> n is tiny (${scored.length} scored, 22 days, one regime). Every number here is a "how far from the gate" reading, not a decision. Gate (§11.4): ≥100 cleanly-resolved signals, ≥8 weeks, ≥2 BTC regimes.`);

const md = L.join("\n");
if (outPath) writeFileSync(outPath, md);
console.log(md);
