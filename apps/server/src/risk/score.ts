import type { ParsedSignal, RiskLevel, RiskRating, Trade } from "@tttrading/shared";

const MIN_SAMPLE = 5; // below this we can't trust the channel's history

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ---- market-cap tiers ---------------------------------------------------------
// Coarse buckets (no live market-cap feed): the majors are "large", a set of
// established top coins are "mid", everything else (the long tail of alts) is
// "small". Gold/XAU are treated as large/stable. Large caps are inherently
// steadier; small caps carry more baseline risk.
const LARGE = new Set(["BTC", "ETH", "XAU", "GOLD"]);
const MID = new Set([
  "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "DOT", "MATIC", "POL",
  "LTC", "BCH", "ATOM", "UNI", "TRX", "TON", "NEAR", "APT", "ICP", "FIL",
  "ETC", "XLM", "HBAR", "ARB", "OP", "INJ", "SUI", "SEI", "AAVE", "RUNE",
  "TAO", "CRV", "MKR", "LDO", "STX", "IMX", "GRT", "ALGO", "SAND", "AXS",
]);

export type CapTier = "large" | "mid" | "small";
export function capTier(symbol: string): CapTier {
  const s = symbol.toUpperCase();
  if (LARGE.has(s)) return "large";
  if (MID.has(s)) return "mid";
  return "small";
}

/** Win-rate + net PnL of a set of settled trades (already filtered to closed). */
function record(trades: Trade[]): { n: number; winRate: number; net: number } {
  const settled = trades.filter((t) => Number.isFinite(t.realizedPnl) && !t.shadow);
  const n = settled.length;
  if (n === 0) return { n: 0, winRate: 0, net: 0 };
  const wins = settled.filter((t) => (t.realizedPnl ?? 0) >= 0).length;
  const net = settled.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
  return { n, winRate: wins / n, net };
}

/**
 * Traffic-light risk assessment for a signal. Higher score = safer. Combines:
 *  1. the CHANNEL's historical performance (does this provider deliver?),
 *  2. the risk/reward geometry of THIS signal,
 *  3. the SYMBOL's own track record here (how has this exact coin performed?) —
 *     a DOMINANT factor, so a coin that keeps losing is penalised hard,
 *  4. the coin's market-cap TIER (large caps steadier; small caps riskier),
 *     both as an inherent baseline and via that tier's realised track record.
 * Stop-loss presence and leverage are intentionally NOT scored: signals here
 * always carry a stop, and leverage is our own setting — neither says anything
 * about how risky the trade itself is. Every adjustment logs a transparent reason.
 *
 * @param channelHistory  trades from the signal's own channel
 * @param pool            closed trades across ALL channels (for symbol + tier records)
 */
const monthPeriod = (day: number): "early" | "mid" | "late" => (day <= 10 ? "early" : day <= 20 ? "mid" : "late");

export function assessRisk(
  parsed: ParsedSignal,
  channelHistory: Trade[],
  pool: Trade[] = [],
  at: Date = new Date(),
): RiskRating {
  const reasons: string[] = [];
  let score = 50;

  // ---- 1. channel history ----
  const chClosed = channelHistory.filter((t) => t.status === "closed");
  const ch = record(chClosed);
  const n = ch.n;
  if (n < MIN_SAMPLE) {
    reasons.push(`Little channel history (${n} closed trade${n === 1 ? "" : "s"})`);
  } else {
    const grossProfit = chClosed.filter((t) => (t.realizedPnl ?? 0) >= 0).reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
    const grossLoss = chClosed.filter((t) => (t.realizedPnl ?? 0) < 0).reduce((s, t) => s + Math.abs(t.realizedPnl ?? 0), 0);
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 3 : 0;
    score += clamp((ch.winRate - 0.5) * 60, -30, 30);
    score += clamp((profitFactor - 1) * 15, -20, 25);
    score += ch.net / n > 0 ? 8 : -8;
    reasons.push(
      `Channel win rate ${(ch.winRate * 100).toFixed(0)}%`,
      `Profit factor ${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"}`,
    );
  }

  // ---- 2. signal risk/reward geometry (SL always present; leverage is ours) ----
  if (parsed.entry !== undefined && parsed.stopLoss !== undefined && parsed.takeProfits?.length) {
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

  // ---- 3. per-SYMBOL track record (DOMINANT) ----
  const sym = parsed.symbol.toUpperCase();
  const symRec = record(pool.filter((t) => t.symbol.toUpperCase() === sym));
  if (symRec.n >= 3) {
    const conf = Math.min(1, symRec.n / 8); // a 3-trade record counts ~half, 8+ full
    score += Math.round(clamp((symRec.winRate - 0.5) * 80, -40, 24) * conf);
    score += Math.round((symRec.net >= 0 ? 6 : -14) * conf); // net loss on a coin is a strong flag
    reasons.push(
      `${parsed.symbol} track record: ${(symRec.winRate * 100).toFixed(0)}% win over ${symRec.n} trades ` +
        `(net ${symRec.net >= 0 ? "+" : ""}${symRec.net.toFixed(0)} USDC)`,
    );
  } else if (symRec.n > 0) {
    reasons.push(`${parsed.symbol}: only ${symRec.n} prior trade${symRec.n === 1 ? "" : "s"} — thin symbol history`);
  }

  // ---- 4. market-cap tier: inherent baseline + that tier's track record ----
  const tier = capTier(sym);
  score += tier === "large" ? 5 : tier === "small" ? -6 : 0; // small caps are inherently riskier
  const tierRec = record(pool.filter((t) => capTier(t.symbol) === tier));
  if (tierRec.n >= 5) {
    const conf = Math.min(1, tierRec.n / 12);
    score += Math.round(clamp((tierRec.winRate - 0.5) * 40, -18, 12) * conf);
    score += Math.round((tierRec.net >= 0 ? 4 : -8) * conf);
    reasons.push(
      `${tier}-cap record: ${(tierRec.winRate * 100).toFixed(0)}% win over ${tierRec.n} trades`,
    );
  } else {
    reasons.push(`${tier}-cap`);
  }

  // ---- 5. time-of-month effect (WEAK, sample-gated to avoid overfitting) ----
  // Some providers run hotter/colder in a part of the month. Compare the channel's
  // win rate in the CURRENT third of the month to its own overall win rate; only
  // nudge when there's real data, capped at ±8 so this noisy signal can't dominate.
  if (n >= 8) {
    const nowPeriod = monthPeriod(at.getUTCDate());
    const inPeriod = chClosed.filter((t) => t.openedAt && monthPeriod(new Date(t.openedAt).getUTCDate()) === nowPeriod);
    const pr = record(inPeriod);
    if (pr.n >= 5) {
      const adj = Math.round(clamp((pr.winRate - ch.winRate) * 40, -8, 8));
      if (adj !== 0) {
        score += adj;
        reasons.push(
          `${nowPeriod}-month: ${(pr.winRate * 100).toFixed(0)}% over ${pr.n} vs ${(ch.winRate * 100).toFixed(0)}% avg`,
        );
      }
    }
  }

  score = Math.round(clamp(score, 0, 100));

  // ---- map to a traffic light ----
  let level: RiskLevel;
  if (n < MIN_SAMPLE) {
    // Not enough channel history to trust: never green; red only on hard flags.
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
