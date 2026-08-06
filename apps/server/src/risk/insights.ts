import { trades as tradesRepo } from "../db/repositories.js";
import { capTier, type CapTier } from "./score.js";

/** One settled trade, flattened for the Risk Insights page (aggregation + all
 *  filtering — by channel, coin, cap-tier — happen client-side on this list). */
export interface InsightTrade {
  symbol: string;
  tier: CapTier;
  channel: string;
  net: number;
  /** Settle time (closedAt, else openedAt) — ISO, for ordering / week-of-month. */
  at: string;
}

export function riskInsights(): { generatedAt: string; totalClosed: number; trades: InsightTrade[] } {
  const closed = tradesRepo.closed(3000).filter((t) => Number.isFinite(t.realizedPnl) && !t.shadow);
  const trades: InsightTrade[] = closed.map((t) => ({
    symbol: t.symbol.toUpperCase(),
    tier: capTier(t.symbol),
    channel: t.groupName,
    net: t.realizedPnl ?? 0,
    at: t.closedAt ?? t.openedAt ?? "",
  }));
  return { generatedAt: new Date().toISOString(), totalClosed: trades.length, trades };
}
