/**
 * Phase 2 — feature logger. Assembles the inputs the pure feature functions need
 * (candles already fetched by the Second Opinion, BTC candles, trader stats from
 * the DB) and persists one point-in-time row per feature. Observe-only: it never
 * throws into the signal path and never influences execution.
 */
import type { Group, ParsedSignal, SignalFeature } from "@tttrading/shared";
import { rMultiple } from "../lib/metrics.js";
import { trades as tradesRepo, signalFeatures as featRepo, secondOpinions as soRepo } from "../db/repositories.js";
import { activeHyperliquid } from "../exchanges/registry.js";
import { capTier } from "../risk/score.js";
import { log } from "../logger.js";
import {
  FEATURE_VERSION, type Feat, timeFeatures, geometryFeatures, taFeatures,
  btcRegimeFeatures, betaFeatures, derivativeFeatures, traderStatsFeatures, horizonForHold,
  assetFeatures, coinBaseRateFeatures, ethBtcFeatures, type TraderStats,
} from "./compute.js";

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
const DAY = 86_400_000;

/** Rolling trader (channel) stats from the group's own closed trades, using only
 *  trades that settled before `beforeMs` (point-in-time; in live == now). */
function traderStats(groupId: string, side: "long" | "short", symbol: string, beforeMs: number): TraderStats {
  const all = tradesRepo.forGroup(groupId).filter((t) => !t.shadow);
  const closed = all.filter((t) => t.status === "closed" && Number.isFinite(t.realizedPnl) && t.closedAt && new Date(t.closedAt).getTime() <= beforeMs);
  const wins = closed.filter((t) => (t.realizedPnl ?? 0) > 0).length;
  const rs = closed
    .map((t) => rMultiple(t.realizedPnl ?? 0, t.initialRisk ?? (t.stopLoss !== undefined ? Math.abs(t.entryPrice - t.stopLoss) * (t.initialSize ?? t.size) : undefined)))
    .filter((r): r is number => r !== undefined);
  const holds = closed
    .map((t) => (t.openedAt && t.closedAt ? (new Date(t.closedAt).getTime() - new Date(t.openedAt).getTime()) / 3_600_000 : undefined))
    .filter((h): h is number => h !== undefined && h >= 0)
    .sort((a, b) => a - b);
  const median = holds.length ? holds[Math.floor(holds.length / 2)] : undefined;
  // signals/week from the opened_at span of all this group's trades
  const opens = all.map((t) => (t.openedAt ? new Date(t.openedAt).getTime() : NaN)).filter((x) => Number.isFinite(x));
  const spanWeeks = opens.length >= 2 ? (Math.max(...opens) - Math.min(...opens)) / (7 * DAY) : undefined;
  const signalsPerWeek = spanWeeks && spanWeeks > 0 ? all.length / spanWeeks : undefined;
  // concurrent same-coin+direction exposure right now (crowding / consensus proxy)
  const concurrentSameDir = [...tradesRepo.open(), ...tradesRepo.working()]
    .filter((t) => !t.shadow && t.symbol.toUpperCase() === symbol.toUpperCase() && t.side === side).length;
  return {
    resolved: closed.length,
    wins,
    expectancyR: rs.length ? rs.reduce((s, x) => s + x, 0) / rs.length : undefined,
    medianHoldHours: median,
    signalsPerWeek,
    concurrentSameDir,
  };
}

export interface FeatureInputs {
  byTf: Record<string, Candle[]>; // candles the SO already fetched (15m/1h/4h/1d)
  ctx: { funding?: number; openInterest?: number; premiumBps?: number };
  frames: { interval: string; trend: "up" | "down" | "sideways" }[];
  price: number;
  atrHorizon?: number;
}

/** Compute + persist all Phase-2 features for a signal. Never throws. */
export async function logSignalFeatures(
  group: Group,
  parsed: ParsedSignal,
  signalId: string,
  inputs: FeatureInputs,
): Promise<void> {
  try {
    const signalAt = new Date().toISOString();
    const signalMs = Date.now();
    const feats: Feat[] = [];

    feats.push(...timeFeatures(signalMs));
    feats.push(...derivativeFeatures(parsed.side, inputs.ctx));
    feats.push(...assetFeatures(parsed.symbol, capTier(parsed.symbol)));

    // Coin base rate from resolved second-opinions on this coin before now.
    const coinResolved = soRepo
      .list(5000)
      .filter((o) => o.symbol.toUpperCase() === parsed.symbol.toUpperCase() && o.outcome && new Date(o.createdAt).getTime() < signalMs && ["win", "loss"].includes(o.outcome.outcomeClass ?? ""));
    feats.push(...coinBaseRateFeatures({ resolved: coinResolved.length, tpFirst: coinResolved.filter((o) => o.outcome!.outcomeClass === "win").length }));

    // Trader horizon → pick the ATR horizon for geometry; then geometry features.
    const stats = traderStats(group.id, parsed.side, parsed.symbol, signalMs);
    const horizonTf = horizonForHold(stats.medianHoldHours);
    const horizonFrame = inputs.byTf[horizonTf] ?? [];
    // ATR of the horizon TF (simple 14-period true range) for slAtrH/tpAtrH.
    let atrH = inputs.atrHorizon;
    if (atrH === undefined && horizonFrame.length >= 15) {
      const trs: number[] = [];
      for (let i = 1; i < horizonFrame.length; i++) {
        const c = horizonFrame[i]!, p = horizonFrame[i - 1]!;
        trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
      }
      atrH = trs.slice(-14).reduce((s, x) => s + x, 0) / Math.min(14, trs.length);
    }
    feats.push({ name: "horizonTf", text: horizonTf });
    feats.push(...geometryFeatures(parsed.side, parsed.entry, parsed.stopLoss, parsed.takeProfits?.[0], inputs.price, atrH));
    feats.push(...taFeatures(parsed.side, inputs.frames, inputs.byTf["1h"] ?? []));
    feats.push(...traderStatsFeatures(stats));

    // BTC regime + beta need BTC daily candles (point-in-time, up to now).
    try {
      const hl = activeHyperliquid();
      const [btcD1, ethD1] = await Promise.all([
        hl.getCandles("BTC", "1d", signalMs - 400 * DAY, signalMs) as Promise<Candle[]>,
        hl.getCandles("ETH", "1d", signalMs - 400 * DAY, signalMs).catch(() => [] as Candle[]) as Promise<Candle[]>,
      ]);
      feats.push(...btcRegimeFeatures(btcD1));
      const coinD1 = inputs.byTf["1d"] ?? [];
      if (coinD1.length) feats.push(...betaFeatures(coinD1, btcD1));
      if (ethD1.length && btcD1.length) feats.push(...ethBtcFeatures(ethD1, btcD1));
    } catch (err) {
      log.warn("features: BTC regime unavailable:", err instanceof Error ? err.message : err);
    }

    const rows: SignalFeature[] = feats.map((f) => ({
      signalId,
      name: f.name,
      num: f.num,
      text: f.text,
      source: sourceOf(f.name),
      version: FEATURE_VERSION,
      computedAt: signalAt,
      signalAt,
    }));
    featRepo.putMany(rows);
    log.info(`Features logged for signal ${signalId}: ${rows.length} (${group.name} ${parsed.side} ${parsed.symbol}).`);
  } catch (err) {
    log.warn("feature logging failed:", err instanceof Error ? err.message : err);
  }
}

function sourceOf(name: string): string {
  if (["sector", "capTier", "coinBaseRateShrunk", "coinResolvedN"].includes(name)) return "asset";
  if (name.startsWith("ethBtc")) return "btc-regime";
  if (name.startsWith("btc") || name.startsWith("beta") || name.startsWith("corr") || name.startsWith("coin")) return "btc-regime";
  if (name.startsWith("trader") || name === "concurrentSignalsSameDir") return "trader-stats";
  if (["funding", "fundingCrowded", "openInterest", "premiumBps"].includes(name)) return "derivatives";
  if (["session", "weekday", "hourUtc", "weekend"].includes(name)) return "time";
  if (["rr", "slAtrH", "tpAtrH", "feeDragR", "horizonTf"].includes(name)) return "geometry";
  return "ta";
}
