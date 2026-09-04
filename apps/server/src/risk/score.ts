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
  // Established alts with deep, liquid perp markets — previously mislabeled
  // "small" and over-penalized (e.g. WLD, ONDO ran well). They are not majors,
  // but they are not the illiquid long tail either.
  "WLD", "ONDO", "ENA", "JTO", "TIA", "PENGU", "PEPE", "WIF", "JUP", "ORDI",
  "FET", "ENS", "PYTH", "DYDX", "STRK", "GALA", "BONK", "FLOKI", "RENDER", "KAS",
]);

export type CapTier = "large" | "mid" | "small";
export function capTier(symbol: string): CapTier {
  const s = symbol.toUpperCase();
  if (LARGE.has(s)) return "large";
  if (MID.has(s)) return "mid";
  return "small";
}

/**
 * ENTRY slippage tolerance (fraction) by cap tier — the fill bound on the entry
 * IOC. Scaled to LIQUIDITY: small caps have the WIDEST spreads, so a tight bound
 * leaves the aggressive IOC unable to cross the book (the "could not immediately
 * match" failure) — they get the MOST room (0.5%); mid caps 0.3%; large caps are
 * deep and tight, so 0.1% is plenty and avoids overpaying. This applies to
 * ENTRIES ONLY. Protective/exit orders (stop-loss, take-profit, partial/full
 * closes) must always execute, so they use PROTECTIVE_SLIPPAGE instead — a stop
 * is never allowed to go unfilled to save a few bps.
 */
export function tierSlippage(symbol: string): number {
  const t = capTier(symbol);
  return t === "small" ? 0.005 : t === "mid" ? 0.003 : 0.001;
}

/**
 * Fill tolerance for orders that MUST execute — stop-loss, take-profit, and
 * partial/full closes. Wide on purpose: protecting or exiting a position always
 * beats saving slippage, so a stop can never fail to fill on a fast move and
 * leave the position naked. (Trigger price is unchanged; only the fill bound.)
 */
export const PROTECTIVE_SLIPPAGE = 0.05;

/**
 * One-retry fill bound for an ENTRY whose tier slippage left its aggressive IOC
 * unable to cross the book. This is the widest entry tolerance we ever concede
 * (0.5%, = the small-cap default), used only on that specific rejection and only
 * when strictly wider than the tier bound that already failed — so it widens a
 * mid (0.3%) or large (0.1%) cap that hit a momentary thin book, while a small
 * cap already at 0.5% is not retried (it's already at the ceiling).
 */
export const ENTRY_RETRY_SLIPPAGE = 0.005;

/**
 * True for Hyperliquid's "an IOC/market order found no resting liquidity to cross"
 * rejection — i.e. the aggressive limit didn't reach the book, not a real error
 * (margin, size, wrong side). The one legitimate case to retry an entry wider.
 */
export function isNoCrossError(error: string | undefined): boolean {
  return /could not immediately match/i.test(error ?? "");
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
 *     both as an inherent baseline and via that tier's realised track record,
 *  5. the ORDER SIDE (is this provider more reliable long or short?),
 *  6. a weak week-of-month effect (sample-gated, enriches over months),
 *  7. a weak day-of-week effect (e.g. weekend vs. Monday; sample-gated),
 *  8. RECENT FORM / momentum — the last up-to-10 settled trades vs the long-run
 *     record, so a provider on a hot streak scores higher (capped ±12).
 * Stop-loss presence and leverage are intentionally NOT scored: signals here
 * always carry a stop, and leverage is our own setting — neither says anything
 * about how risky the trade itself is. Every adjustment logs a transparent reason.
 *
 * @param channelHistory  trades from the signal's own channel
 * @param pool            closed trades across ALL channels (for symbol + tier records)
 */
/** Week of the month (1–4; days 29–31 fold into week 4). */
export function monthWeek(day: number): number {
  return Math.min(4, Math.ceil(day / 7));
}

/** Short weekday name for a UTC day index (0=Sun … 6=Sat). */
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function assessRisk(
  parsed: ParsedSignal,
  channelHistory: Trade[],
  pool: Trade[] = [],
  at: Date = new Date(),
): RiskRating {
  const reasons: string[] = [];
  let score = 50;

  // ---- 1. channel history ----
  // Only REAL settled trades count — shadow trades are hypothetical (blocked
  // reds) and closed rows without a finite PnL carry no result. record() applies
  // the same filter, so win-rate, net and profit-factor share one population.
  const chClosed = channelHistory.filter(
    (t) => t.status === "closed" && !t.shadow && Number.isFinite(t.realizedPnl),
  );
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
      } else if (rr >= 3) {
        score += 12;
        reasons.push(`Excellent risk/reward (${rr.toFixed(2)})`);
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

  // ---- 5. order side (long vs short): is this provider better at THIS side? ----
  // Compare the channel's win rate on the CURRENT signal's side to its overall
  // win rate. Sample-gated, so it stays neutral until enough same-side trades
  // exist; over months this surfaces whether the trader is more reliable long
  // or short and nudges the score accordingly (capped ±10 so it can't dominate).
  if (n >= MIN_SAMPLE) {
    const sideRec = record(chClosed.filter((t) => t.side === parsed.side));
    if (sideRec.n >= 5) {
      const conf = Math.min(1, sideRec.n / 10);
      const adj = Math.round(clamp((sideRec.winRate - ch.winRate) * 45, -10, 10) * conf);
      if (adj !== 0) score += adj;
      reasons.push(
        `${parsed.side} record: ${(sideRec.winRate * 100).toFixed(0)}% over ${sideRec.n} vs ${(ch.winRate * 100).toFixed(0)}% avg`,
      );
    } else if (sideRec.n > 0) {
      reasons.push(`${parsed.side}: only ${sideRec.n} prior ${parsed.side} trade${sideRec.n === 1 ? "" : "s"} — thin history`);
    }
  }

  // ---- 6. week-of-month effect (WEAK, sample-gated to avoid overfitting) ----
  // Some providers run hotter/colder in a part of the month. Compare the channel's
  // win rate in the CURRENT week of the month to its own overall win rate; only
  // nudge when there's real data, capped at ±8 so this noisy signal can't dominate.
  // The gates keep it neutral early; it enriches naturally as months accumulate.
  if (n >= 8) {
    const nowWeek = monthWeek(at.getUTCDate());
    const inWeek = chClosed.filter((t) => t.openedAt && monthWeek(new Date(t.openedAt).getUTCDate()) === nowWeek);
    const pr = record(inWeek);
    if (pr.n >= 5) {
      const adj = Math.round(clamp((pr.winRate - ch.winRate) * 40, -8, 8));
      if (adj !== 0) {
        score += adj;
        reasons.push(
          `Week ${nowWeek} of month: ${(pr.winRate * 100).toFixed(0)}% over ${pr.n} vs ${(ch.winRate * 100).toFixed(0)}% avg`,
        );
      }
    }
  }

  // ---- 7. day-of-week effect (WEAK, sample-gated) ----
  // Some providers are sharper on certain weekdays (e.g. weekend vs. Monday).
  // Compare the channel's win rate on the CURRENT signal's weekday to its overall
  // rate; gated + capped ±8, so it stays neutral until enough same-day trades
  // accumulate and can never dominate the score.
  if (n >= 8) {
    const nowDow = at.getUTCDay();
    const inDow = chClosed.filter((t) => t.openedAt && new Date(t.openedAt).getUTCDay() === nowDow);
    const pr = record(inDow);
    if (pr.n >= 5) {
      const adj = Math.round(clamp((pr.winRate - ch.winRate) * 40, -8, 8));
      if (adj !== 0) {
        score += adj;
        reasons.push(
          `${DOW[nowDow]}: ${(pr.winRate * 100).toFixed(0)}% over ${pr.n} vs ${(ch.winRate * 100).toFixed(0)}% avg`,
        );
      }
    }
  }

  // ---- 8. recent form (momentum): reward a provider on a hot streak ----
  // A channel's long-run win rate is slow to move; recent form is what "ran
  // great lately" (e.g. Gauls' WLD/ONDO/JTO run). Compare the last up-to-10
  // settled trades to the channel's overall record and nudge the score toward
  // current form — capped ±12 so a streak informs but can't dominate the base.
  if (n >= MIN_SAMPLE) {
    const bySettle = [...chClosed].sort(
      (a, b) => new Date(b.closedAt ?? b.openedAt).getTime() - new Date(a.closedAt ?? a.openedAt).getTime(),
    );
    const rf = record(bySettle.slice(0, Math.min(bySettle.length, 10)));
    if (rf.n >= 5) {
      const wrAdj = clamp((rf.winRate - ch.winRate) * 40, -12, 12);
      const netAdj = rf.net > 0 && rf.net / rf.n > ch.net / n ? 4 : rf.net < 0 ? -4 : 0;
      const adj = Math.round(clamp(wrAdj + netAdj, -12, 12));
      if (adj !== 0) {
        score += adj;
        reasons.push(
          `Recent form (last ${rf.n}): ${(rf.winRate * 100).toFixed(0)}% win, net ${rf.net >= 0 ? "+" : ""}${rf.net.toFixed(0)} vs ${(ch.winRate * 100).toFixed(0)}% avg`,
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
