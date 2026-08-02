import type { GroupSettings, ParsedSignal, RiskLevel, RiskRating, Trade } from "@tttrading/shared";

const MIN_SAMPLE = 5; // below this we can't trust the channel's history

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Traffic-light risk assessment for a signal, combining the channel's historical
 * performance with characteristics of the signal itself. Higher score = safer.
 * The score is intentionally transparent (every adjustment adds a reason) so the
 * classification can be reviewed and tuned.
 */
export function assessRisk(
  settings: GroupSettings,
  parsed: ParsedSignal,
  history: Trade[],
): RiskRating {
  const reasons: string[] = [];

  const closed = history.filter(
    (t) => t.status === "closed" && Number.isFinite(t.realizedPnl) && !t.shadow,
  );
  const n = closed.length;

  let score = 50;

  // ---- channel history ----
  if (n < MIN_SAMPLE) {
    reasons.push(`Little history (${n} closed trade${n === 1 ? "" : "s"})`);
  } else {
    const wins = closed.filter((t) => (t.realizedPnl ?? 0) >= 0).length;
    const winRate = wins / n;
    const grossProfit = closed
      .filter((t) => (t.realizedPnl ?? 0) >= 0)
      .reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
    const grossLoss = closed
      .filter((t) => (t.realizedPnl ?? 0) < 0)
      .reduce((s, t) => s + Math.abs(t.realizedPnl ?? 0), 0);
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 3 : 0;
    const expectancy = closed.reduce((s, t) => s + (t.realizedPnl ?? 0), 0) / n;

    score += clamp((winRate - 0.5) * 60, -30, 30);
    score += clamp((profitFactor - 1) * 15, -20, 25);
    score += expectancy > 0 ? 8 : -8;

    const recent = [...closed]
      .sort((a, b) => ((a.closedAt ?? "") < (b.closedAt ?? "") ? 1 : -1))
      .slice(0, 10);
    const recentPnl = recent.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
    score += recentPnl >= 0 ? 6 : -6;

    reasons.push(
      `Win rate ${(winRate * 100).toFixed(0)}%`,
      `Profit factor ${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"}`,
      `Recent 10: ${recentPnl >= 0 ? "+" : ""}${recentPnl.toFixed(0)} USDC`,
    );
  }

  // ---- signal characteristics ----
  if (parsed.stopLoss === undefined) {
    score -= 20;
    reasons.push("No stop-loss in signal");
  } else if (parsed.entry !== undefined && parsed.takeProfits?.length) {
    const risk = Math.abs(parsed.entry - parsed.stopLoss);
    const reward = Math.abs(parsed.takeProfits[0]! - parsed.entry);
    if (risk > 0) {
      const rr = reward / risk;
      if (rr < 1) {
        score -= 12;
        reasons.push(`Poor risk/reward (${rr.toFixed(2)})`);
      } else if (rr >= 2) {
        score += 8;
        reasons.push(`Good risk/reward (${rr.toFixed(2)})`);
      }
    }
  }

  if (settings.leverage >= 20) {
    score -= 12;
    reasons.push(`Very high leverage (${settings.leverage}x)`);
  } else if (settings.leverage >= 10) {
    score -= 6;
    reasons.push(`High leverage (${settings.leverage}x)`);
  }

  score = Math.round(clamp(score, 0, 100));

  // ---- map to a traffic light ----
  let level: RiskLevel;
  if (n < MIN_SAMPLE) {
    // Not enough history to trust: never green; red only on hard flags.
    level = score < 40 ? "red" : "yellow";
  } else if (score >= 66) {
    level = "green";
  } else if (score >= 42) {
    level = "yellow";
  } else {
    level = "red";
  }

  return { level, score, reasons, sampleSize: n };
}
