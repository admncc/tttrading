/**
 * Phase-0 relabel + before/after report (dev-brief P0.4).
 *
 * Replays every historical second-opinion through the REPAIRED outcome engine
 * (computeOutcome — SO-1/2/3/3b) and compares it to the numbers the OLD engine
 * produced, so we can see what correct measurement alone changes before any rule
 * work (Phase 1). Every rate is printed with n and a Wilson 95% interval;
 * accuracy is deliberately not used as a headline (base rate ~50%).
 *
 * Reproducible: takes its inputs as files, computes nothing from memory.
 *   tsx src/scripts/relabelReport.ts <secondOpinions.json> <candlesByOp.json> [out.md]
 *
 * secondOpinions.json : { secondOpinions: SecondOpinion[] }  (Diagnostic dump)
 * candlesByOp.json    : { [opId]: [ [t,o,h,l,c,v], ... ] }   (HL 15m, from signal)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { computeOutcome, type OutcomeCandle } from "../secondopinion/outcome.js";
import { wilson } from "@tttrading/shared";

type AnyOp = {
  id: string;
  symbol: string;
  side: "long" | "short";
  createdAt: string;
  entry?: number;
  stopLoss?: number;
  takeProfits?: number[];
  ta?: { slAtrMultiple?: number; rrClaimed?: number };
  verdict?: { stance?: string; score?: number; source?: string };
  outcome?: { firstHit?: string; resolved?: boolean; maxR?: number };
};

const [soPath, candlesPath, outPath] = process.argv.slice(2);
if (!soPath || !candlesPath) {
  console.error("usage: tsx relabelReport.ts <secondOpinions.json> <candlesByOp.json> [out.md]");
  process.exit(1);
}
const ops: AnyOp[] = JSON.parse(readFileSync(soPath, "utf8")).secondOpinions;
const candlesByOp: Record<string, number[][]> = JSON.parse(readFileSync(candlesPath, "utf8"));

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ci = (k: number, n: number) => {
  const w = wilson(k, n);
  return `${pct(w.p)} (n=${n}, 95% CI ${pct(w.lo)}–${pct(w.hi)})`;
};

// ---- run the repaired engine over fresh candles --------------------------
type Row = AnyOp & { newClass?: string; newRAtClose?: number; newFirst?: string; maxR?: number };
const rows: Row[] = ops.map((op) => {
  const raw = candlesByOp[op.id] ?? [];
  const candles: OutcomeCandle[] = raw.map((c) => ({ t: c[0]!, o: c[1]!, h: c[2]!, l: c[3]!, c: c[4]!, v: c[5]! }));
  const o = computeOutcome(
    { side: op.side, entry: op.entry, stopLoss: op.stopLoss, takeProfits: op.takeProfits, createdMs: Date.parse(op.createdAt) },
    candles,
    { timeoutHorizonMs: 14 * 86_400_000, fillWindowMs: 3 * 86_400_000 },
  );
  return { ...op, newClass: o?.outcomeClass, newRAtClose: o?.rAtClose, newFirst: o?.firstHit, maxR: o?.maxR };
});

// ---- OLD engine numbers (as stored) --------------------------------------
const oldResolved = rows.filter((r) => r.outcome?.resolved);
const oldTp = rows.filter((r) => r.outcome?.firstHit === "tp");
const oldSl = rows.filter((r) => r.outcome?.firstHit === "sl");
// Old "favorable/good" rule the code used to grade a call: TP first OR maxR ≥ 1.
const oldGood = rows.filter((r) => r.outcome?.firstHit === "tp" || (r.outcome?.maxR ?? 0) >= 1);

// ---- NEW engine numbers --------------------------------------------------
const byClass: Record<string, Row[]> = {};
for (const r of rows) {
  const k = r.newClass ?? "unresolved";
  (byClass[k] ??= []).push(r);
}
const win = byClass["win"]?.length ?? 0;
const loss = byClass["loss"]?.length ?? 0;
const timeout = byClass["timeout"]?.length ?? 0;
const notFilled = byClass["notFilled"]?.length ?? 0;
const ambiguous = byClass["ambiguous"]?.length ?? 0;
const unresolved = byClass["unresolved"]?.length ?? 0;

// Phantom wins: OLD engine graded TP-first (a "win") but the repaired engine
// says it never actually filled or is unorderable → not a real win.
const phantom = rows.filter((r) => r.outcome?.firstHit === "tp" && (r.newClass === "notFilled" || r.newClass === "ambiguous"));

// Flip: OLD "good/favorable" but NEW loss/timeout (or vice-versa).
const flippedToLoss = rows.filter((r) => (r.outcome?.firstHit === "tp" || (r.outcome?.maxR ?? 0) >= 1) && (r.newClass === "loss"));

// Confusion of OLD stance × NEW class (win/loss only — the scored outcomes).
const stances = ["positive", "negative", "neutral"] as const;
const scored = rows.filter((r) => r.newClass === "win" || r.newClass === "loss");

// recklessWide (SO-6, old rule: slAtrMultiple > 5) fire rate + lift on scored set.
const flagged = scored.filter((r) => (r.ta?.slAtrMultiple ?? 0) > 5);
const unflagged = scored.filter((r) => !((r.ta?.slAtrMultiple ?? 0) > 5));
const wr = (set: Row[]) => {
  const w = set.filter((r) => r.newClass === "win").length;
  const n = set.filter((r) => r.newClass === "win" || r.newClass === "loss").length;
  return { w, n };
};

// Expectancy in R under a simple TP1-or-SL standard-management proxy:
// win = +R-to-TP1 (rrClaimed), loss = −1R, timeout = rAtClose. Stated, not tuned.
function expectancyR(set: Row[]): { e?: number; n: number } {
  const vals: number[] = [];
  for (const r of set) {
    if (r.newClass === "win") vals.push(r.ta?.rrClaimed ?? 1);
    else if (r.newClass === "loss") vals.push(-1);
    else if (r.newClass === "timeout") vals.push(r.newRAtClose ?? 0);
  }
  if (!vals.length) return { n: 0 };
  return { e: vals.reduce((s, x) => s + x, 0) / vals.length, n: vals.length };
}

// ---- render --------------------------------------------------------------
const L: string[] = [];
L.push(`# Phase 0 — Relabel: before/after report`);
L.push("");
L.push(`Signals: **${rows.length}** · window ${ops[ops.length - 1]?.createdAt?.slice(0, 10)} → ${ops[0]?.createdAt?.slice(0, 10)} · replayed on fresh Hyperliquid 15m candles through the repaired engine (SO-1/2/3/3b).`);
L.push("");
L.push(`## Old engine (as stored)`);
L.push(`- Marked resolved: **${oldResolved.length}/${rows.length}** (${unresolved + timeout + notFilled + ambiguous} were left hanging by the too-short window / missing timeout class).`);
L.push(`- firstHit = TP: ${oldTp.length} · firstHit = SL: ${oldSl.length}`);
L.push(`- Old win-rate (TP / (TP+SL)): ${ci(oldTp.length, oldTp.length + oldSl.length)}`);
L.push(`- Old "favorable" grade (TP-first **or** maxR≥1, run over the whole window): ${oldGood.length}/${rows.length} → this is the metric SO-1 corrupts.`);
L.push("");
L.push(`## New engine (repaired)`);
L.push(`| class | n | note |`);
L.push(`|---|---|---|`);
L.push(`| win | ${win} | TP reached before SL |`);
L.push(`| loss | ${loss} | SL reached before TP |`);
L.push(`| timeout | ${timeout} | no TP/SL in 14 d — carries R at close (SO-2) |`);
L.push(`| notFilled | ${notFilled} | limit never traded through entry — no outcome (SO-3) |`);
L.push(`| ambiguous | ${ambiguous} | fill/SL or TP/SL in one bar (SO-3b) |`);
L.push(`| unresolved | ${unresolved} | still open, < 14 d old |`);
L.push("");
L.push(`- **New win-rate (win / (win+loss)):** ${ci(win, win + loss)}`);
L.push(`- Resolved into a scored outcome: ${win + loss}/${rows.length}; incl. timeout: ${win + loss + timeout}/${rows.length}.`);
L.push("");
L.push(`## What correct measurement changed`);
L.push(`- **Phantom wins removed:** ${phantom.length} signal(s) the old engine graded as TP-first are now \`notFilled\`/\`ambiguous\` (no real fill).${phantom.length ? " → " + phantom.map((r) => `${r.symbol}`).join(", ") : ""}`);
L.push(`- **Post-stop-rally losers reclassified (SO-1):** ${flippedToLoss.length} signal(s) that scored "favorable" under the old whole-window MFE are losses once the excursion is cut at the SL bar.`);
L.push("");
L.push(`## Old SO stance × new outcome (scored only, n=${scored.length})`);
L.push(`| stance | win | loss | win-rate |`);
L.push(`|---|---|---|---|`);
for (const s of stances) {
  const set = scored.filter((r) => r.verdict?.stance === s);
  const w = set.filter((r) => r.newClass === "win").length;
  const l = set.filter((r) => r.newClass === "loss").length;
  L.push(`| ${s} | ${w} | ${l} | ${w + l ? ci(w, w + l) : "—"} |`);
}
L.push("");
L.push(`## recklessWide (SO-6, old rule slAtrMultiple>5) — fire rate & lift`);
const fA = wr(flagged), fU = wr(unflagged);
L.push(`- Fires on **${flagged.length}/${scored.length}** scored signals (${pct(scored.length ? flagged.length / scored.length : 0)}).`);
L.push(`- Win-rate when flagged: ${fA.n ? ci(fA.w, fA.n) : "—"}`);
L.push(`- Win-rate when NOT flagged: ${fU.n ? ci(fU.w, fU.n) : "—"}`);
L.push(`- A flag that fires on the majority with no win-rate separation is noise — this is exactly the horizon-ATR mismatch Phase 1 (SO-6) fixes.`);
L.push("");
L.push(`## Expectancy in R (TP1-or-SL proxy, stated not tuned)`);
for (const s of stances) {
  const e = expectancyR(scored.concat(byClass["timeout"] ?? []).filter((r) => r.verdict?.stance === s));
  L.push(`- ${s}: ${e.e === undefined ? "—" : `${e.e >= 0 ? "+" : ""}${e.e.toFixed(2)}R`} (n=${e.n})`);
}
const eAll = expectancyR(rows);
L.push(`- all: ${eAll.e === undefined ? "—" : `${eAll.e >= 0 ? "+" : ""}${eAll.e.toFixed(2)}R`} (n=${eAll.n})`);
L.push("");
L.push(`> Caveat: n is tiny; every rate above carries a wide Wilson interval. These numbers exist to show what the measurement fix alone moves — not to judge the SO's edge yet. That is Phase 1, on out-of-sample data.`);

const md = L.join("\n");
if (outPath) writeFileSync(outPath, md);
console.log(md);
