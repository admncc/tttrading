import { trades as tradesRepo } from "../db/repositories.js";
import { all as allExchanges } from "../exchanges/registry.js";
import { capTier, type CapTier } from "./score.js";
import { log } from "../logger.js";
import { rMultiple, classifyOutcome, type TradeOutcomeClass } from "../lib/metrics.js";
import { computeHeat, type HeatPosition, type HeatResult } from "./insightsMath.js";

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
  /** Initial risk in USDC = |entry − stop| × INITIAL size, frozen at entry (RI-3). */
  riskUsd?: number;
  /** R-multiple = realized net PnL / initial risk (RI-3; undefined when risk unknown). */
  r?: number;
  /** Provenance of the risk used for R (P1-R8): recorded vs backfilled estimate. */
  initialRiskSource?: "recorded" | "backfilled_estimate";
  /** Clean class: win / loss / scratch (RI-4). Scratch is out of win-rate, in expectancy. */
  outcomeClass: TradeOutcomeClass;
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
  venue: string;
  notional: number;
  leverage: number;
  /** Risk to stop in USDC = |entry − stop| × size (undefined when no stop). */
  riskUsd?: number;
  hasStop: boolean;
  /** True for an unfilled working limit order (excluded from live heat, RI-2). */
  working: boolean;
}

export interface RiskInsightsResult {
  generatedAt: string;
  /** Trades returned in this payload (capped). */
  totalClosed: number;
  /** Total closed trades in the DB — so the UI can label a capped window (RI-5). */
  totalClosedAll: number;
  trades: InsightTrade[];
  open: OpenRisk[];
  /** Account equity (primary Hyperliquid venue) for heat % — legacy field. */
  equity?: number;
  /** Equity per venue, USD (RI-1). */
  equityByVenue: Record<string, number>;
  /** Portfolio heat maths across all venues (RI-1, RI-2). */
  heat: HeatResult;
}

const HOURS = 3_600_000;
const CLOSED_CAP = 3000;

function riskUsdOf(entry: number, stop: number | undefined, size: number): number | undefined {
  if (stop === undefined || !(size > 0)) return undefined;
  const r = Math.abs(entry - stop) * size;
  return r > 0 ? r : undefined;
}

export async function riskInsights(): Promise<RiskInsightsResult> {
  const closed = tradesRepo.closed(CLOSED_CAP).filter((t) => Number.isFinite(t.realizedPnl) && !t.shadow);
  const totalClosedAll = tradesRepo.closedCount();
  const trades: InsightTrade[] = closed.map((t) => {
    const net = t.realizedPnl ?? 0;
    // RI-3: R from the INITIAL risk (frozen at entry), not the post-partial size.
    // Fall back to a live recompute for legacy rows the migration couldn't fill.
    const riskUsd = t.initialRisk ?? riskUsdOf(t.entryPrice, t.stopLoss, t.initialSize ?? t.size);
    const r = rMultiple(net, riskUsd);
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
      r: r !== undefined ? Number(r.toFixed(3)) : undefined,
      initialRiskSource: t.initialRiskSource,
      outcomeClass: classifyOutcome(net, r),
      holdHours,
      slipPct,
    };
  });

  const openTrades = tradesRepo.open().filter((t) => !t.shadow);
  const workingTrades = tradesRepo.working().filter((t) => !t.shadow);
  const toOpenRisk = (working: boolean) => (t: (typeof openTrades)[number]): OpenRisk => ({
    symbol: t.symbol.toUpperCase(),
    tier: capTier(t.symbol),
    channel: t.groupName,
    side: t.side,
    venue: t.exchange ?? "hyperliquid",
    notional: t.notionalUsd,
    leverage: t.leverage,
    riskUsd: riskUsdOf(t.entryPrice || t.signalEntry || 0, t.stopLoss, t.size),
    hasStop: t.stopLoss !== undefined,
    working,
  });
  const open: OpenRisk[] = [...openTrades.map(toOpenRisk(false)), ...workingTrades.map(toOpenRisk(true))];

  // RI-1: sum equity across every live venue (margin isn't shared, but the
  // portfolio-level heat needs the whole account).
  const equityByVenue: Record<string, number> = {};
  await Promise.all(
    allExchanges().map(async (ex) => {
      try {
        const summ = await ex.getAccountSummary();
        if (summ && Number.isFinite(summ.accountValue)) equityByVenue[ex.name] = summ.accountValue;
      } catch (err) {
        log.warn(`risk-insights: equity unavailable (${ex.name}):`, err instanceof Error ? err.message : err);
      }
    }),
  );

  const heatPos = (r: OpenRisk): HeatPosition => ({
    venue: r.venue,
    notional: r.notional,
    riskUsd: r.riskUsd,
    side: r.side,
  });
  const heat = computeHeat(
    open.filter((o) => !o.working).map(heatPos),
    open.filter((o) => o.working).map(heatPos),
    equityByVenue,
  );

  return {
    generatedAt: new Date().toISOString(),
    totalClosed: trades.length,
    totalClosedAll,
    trades,
    open,
    equity: equityByVenue["hyperliquid"] ?? heat.totalEquity,
    equityByVenue,
    heat,
  };
}
