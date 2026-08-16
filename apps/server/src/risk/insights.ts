import { trades as tradesRepo } from "../db/repositories.js";
import { activeHyperliquid } from "../exchanges/registry.js";
import { capTier, type CapTier } from "./score.js";
import { log } from "../logger.js";

/** One settled trade, flattened for the Risk Insights page. All aggregation and
 *  filtering (by channel, coin, cap-tier, side, session, hold-time …) happen
 *  client-side on this list; the server just enriches each row with the inputs a
 *  professional edge analysis needs (R-multiples, hold time, slippage). */
export interface InsightTrade {
  symbol: string;
  tier: CapTier;
  channel: string;
  side: "long" | "short";
  net: number;
  /** Settle time (closedAt, else openedAt) — ISO, for ordering / week-of-month. */
  at: string;
  /** Entry time (openedAt) — ISO, for the weekday / session breakdown. */
  openedAt: string;
  leverage: number;
  notional: number;
  /** Initial risk in USDC = |entry − stop| × size (undefined when no stop). */
  riskUsd?: number;
  /** R-multiple = realized PnL / initial risk (undefined when risk unknown). */
  r?: number;
  /** Hold time in hours (closed − opened). */
  holdHours?: number;
  /** Signed entry slippage vs the signal's asked price, in % (+ = worse fill). */
  slipPct?: number;
}

/** A currently-open position, for live portfolio-risk (heat / concentration). */
export interface OpenRisk {
  symbol: string;
  tier: CapTier;
  channel: string;
  side: "long" | "short";
  notional: number;
  leverage: number;
  /** Risk to stop in USDC = |entry − stop| × size (undefined when no stop). */
  riskUsd?: number;
  hasStop: boolean;
}

export interface RiskInsightsResult {
  generatedAt: string;
  totalClosed: number;
  trades: InsightTrade[];
  open: OpenRisk[];
  /** Account equity (primary Hyperliquid venue) for heat % — undefined if unreachable. */
  equity?: number;
}

const HOURS = 3_600_000;

function riskUsdOf(entry: number, stop: number | undefined, size: number): number | undefined {
  if (stop === undefined || !(size > 0)) return undefined;
  const r = Math.abs(entry - stop) * size;
  return r > 0 ? r : undefined;
}

export async function riskInsights(): Promise<RiskInsightsResult> {
  const closed = tradesRepo.closed(3000).filter((t) => Number.isFinite(t.realizedPnl) && !t.shadow);
  const trades: InsightTrade[] = closed.map((t) => {
    const net = t.realizedPnl ?? 0;
    const riskUsd = riskUsdOf(t.entryPrice, t.stopLoss, t.size);
    const opened = t.openedAt ? new Date(t.openedAt).getTime() : NaN;
    const settled = t.closedAt ? new Date(t.closedAt).getTime() : NaN;
    const holdHours =
      Number.isFinite(opened) && Number.isFinite(settled) && settled >= opened
        ? Number(((settled - opened) / HOURS).toFixed(2))
        : undefined;
    // Slippage: how much worse than the asked price we actually entered.
    // Long fills worse when higher; short fills worse when lower.
    let slipPct: number | undefined;
    if (t.signalEntry && t.signalEntry > 0 && t.entryPrice > 0) {
      const raw = ((t.entryPrice - t.signalEntry) / t.signalEntry) * 100;
      slipPct = Number((t.side === "long" ? raw : -raw).toFixed(3));
    }
    return {
      symbol: t.symbol.toUpperCase(),
      tier: capTier(t.symbol),
      channel: t.groupName,
      side: t.side,
      net,
      at: t.closedAt ?? t.openedAt ?? "",
      openedAt: t.openedAt ?? "",
      leverage: t.leverage,
      notional: t.notionalUsd,
      riskUsd,
      r: riskUsd ? Number((net / riskUsd).toFixed(3)) : undefined,
      holdHours,
      slipPct,
    };
  });

  const open: OpenRisk[] = [...tradesRepo.open(), ...tradesRepo.working()]
    .filter((t) => !t.shadow)
    .map((t) => {
      const riskUsd = riskUsdOf(t.entryPrice || t.signalEntry || 0, t.stopLoss, t.size);
      return {
        symbol: t.symbol.toUpperCase(),
        tier: capTier(t.symbol),
        channel: t.groupName,
        side: t.side,
        notional: t.notionalUsd,
        leverage: t.leverage,
        riskUsd,
        hasStop: t.stopLoss !== undefined,
      };
    });

  let equity: number | undefined;
  try {
    equity = (await activeHyperliquid().getAccountSummary())?.accountValue;
  } catch (err) {
    log.warn("risk-insights: equity unavailable:", err instanceof Error ? err.message : err);
  }

  return { generatedAt: new Date().toISOString(), totalClosed: trades.length, trades, open, equity };
}
