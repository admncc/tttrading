/**
 * Phase 2 — feature bucket report from the LIVE DB (dev-brief §7 / v2.2 §11.5).
 * Joins logged point-in-time features with resolved Second-Opinion outcomes and
 * prints win-rate + expectancy per bucket, with n + Wilson CI. Describes the
 * data only — no model. Used standalone and by the weekly cron.
 *
 *   tsx src/scripts/featureBuckets.ts [days] [out.md]
 */
import { writeFileSync } from "node:fs";
import { secondOpinions as soRepo, signalFeatures as featRepo } from "../db/repositories.js";
import { bucketFeature, renderFeatureReport, type SignalDatum } from "../features/buckets.js";

const days = process.argv[2] ? Number(process.argv[2]) : 90;
const outPath = process.argv[3];
const since = new Date(Date.now() - days * 86_400_000).toISOString();

// Outcome per signalId from resolved second-opinions.
const outcomeBySignal = new Map<string, { win: boolean | undefined; rR?: number }>();
for (const op of soRepo.list(5000)) {
  if (!op.signalId || !op.outcome) continue;
  const cls = op.outcome.outcomeClass;
  if (cls === "win" || cls === "loss") {
    const rR = cls === "win" ? (op.ta?.rrClaimed ?? 1) : -1;
    outcomeBySignal.set(op.signalId, { win: cls === "win", rR });
  } else if (cls === "timeout") {
    outcomeBySignal.set(op.signalId, { win: undefined, rR: op.outcome.rAtClose ?? 0 });
  }
}

// Features per signalId.
const featsBySignal = new Map<string, Record<string, number | string | undefined>>();
for (const f of featRepo.since(since)) {
  const m = featsBySignal.get(f.signalId) ?? {};
  m[f.name] = f.num ?? f.text;
  featsBySignal.set(f.signalId, m);
}

const signals: SignalDatum[] = [];
for (const [sigId, feats] of featsBySignal) {
  const o = outcomeBySignal.get(sigId);
  signals.push({ win: o?.win, rR: o?.rR, feats });
}

const allNames = [...new Set(signals.flatMap((s) => Object.keys(s.feats)))].sort();
const scored = signals.filter((s) => s.win !== undefined).length;

const L: string[] = [];
L.push(`# Phase 2 — feature bucket report (live DB)`);
L.push("");
L.push(`Window: last ${days} d · signals with features: **${signals.length}** · of which scored (win/loss): **${scored}**.`);
L.push("");
if (signals.length === 0) {
  L.push(`_No logged features yet — the logger starts populating on the next signals. Re-run once data has accrued._`);
} else {
  for (const name of allNames) {
    const rep = bucketFeature(signals, name);
    L.push(...renderFeatureReport(rep));
    L.push("");
  }
  L.push(`> Buckets marked ·small are below n=15 and are not findings (leitplanke 5). No thresholds are set from this yet — observation only (§11.3/§11.4).`);
}

const md = L.join("\n");
if (outPath) writeFileSync(outPath, md);
console.log(md);
