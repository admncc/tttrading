/**
 * Phase 2 — OFFLINE backfill feature report over the historical signals, so we
 * have real bucket statistics now (before live logging accrues). Recomputes
 * point-in-time features from pre-signal candles + a point-in-time BTC daily
 * slice, labels outcomes with the repaired engine, and renders bucket stats.
 *
 *   tsx src/scripts/backfillFeatureReport.ts <secondOpinions.json> <bundle.json> <btcD1.json> [out.md]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { computeFrame } from "../secondopinion/index.js";
import { computeOutcome } from "../secondopinion/outcome.js";
import {
  timeFeatures, geometryFeatures, taFeatures, btcRegimeFeatures, betaFeatures,
  derivativeFeatures, assetFeatures, coinBaseRateFeatures, eventFeatures, type Feat,
} from "../features/compute.js";
import { capTier } from "../risk/score.js";
import { bucketFeature, renderFeatureReport, type SignalDatum } from "../features/buckets.js";

type AnyOp = { id: string; symbol: string; side: "long" | "short"; createdAt: string; entry?: number; stopLoss?: number; takeProfits?: number[]; ta?: { rrClaimed?: number }; verdict?: { stance?: string } };
type Bundle = Record<string, { status: string; pre: Record<string, number[][]>; post: number[][] }>;
type C = { t: number; o: number; h: number; l: number; c: number; v: number };

const [soPath, bundlePath, btcPath, outPath] = process.argv.slice(2);
if (!soPath || !bundlePath || !btcPath) { console.error("usage: backfillFeatureReport <so.json> <bundle.json> <btcD1.json> [out.md]"); process.exit(1); }
const ops: AnyOp[] = JSON.parse(readFileSync(soPath, "utf8")).secondOpinions;
const bundle: Bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
const btcAll: number[][] = JSON.parse(readFileSync(btcPath, "utf8"));
const toC = (raw: number[][]): C[] => raw.map((c) => ({ t: c[0]!, o: c[1]!, h: c[2]!, l: c[3]!, c: c[4]!, v: c[5]! }));
const FRAMES = ["15m", "1h", "4h", "1d"];

// Process chronologically so the coin base rate uses only PRIOR outcomes.
const chrono = [...ops].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
const coinHist = new Map<string, { resolved: number; tpFirst: number }>();

const signals: SignalDatum[] = [];
for (const op of chrono) {
  const b = bundle[op.id];
  if (!b || b.status !== "ok") continue;
  const signalMs = Date.parse(op.createdAt);
  const frames = FRAMES.map((tf) => computeFrame(tf, toC(b.pre[tf] ?? []))).filter((f): f is NonNullable<typeof f> => !!f);
  const c1h = toC(b.pre["1h"] ?? []);
  const price = c1h.length ? c1h[c1h.length - 1]!.c : (op.entry ?? 0);
  // horizon ATR at 4h (fixed, matching current buildTA default)
  const c4h = toC(b.pre["4h"] ?? []);
  let atrH: number | undefined;
  if (c4h.length >= 15) {
    const trs: number[] = [];
    for (let i = 1; i < c4h.length; i++) { const x = c4h[i]!, p = c4h[i - 1]!; trs.push(Math.max(x.h - x.l, Math.abs(x.h - p.c), Math.abs(x.l - p.c))); }
    atrH = trs.slice(-14).reduce((s, v) => s + v, 0) / Math.min(14, trs.length);
  }
  const feats: Feat[] = [];
  feats.push(...timeFeatures(signalMs));
  feats.push(...eventFeatures(signalMs, 48 * 3_600_000)); // 48h default window (no trader stats offline)
  feats.push(...assetFeatures(op.symbol, capTier(op.symbol)));
  const cb = coinHist.get(op.symbol.toUpperCase()) ?? { resolved: 0, tpFirst: 0 };
  feats.push(...coinBaseRateFeatures(cb));
  feats.push(...geometryFeatures(op.side, op.entry, op.stopLoss, op.takeProfits?.[0], price, atrH));
  feats.push(...taFeatures(op.side, frames.map((f) => ({ interval: f.interval, trend: f.trend })), c1h));
  // Point-in-time BTC daily slice (candles that closed at/before the signal).
  const btcSlice = toC(btcAll.filter((c) => c[0]! <= signalMs));
  feats.push(...btcRegimeFeatures(btcSlice));
  const coinD1 = toC(b.pre["1d"] ?? []);
  if (coinD1.length) feats.push(...betaFeatures(coinD1, btcSlice));
  feats.push(...derivativeFeatures(op.side, {})); // funding/OI not in the historical snapshot

  const outcome = computeOutcome(
    { side: op.side, entry: op.entry, stopLoss: op.stopLoss, takeProfits: op.takeProfits, createdMs: signalMs },
    toC(b.post),
    { timeoutHorizonMs: 14 * 86_400_000, fillWindowMs: 3 * 86_400_000 },
  );
  const cls = outcome?.outcomeClass;
  const win = cls === "win" ? true : cls === "loss" ? false : undefined;
  const rR = cls === "win" ? (op.ta?.rrClaimed ?? 1) : cls === "loss" ? -1 : cls === "timeout" ? outcome!.rAtClose ?? 0 : undefined;
  const map: Record<string, number | string | undefined> = {};
  for (const f of feats) map[f.name] = f.num ?? f.text;
  signals.push({ win, rR, feats: map });

  // Update the coin's running base rate AFTER this signal (so it stays prior-only).
  if (win !== undefined) {
    const h = coinHist.get(op.symbol.toUpperCase()) ?? { resolved: 0, tpFirst: 0 };
    h.resolved += 1;
    if (win) h.tpFirst += 1;
    coinHist.set(op.symbol.toUpperCase(), h);
  }
}

const scored = signals.filter((s) => s.win !== undefined).length;
const names = [...new Set(signals.flatMap((s) => Object.keys(s.feats)))].sort();
const L: string[] = [];
L.push(`# Phase 2 — feature bucket report (offline backfill over history)`);
L.push("");
L.push(`Signals with recomputed features: **${signals.length}** (HL-listed) · scored win/loss: **${scored}**. Point-in-time: features use only pre-signal candles + a BTC daily slice ending at the signal.`);
L.push(``);
L.push(`> Descriptive only — no model, no thresholds set (§11.3/§11.4). 22-day, one-regime sample: every bucket is far below the n=15 finding bar and the ≥100-signal / ≥2-regime gate. Funding/OI/liquidations are absent here (not in the historical snapshot); they will be logged live going forward.`);
L.push("");
for (const name of names) L.push(...renderFeatureReport(bucketFeature(signals, name)), "");

const md = L.join("\n");
if (outPath) writeFileSync(outPath, md);
console.log(md);
