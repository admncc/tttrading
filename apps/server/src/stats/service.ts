import type {
  AdvancedStats,
  AnalyticsBucket,
  AnalyticsResponse,
  DashboardStats,
  EquityPoint,
  GroupPerformance,
  PerformanceStats,
  RiskAudit,
  Trade,
} from "@tttrading/shared";
import { groups, trades as tradesRepo } from "../db/repositories.js";
import { broadcast } from "../ws/hub.js";

function emptyStats(): PerformanceStats {
  return {
    trades: 0,
    openTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    realizedPnl: 0,
    bankedOpenPnl: 0,
    totalNotional: 0,
    avgPnl: 0,
    bestTrade: 0,
    worstTrade: 0,
    profitFactor: 0,
  };
}

export function computeStats(list: Trade[]): PerformanceStats {
  const s = emptyStats();
  let grossProfit = 0;
  let grossLoss = 0;
  let closedRealized = 0; // realized from fully-closed trades (drives avg/PF/win)
  let bankedOpen = 0; // profit already booked from partials on still-OPEN trades
  const closedPnls: number[] = [];

  for (const t of list) {
    // failed/canceled trades never opened a position — exclude from counts.
    if (t.status !== "open" && t.status !== "closed") continue;
    s.trades++;
    s.totalNotional += t.notionalUsd;
    if (t.status === "open") {
      s.openTrades++;
      // A partial take-profit on an open trade banks real, locked-in money —
      // count it as realized right away instead of hiding it until full close.
      bankedOpen += (t.bankedPnl ?? 0) - (t.bankedFees ?? 0);
      continue;
    }
    if (!Number.isFinite(t.realizedPnl)) continue;
    const pnl = t.realizedPnl as number;
    closedRealized += pnl;
    closedPnls.push(pnl);
    if (pnl >= 0) {
      s.wins++;
      grossProfit += pnl;
    } else {
      s.losses++;
      grossLoss += Math.abs(pnl);
    }
  }

  const closedCount = s.wins + s.losses;
  s.winRate = closedCount > 0 ? s.wins / closedCount : 0;
  // Per-trade figures stay closed-only so a half-booked open trade can't skew them.
  s.avgPnl = closedCount > 0 ? closedRealized / closedCount : 0;
  s.bestTrade = closedPnls.length ? Math.max(...closedPnls) : 0;
  s.worstTrade = closedPnls.length ? Math.min(...closedPnls) : 0;
  s.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  s.bankedOpenPnl = Number(bankedOpen.toFixed(2));
  // Headline realized = fully-closed results + profit already banked from partials.
  s.realizedPnl = Number((closedRealized + bankedOpen).toFixed(2));
  return s;
}

function equityCurve(list: Trade[]): EquityPoint[] {
  const closed = list
    .filter((t) => t.status === "closed" && Number.isFinite(t.realizedPnl) && t.closedAt)
    .sort((a, b) => (a.closedAt! < b.closedAt! ? -1 : 1));
  let cum = 0;
  const pts = closed.map((t) => {
    cum += t.realizedPnl!;
    return { t: t.closedAt!, pnl: Number(cum.toFixed(2)) };
  });
  // Reconcile the curve's endpoint with the headline Realized PnL (KPI): profit
  // already banked from partials on still-OPEN trades is realized money, but the
  // trades aren't closed yet, so it isn't in the closed-trade cumulative above.
  // Add it as a final point at "now" so the chart ends where the KPI reads,
  // instead of understating realized by the banked-on-open amount.
  const bankedOpen = list
    .filter((t) => t.status === "open")
    .reduce((sum, t) => sum + ((t.bankedPnl ?? 0) - (t.bankedFees ?? 0)), 0);
  if (Math.abs(bankedOpen) > 0.005) {
    pts.push({ t: new Date().toISOString(), pnl: Number((cum + bankedOpen).toFixed(2)) });
  }
  return pts;
}

function riskAudit(all: Trade[]): RiskAudit {
  const shadows = all.filter((t) => t.shadow);
  const resolved = shadows.filter((t) => t.status === "closed" && t.realizedPnl !== undefined);
  const wouldWin = resolved.filter((t) => (t.realizedPnl ?? 0) >= 0).length;
  const avoidedPnl = -resolved.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
  return {
    blocked: shadows.length,
    resolved: resolved.length,
    wouldWin,
    wouldLose: resolved.length - wouldWin,
    avoidedPnl: Number(avoidedPnl.toFixed(2)),
  };
}

export function dashboard(): DashboardStats {
  const all = tradesRepo.list(5000);
  // Shadow trades are hypothetical (blocked reds) — keep them out of real perf.
  // Archived trades were explicitly retired by the user from analytics.
  const real = all.filter((t) => !t.shadow && !t.archived);
  const overall = computeStats(real);

  const byGroup: GroupPerformance[] = groups.list().map((g) => ({
    groupId: g.id,
    groupName: g.name,
    stats: computeStats(real.filter((t) => t.groupId === g.id)),
  }));

  return { overall, byGroup, equityCurve: equityCurve(real), riskAudit: riskAudit(all) };
}

/** Recompute and push the dashboard to all connected clients. */
export function pushStats(): void {
  broadcast({ type: "stats", stats: dashboard() });
}

/* ------------------------------ analytics ------------------------------ */

/** Largest peak-to-trough drop on a chronological cumulative-PnL series. */
function maxDrawdown(closed: Trade[]): number {
  const ordered = closed
    .filter((t) => t.closedAt && Number.isFinite(t.realizedPnl))
    .sort((a, b) => (a.closedAt! < b.closedAt! ? -1 : 1));
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of ordered) {
    cum += t.realizedPnl as number;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  return Number(maxDd.toFixed(2));
}

/** Extended metrics on top of the base performance stats. */
function computeAdvanced(list: Trade[]): AdvancedStats {
  const base = computeStats(list);
  const closed = list.filter((t) => t.status === "closed" && Number.isFinite(t.realizedPnl));
  const winsPnl = closed.map((t) => t.realizedPnl as number).filter((p) => p >= 0);
  const lossPnl = closed.map((t) => t.realizedPnl as number).filter((p) => p < 0);
  const grossProfit = winsPnl.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(lossPnl.reduce((s, p) => s + p, 0));
  const holdHours = closed
    .filter((t) => t.closedAt)
    .map((t) => (new Date(t.closedAt!).getTime() - new Date(t.openedAt).getTime()) / 3_600_000)
    .filter((h) => Number.isFinite(h) && h >= 0);
  const totalFees = closed.reduce((s, t) => s + (t.fees ?? 0), 0);
  // Adverse entry slippage vs the signal's price, in basis points: for a long,
  // paying MORE than asked is adverse (+); for a short, filling LOWER is adverse.
  const slips = closed
    .map((t) => {
      if (t.signalEntry === undefined || !(t.signalEntry > 0)) return undefined;
      const diff = t.side === "long" ? t.entryPrice - t.signalEntry : t.signalEntry - t.entryPrice;
      return (diff / t.signalEntry) * 10_000;
    })
    .filter((s): s is number => s !== undefined && Number.isFinite(s));
  // Realized reward:risk = PnL ÷ (initial risk from entry→SL), for trades that
  // had a stop-loss and a positive size.
  const rrs = closed
    .map((t) => {
      if (t.stopLoss === undefined || !(t.size > 0)) return undefined;
      const riskPerUnit = Math.abs(t.entryPrice - t.stopLoss);
      const riskAmount = riskPerUnit * t.size;
      if (!(riskAmount > 0)) return undefined;
      return (t.realizedPnl as number) / riskAmount;
    })
    .filter((r): r is number => r !== undefined && Number.isFinite(r));
  return {
    ...base,
    avgRR: rrs.length ? Number((rrs.reduce((s, r) => s + r, 0) / rrs.length).toFixed(2)) : 0,
    rrSampleSize: rrs.length,
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    avgWin: winsPnl.length ? Number((grossProfit / winsPnl.length).toFixed(2)) : 0,
    avgLoss: lossPnl.length ? Number((-grossLoss / lossPnl.length).toFixed(2)) : 0,
    expectancy: base.avgPnl,
    maxDrawdown: maxDrawdown(closed),
    avgHoldHours: holdHours.length
      ? Number((holdHours.reduce((s, h) => s + h, 0) / holdHours.length).toFixed(1))
      : 0,
    totalFees: Number(totalFees.toFixed(2)),
    avgSlippageBps: slips.length ? Number((slips.reduce((s, v) => s + v, 0) / slips.length).toFixed(1)) : 0,
    slippageSampleSize: slips.length,
  };
}

function bucketCurve(list: Trade[]): EquityPoint[] {
  return equityCurve(list);
}

function bucket(key: string, label: string, list: Trade[]): AnalyticsBucket {
  return { key, label, stats: computeAdvanced(list), equityCurve: bucketCurve(list) };
}

/**
 * Rich analytics across groups, symbols and sides. Excludes shadow trades
 * (hypothetical) unless requested; simulated (test-mode) trades are included so
 * the view isn't empty on testnet.
 */
export function analytics(opts: {
  from?: string;
  to?: string;
  includeShadow?: boolean;
} = {}): AnalyticsResponse {
  let list = tradesRepo.list(10000);
  if (!opts.includeShadow) list = list.filter((t) => !t.shadow);
  // Archived trades were explicitly retired by the user from analytics.
  list = list.filter((t) => !t.archived);
  // Window by when PnL was REALIZED (closedAt) so a trade opened before the
  // window but closed inside it is attributed correctly. Open trades (no
  // realized result yet) are always kept so current exposure still shows.
  if (opts.from) {
    list = list.filter((t) => (t.status === "closed" ? (t.closedAt ?? t.openedAt) >= opts.from! : true));
  }
  if (opts.to) {
    list = list.filter((t) => (t.status === "closed" ? (t.closedAt ?? t.openedAt) <= opts.to! : true));
  }

  const byKey = <K extends string>(pick: (t: Trade) => K): Map<K, Trade[]> => {
    const m = new Map<K, Trade[]>();
    for (const t of list) {
      const k = pick(t);
      const arr = m.get(k);
      if (arr) arr.push(t);
      else m.set(k, [t]);
    }
    return m;
  };

  const groupBuckets: AnalyticsBucket[] = [...byKey((t) => t.groupId).entries()]
    .map(([id, ts]) => bucket(id, ts[0]!.groupName || id, ts))
    .sort((a, b) => b.stats.realizedPnl - a.stats.realizedPnl);

  const symbolBuckets: AnalyticsBucket[] = [...byKey((t) => t.symbol).entries()]
    .map(([sym, ts]) => bucket(sym, sym, ts))
    .sort((a, b) => b.stats.realizedPnl - a.stats.realizedPnl);

  const sideBuckets: AnalyticsBucket[] = (["long", "short"] as const)
    .map((side) => bucket(side, side, list.filter((t) => t.side === side)))
    .filter((b) => b.stats.trades > 0);

  const includesSimulated = list.some((t) => t.simulated);
  const closedTrades = list.filter((t) => t.status === "closed").length;

  return {
    overall: computeAdvanced(list),
    byGroup: groupBuckets,
    bySymbol: symbolBuckets,
    bySide: sideBuckets,
    equityCurve: equityCurve(list),
    closedTrades,
    includesSimulated,
  };
}
