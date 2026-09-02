/**
 * Phase-1 Second-Opinion backtest harness (dev-brief 1.5).
 *
 * Replays every historical signal through the CURRENT rule set: recomputes the TA
 * point-in-time from candles that predate the signal, scores it with
 * heuristicVerdict (the new 3-zone rules), and labels the outcome with the
 * repaired engine (computeOutcome). Reports, all with n:
 *   - old (stored) vs new stance distribution
 *   - 3-zone × outcome confusion (win/loss/timeout)
 *   - per-rule fire rate + win-rate lift (flagged vs unflagged)
 *   - score histogram
 *
 * Reproducible:
 *   tsx src/scripts/backtestRules.ts <secondOpinions.json> <taCandles.json> <candlesByOp.json> [out.md]
 *
 * taCandles.json   : { [opId]: { "15m":[[t,o,h,l,c,v]...], "1h":[...], "4h":[...], "1d":[...] } }  (pre-signal history)
 * candlesByOp.json : { [opId]: [[t,o,h,l,c,v]...] }  (15m from the signal onward, for the outcome)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { computeFrame, buildTA, heuristicVerdict } from "../secondopinion/index.js";
import { computeOutcome } from "../secondopinion/outcome.js";
import { wilson } from "@tttrading/shared";
import type { ParsedSignal, SecondOpinionTFrame } from "@tttrading/shared";

type AnyOp = {
  id: string; symbol: string; side: "long" | "short"; createdAt: string;
  entry?: number; stopLoss?: number; takeProfits?: number[];
  verdict?: { stance?: string; score?: number };
};

const [soPath, taPath, outcomePath, outPath] = process.argv.slice(2);
if (!soPath || !taPath || !outcomePath) {
  console.error("usage: tsx backtestRules.ts <secondOpinions.json> <taCandles.json> <candlesByOp.json> [out.md]");
  process.exit(1);
}
const ops: AnyOp[] = JSON.parse(readFileSync(soPath, "utf8")).secondOpinions;
const taCandles: Record<string, Record<string, number[][]>> = JSON.parse(readFileSync(taPath, "utf8"));
const outcomeCandles: Record<string, number[][]> = JSON.parse(readFileSync(outcomePath, "utf8"));

const toC = (raw: number[][]) => raw.map((c) => ({ t: c[0]!, o: c[1]!, h: c[2]!, l: c[3]!, c: c[4]!, v: c[5]! }));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ci = (k: number, n: number) => (n ? `${pct(k / n)} (n=${n}, CI ${pct(wilson(k, n).lo)}–${pct(wilson(k, n).hi)})` : "—");

const FRAMES = ["15m", "1h", "4h", "1d"];
type Row = {
  op: AnyOp; newStance?: string; newScore?: number; outcomeClass?: string;
  rules: string[];
};

const rows: Row[] = ops.map((op) => {
  const bundle = taCandles[op.id] ?? {};
  const frames = FRAMES.map((tf) => computeFrame(tf, toC(bundle[tf] ?? []))).filter((f): f is SecondOpinionTFrame => !!f);
  const parsed = { symbol: op.symbol, side: op.side, entry: op.entry, stopLoss: op.stopLoss, takeProfits: op.takeProfits, action: "open" } as unknown as ParsedSignal;
  const ta = buildTA(parsed, toC(bundle["1h"] ?? []), frames, {});
  const verdict = ta ? heuristicVerdict(parsed, ta) : undefined;
  const outcome = computeOutcome(
    { side: op.side, entry: op.entry, stopLoss: op.stopLoss, takeProfits: op.takeProfits, createdMs: Date.parse(op.createdAt) },
    toC(outcomeCandles[op.id] ?? []),
    { timeoutHorizonMs: 14 * 86_400_000, fillWindowMs: 3 * 86_400_000 },
  );
  return {
    op, newStance: verdict?.stance, newScore: verdict?.score, outcomeClass: outcome?.outcomeClass,
    rules: (verdict?.contributions ?? []).map((c) => c.rule),
  };
});

const scored = rows.filter((r) => r.outcomeClass === "win" || r.outcomeClass === "loss");
const withTA = rows.filter((r) => r.newStance);

const L: string[] = [];
L.push(`# Phase 1 — Second-Opinion rule backtest (old vs new)`);
L.push("");
L.push(`Signals: **${rows.length}** · TA recomputed point-in-time · outcomes via the repaired engine · scored (win/loss): ${scored.length}, timeout: ${rows.filter((r) => r.outcomeClass === "timeout").length}.`);
L.push("");

L.push(`## Stance distribution — old (stored) vs new (3-zone rules)`);
const dist = (get: (r: Row) => string | undefined, set: Row[]) => {
  const c: Record<string, number> = { positive: 0, neutral: 0, negative: 0, none: 0 };
  for (const r of set) c[get(r) ?? "none"]!++;
  return c;
};
const oldD = dist((r) => r.op.verdict?.stance, rows);
const newD = dist((r) => r.newStance, rows);
L.push(`| stance | old | new |`);
L.push(`|---|---|---|`);
for (const s of ["positive", "neutral", "negative", "none"]) {
  L.push(`| ${s} | ${oldD[s]} (${pct(oldD[s]! / rows.length)}) | ${newD[s]} (${pct(newD[s]! / rows.length)}) |`);
}
L.push(``);
L.push(`Positive share (degeneration guard: healthy 25–60%): old ${pct(oldD.positive! / rows.length)} → new ${pct(newD.positive! / rows.length)}.`);
L.push("");

L.push(`## New stance × outcome (scored only, n=${scored.length})`);
L.push(`| zone | win | loss | win-rate |`);
L.push(`|---|---|---|---|`);
for (const z of ["positive", "neutral", "negative"]) {
  const set = scored.filter((r) => r.newStance === z);
  const w = set.filter((r) => r.outcomeClass === "win").length;
  const l = set.filter((r) => r.outcomeClass === "loss").length;
  L.push(`| ${z} | ${w} | ${l} | ${ci(w, w + l)} |`);
}
const posSc = scored.filter((r) => r.newStance === "positive");
const negSc = scored.filter((r) => r.newStance === "negative");
const posWr = posSc.length ? posSc.filter((r) => r.outcomeClass === "win").length / posSc.length : undefined;
const negWr = negSc.length ? negSc.filter((r) => r.outcomeClass === "win").length / negSc.length : undefined;
L.push(``);
L.push(`Top-vs-bottom-zone win-rate: ${posWr !== undefined ? pct(posWr) : "—"} vs ${negWr !== undefined ? pct(negWr) : "—"} (positive discrimination = the new rules point the right way; tiny n, treat as directional only).`);
L.push("");

L.push(`## Per-rule fire rate + win-rate lift (scored set, n=${scored.length})`);
L.push(`| rule | fires | fire rate | WR flagged | WR unflagged |`);
L.push(`|---|---|---|---|---|`);
const allRules = [...new Set(rows.flatMap((r) => r.rules))].sort();
for (const rule of allRules) {
  const fl = scored.filter((r) => r.rules.includes(rule));
  const un = scored.filter((r) => !r.rules.includes(rule));
  const flW = fl.filter((r) => r.outcomeClass === "win").length;
  const unW = un.filter((r) => r.outcomeClass === "win").length;
  const rate = withTA.filter((r) => r.rules.includes(rule)).length / (withTA.length || 1);
  L.push(`| ${rule} | ${fl.length} | ${pct(rate)} | ${ci(flW, fl.length)} | ${ci(unW, un.length)} |`);
}
L.push(``);
L.push(`> Merge gate (dev-brief §8): no rule may fire on > 40% of signals without a win-rate lift. Rows above with a high fire rate and no separation are the ones to revisit as data grows.`);
L.push("");

L.push(`## Score histogram (new rules)`);
const buckets = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
for (let i = 0; i < buckets.length - 1; i++) {
  const lo = buckets[i]!, hi = buckets[i + 1]!;
  const n = withTA.filter((r) => (r.newScore ?? -1) >= lo && (r.newScore ?? -1) < (hi === 100 ? 101 : hi)).length;
  L.push(`- ${lo}–${hi}: ${"█".repeat(n)} ${n}`);
}
L.push("");
L.push(`> n is tiny (${scored.length} scored). This harness exists so the rule set can never again drift to a rubber-stamp unnoticed; the win-rate/lift numbers become decisive only after ~100 cleanly-resolved signals (dev-brief §8).`);

const md = L.join("\n");
if (outPath) writeFileSync(outPath, md);
console.log(md);
