import type {
  DashboardStats,
  EquityPoint,
  GroupPerformance,
  PerformanceStats,
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
    totalNotional: 0,
    avgPnl: 0,
    bestTrade: 0,
    worstTrade: 0,
    profitFactor: 0,
  };
}

export function computeStats(list: Trade[]): PerformanceStats {
  const s = emptyStats();
  s.trades = list.length;
  let grossProfit = 0;
  let grossLoss = 0;
  const closedPnls: number[] = [];

  for (const t of list) {
    s.totalNotional += t.notionalUsd;
    if (t.status === "open") {
      s.openTrades++;
      continue;
    }
    if (t.realizedPnl === undefined) continue;
    const pnl = t.realizedPnl;
    s.realizedPnl += pnl;
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
  s.avgPnl = closedCount > 0 ? s.realizedPnl / closedCount : 0;
  s.bestTrade = closedPnls.length ? Math.max(...closedPnls) : 0;
  s.worstTrade = closedPnls.length ? Math.min(...closedPnls) : 0;
  s.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  return s;
}

function equityCurve(list: Trade[]): EquityPoint[] {
  const closed = list
    .filter((t) => t.status === "closed" && t.realizedPnl !== undefined && t.closedAt)
    .sort((a, b) => (a.closedAt! < b.closedAt! ? -1 : 1));
  let cum = 0;
  return closed.map((t) => {
    cum += t.realizedPnl!;
    return { t: t.closedAt!, pnl: Number(cum.toFixed(2)) };
  });
}

export function dashboard(): DashboardStats {
  const all = tradesRepo.list(5000);
  const overall = computeStats(all);

  const byGroup: GroupPerformance[] = groups.list().map((g) => ({
    groupId: g.id,
    groupName: g.name,
    stats: computeStats(all.filter((t) => t.groupId === g.id)),
  }));

  return { overall, byGroup, equityCurve: equityCurve(all) };
}

/** Recompute and push the dashboard to all connected clients. */
export function pushStats(): void {
  broadcast({ type: "stats", stats: dashboard() });
}
