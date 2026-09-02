/**
 * Pure portfolio-heat maths for Risk Insights (RI-1, RI-2). No DB, no network —
 * fed plain numbers so it can be unit-tested against hand calculations.
 */

/** A position that is actually filled and live on a venue. */
export interface HeatPosition {
  venue: string;
  notional: number;
  /** Risk to stop in USD (|entry−stop|×size); undefined when the stop is unknown. */
  riskUsd?: number;
  side: "long" | "short";
}

export interface PerVenueHeat {
  venue: string;
  equity: number;
  riskUsd: number;
  notional: number;
  /** Venue-local heat = venue risk / venue equity — margin is NOT shared across
   *  venues, so liquidation risk is per-venue (RI-1). */
  heat?: number;
}

export interface HeatResult {
  /** Summed equity across every venue, USD-normalised (RI-1). */
  totalEquity?: number;
  /** Risk-to-stop of filled positions / total equity (RI-2: excludes working orders). */
  heatLive?: number;
  /** Worst case if every working limit also filled / total equity (RI-2). */
  heatIfAllFilled?: number;
  /** Summed risk-to-stop of filled positions (USD). */
  riskLiveUsd: number;
  /** Summed risk-to-stop of filled + working (USD). */
  riskIfAllFilledUsd: number;
  grossNotionalLive: number;
  /** Signed net exposure of filled positions (long +, short −), USD. */
  netExposureLive: number;
  perVenue: PerVenueHeat[];
}

/**
 * Compute portfolio heat. `live` are filled positions; `working` are unfilled
 * limit orders (counted only toward heatIfAllFilled, never toward live heat).
 * `equityByVenue` sums to total equity; per-venue heat divides each venue's live
 * risk by that venue's own equity.
 */
export function computeHeat(
  live: HeatPosition[],
  working: HeatPosition[],
  equityByVenue: Record<string, number>,
): HeatResult {
  const riskLiveUsd = live.reduce((s, p) => s + (p.riskUsd ?? 0), 0);
  const riskWorkingUsd = working.reduce((s, p) => s + (p.riskUsd ?? 0), 0);
  const riskIfAllFilledUsd = riskLiveUsd + riskWorkingUsd;
  const grossNotionalLive = live.reduce((s, p) => s + p.notional, 0);
  const netExposureLive = live.reduce((s, p) => s + (p.side === "long" ? p.notional : -p.notional), 0);

  const equities = Object.values(equityByVenue);
  const totalEquity = equities.length ? equities.reduce((s, e) => s + e, 0) : undefined;

  const venues = new Set<string>([
    ...Object.keys(equityByVenue),
    ...live.map((p) => p.venue),
  ]);
  const perVenue: PerVenueHeat[] = [...venues].map((venue) => {
    const equity = equityByVenue[venue] ?? 0;
    const riskUsd = live.filter((p) => p.venue === venue).reduce((s, p) => s + (p.riskUsd ?? 0), 0);
    const notional = live.filter((p) => p.venue === venue).reduce((s, p) => s + p.notional, 0);
    return { venue, equity, riskUsd, notional, heat: equity > 0 ? riskUsd / equity : undefined };
  });

  return {
    totalEquity,
    heatLive: totalEquity && totalEquity > 0 ? riskLiveUsd / totalEquity : undefined,
    heatIfAllFilled: totalEquity && totalEquity > 0 ? riskIfAllFilledUsd / totalEquity : undefined,
    riskLiveUsd,
    riskIfAllFilledUsd,
    grossNotionalLive,
    netExposureLive,
    perVenue,
  };
}
