import { trades as tradesRepo } from "../db/repositories.js";
import { capTier, type CapTier } from "./score.js";

/** One settled trade, flattened for the Risk Insights page (aggregation + all
 *  filtering — by channel, coin, cap-tier — happen client-side on this list). */
export interface InsightTrade {
  symbol: string;
  tier: CapTier;
  channel: string;
  side: "long" | "short";
  net: number;
  /** Settle time (closedAt, else openedAt) — ISO, for ordering / week-of-month. */
  at: string;
  /** Entry time (openedAt) — ISO, for the weekday / day-of-week breakdown. */
  openedAt: string;
}

export function riskInsights(): { generatedAt: string; totalClosed: number; trades: InsightTrade[] } {
  const closed = tradesRepo.closed(3000).filter((t) => Number.isFinite(t.realizedPnl) && !t.shadow);
  const trades: InsightTrade[] = closed.map((t) => ({
    symbol: t.symbol.toUpperCase(),
    tier: capTier(t.symbol),
    channel: t.groupName,
    side: t.side,
    net: t.realizedPnl ?? 0,
    at: t.closedAt ?? t.openedAt ?? "",
    openedAt: t.openedAt ?? "",
  }));
  return { generatedAt: new Date().toISOString(), totalClosed: trades.length, trades };
}
