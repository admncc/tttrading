/**
 * Phase 2 §11.5 — weekly prediction report (server-side cron). Runs weekly,
 * computes gate-progress metrics from the LIVE DB, writes a dated markdown file
 * next to the DB, and logs a one-line header so "how far from the gate" is
 * always visible without anyone asking. Observe-only.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { log, event } from "../logger.js";
import { secondOpinions as soRepo, signalFeatures as featRepo } from "../db/repositories.js";
import { wilson, brier, brierClimatology, brierSkillScore, geoBaselineP } from "../lib/metrics.js";
import { bucketFeature, renderFeatureReport, type SignalDatum } from "../features/buckets.js";

const WEEK = 7 * 86_400_000;
const GATE_SIGNALS = 100; // §11.4

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

export function computeWeeklyReport(): { md: string; header: string } {
  const sos = soRepo.list(5000);
  const withVerdict = sos.filter((o) => o.verdict);
  const resolved = sos.filter((o) => o.outcome && ["win", "loss", "timeout"].includes(o.outcome.outcomeClass ?? ""));
  const scored = sos.filter((o) => o.outcome && ["win", "loss"].includes(o.outcome.outcomeClass ?? ""));
  const wins = scored.filter((o) => o.outcome!.outcomeClass === "win").length;
  const wr = wilson(wins, scored.length);

  const weeks = new Set(resolved.map((o) => isoWeek(new Date(o.createdAt))));
  const soCoverage = sos.length ? withVerdict.length / sos.length : 0;
  const last30 = withVerdict.slice(0, 30);
  const posShare = last30.length ? last30.filter((o) => o.verdict!.stance === "positive").length / last30.length : 0;

  // BTC regime coverage from logged features.
  const feats = featRepo.since(new Date(Date.now() - 365 * 86_400_000).toISOString());
  const btcRegimes = new Set(feats.filter((f) => f.name === "btcTrendD1" && f.text).map((f) => f.text!));

  // Brier: geometry baseline vs current SO (score/100), on scored signals with levels.
  const bRows = scored
    .filter((o) => o.entry !== undefined && o.stopLoss !== undefined && o.takeProfits?.[0] !== undefined)
    .map((o) => ({ base: geoBaselineP(o.entry!, o.stopLoss!, o.takeProfits![0]!), so: (o.verdict?.score ?? 50) / 100, win: o.outcome!.outcomeClass === "win" }))
    .filter((r) => r.base !== undefined);
  const bBase = brier(bRows.map((r) => ({ p: r.base!, win: r.win })));
  const bSo = brier(bRows.map((r) => ({ p: r.so, win: r.win })));
  const clim = brierClimatology(bRows.filter((r) => r.win).length, bRows.length);
  const soSkill = brierSkillScore(bSo, clim?.brier); // >0 = beats climatology

  const header =
    `Weekly: scored ${scored.length}/${GATE_SIGNALS} · resolved ${resolved.length} · weeks ${weeks.size} · BTC regimes ${btcRegimes.size} (${[...btcRegimes].join("/") || "—"}) · ` +
    `SO coverage ${(soCoverage * 100).toFixed(0)}% · positive(last30) ${(posShare * 100).toFixed(0)}% · ` +
    `Brier base ${bBase?.toFixed(3) ?? "—"} vs SO ${bSo?.toFixed(3) ?? "—"} · win-rate ${scored.length ? (wr.p * 100).toFixed(1) + "%" : "—"}`;

  const L: string[] = [];
  L.push(`# Weekly prediction report — ${new Date().toISOString().slice(0, 10)}`);
  L.push("");
  L.push(`${header}`);
  L.push("");
  L.push(`## Gate progress (§11.4: ≥${GATE_SIGNALS} scored, ≥8 weeks, ≥2 BTC regimes)`);
  L.push(`- Scored (win/loss): **${scored.length}/${GATE_SIGNALS}** · win-rate ${scored.length ? `${(wr.p * 100).toFixed(1)}% (CI ${(wr.lo * 100).toFixed(0)}–${(wr.hi * 100).toFixed(0)})` : "—"}`);
  L.push(`- Weeks covered: **${weeks.size}/8** · BTC regimes: **${btcRegimes.size}/2** (${[...btcRegimes].join(", ") || "none logged yet"})`);
  L.push(`- Resolved incl. timeout: ${resolved.length} · SO coverage ${(soCoverage * 100).toFixed(0)}% · positive share (last 30): ${(posShare * 100).toFixed(0)}%${posShare < 0.15 || posShare > 0.85 ? " ⚠ degeneration" : ""}`);
  L.push(`- Brier: climatology ${clim?.brier.toFixed(3) ?? "—"} · geometry ${bBase?.toFixed(3) ?? "—"} · SO ${bSo?.toFixed(3) ?? "—"} · SO skill vs clim ${soSkill === undefined ? "—" : (soSkill >= 0 ? "+" : "") + soSkill.toFixed(3)} (SO uncalibrated until Phase 3).`);
  L.push("");

  // A couple of headline feature buckets (session, btcTrendD1) if we have data.
  const outcomeBy = new Map<string, { win: boolean | undefined; rR?: number }>();
  for (const o of sos) {
    if (!o.signalId || !o.outcome) continue;
    const c = o.outcome.outcomeClass;
    if (c === "win" || c === "loss") outcomeBy.set(o.signalId, { win: c === "win", rR: c === "win" ? (o.ta?.rrClaimed ?? 1) : -1 });
    else if (c === "timeout") outcomeBy.set(o.signalId, { win: undefined, rR: o.outcome.rAtClose ?? 0 });
  }
  const bySig = new Map<string, Record<string, number | string | undefined>>();
  for (const f of feats) { const m = bySig.get(f.signalId) ?? {}; m[f.name] = f.num ?? f.text; bySig.set(f.signalId, m); }
  const dataset: SignalDatum[] = [...bySig.entries()].map(([id, fmap]) => ({ ...outcomeBy.get(id), feats: fmap } as SignalDatum));
  if (dataset.length) {
    L.push(`## Headline feature buckets (n=${dataset.length} with features)`);
    for (const name of ["session", "btcTrendD1", "mtfAlignment", "slAtrH"]) {
      if (dataset.some((d) => d.feats[name] !== undefined)) L.push(...renderFeatureReport(bucketFeature(dataset, name)), "");
    }
  } else {
    L.push(`_No logged features yet — buckets will populate as signals flow._`);
  }
  return { md: L.join("\n"), header };
}

function runOnce(): void {
  try {
    const { md, header } = computeWeeklyReport();
    const dir = path.join(path.dirname(config.dbPath), "reports");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `weekly-${new Date().toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(file, md);
    event("review", `📊 ${header}`, { file }, { level: "info" });
    log.info(`Weekly prediction report written to ${file}`);
  } catch (err) {
    log.warn("weekly report failed:", err instanceof Error ? err.message : err);
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startWeeklyReport(): void {
  if (timer) return;
  // First run shortly after boot, then weekly.
  setTimeout(runOnce, 60_000);
  timer = setInterval(runOnce, WEEK);
  log.info("Weekly prediction report scheduled (every 7 days).");
}
export function stopWeeklyReport(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
