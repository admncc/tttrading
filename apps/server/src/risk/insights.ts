import type { Trade } from "@tttrading/shared";
import { trades as tradesRepo } from "../db/repositories.js";
import { capTier, monthWeek, type CapTier } from "./score.js";

export interface InsightBucket {
  key: string;
  tier?: CapTier;
  n: number;
  wins: number;
  winRate: number;
  net: number;
  avg: number;
}

function bucket(list: Trade[], keyOf: (t: Trade) => string, tierOf?: (k: string) => CapTier): InsightBucket[] {
  const m = new Map<string, { n: number; wins: number; net: number }>();
  for (const t of list) {
    const k = keyOf(t);
    if (!k) continue;
    const e = m.get(k) ?? { n: 0, wins: 0, net: 0 };
    e.n += 1;
    if ((t.realizedPnl ?? 0) >= 0) e.wins += 1;
    e.net += t.realizedPnl ?? 0;
    m.set(k, e);
  }
  return [...m.entries()]
    .map(([key, e]) => ({
      key,
      tier: tierOf?.(key),
      n: e.n,
      wins: e.wins,
      winRate: e.wins / e.n,
      net: e.net,
      avg: e.net / e.n,
    }))
    .sort((a, b) => b.net - a.net);
}

const WEEK_RANGE: Record<number, string> = { 1: "1–7", 2: "8–14", 3: "15–21", 4: "22–31" };
const periodOf = (iso?: string): string => {
  if (!iso) return "";
  const w = monthWeek(new Date(iso).getUTCDate());
  return `Week ${w} (${WEEK_RANGE[w]})`;
};

function summarize(list: Trade[]) {
  const n = list.length;
  const wins = list.filter((t) => (t.realizedPnl ?? 0) >= 0).length;
  const net = list.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
  return { n, winRate: n ? wins / n : 0, net };
}

/**
 * Performance breakdowns for the Risk Insights page: by channel, by coin, by
 * market-cap tier, and by third-of-month — globally and drilled down per channel.
 * Built from settled (closed, non-shadow) real trades.
 */
export function riskInsights() {
  const closed = tradesRepo.closed(3000).filter((t) => Number.isFinite(t.realizedPnl) && !t.shadow);

  const channels = [...new Set(closed.map((t) => t.groupName))]
    .map((name) => {
      const cl = closed.filter((t) => t.groupName === name);
      return {
        name,
        ...summarize(cl),
        bySymbol: bucket(cl, (t) => t.symbol.toUpperCase(), capTier),
        byTier: bucket(cl, (t) => capTier(t.symbol)),
        byPeriod: bucket(cl, (t) => periodOf(t.openedAt)),
      };
    })
    .sort((a, b) => b.net - a.net);

  return {
    generatedAt: new Date().toISOString(),
    totalClosed: closed.length,
    byChannel: bucket(closed, (t) => t.groupName),
    bySymbol: bucket(closed, (t) => t.symbol.toUpperCase(), capTier),
    byTier: bucket(closed, (t) => capTier(t.symbol)),
    byPeriod: bucket(closed, (t) => periodOf(t.openedAt)),
    channels,
  };
}
