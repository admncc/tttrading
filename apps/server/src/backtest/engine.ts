import type { BacktestResult, PerformanceStats, RiskLevel, Trade, TradeSide } from "@tttrading/shared";
import { log } from "../logger.js";
import { groups as groupsRepo, signals as signalsRepo, trades as tradesRepo } from "../db/repositories.js";
import { parseWithRegex } from "../signals/regex.js";
import { expandTakeProfits } from "../signals/takeprofit.js";
import { assessRisk } from "../risk/score.js";
import { computeStats } from "../stats/service.js";
import { hyperliquid } from "../hyperliquid/connector.js";

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

const FEE_RATE = 0.00035; // taker, per leg (approx round-trip below)

interface SimResult {
  pnl: number;
  outcome: "win" | "loss";
}

/**
 * First-touch simulation over OHLC candles. Pessimistic within a candle (the
 * stop is checked before take-profits). Scales out evenly across TP levels and
 * moves the stop to break-even after `beAfter` levels fill.
 */
function simulate(
  candles: Candle[],
  side: TradeSide,
  entry: number,
  stop: number | undefined,
  tps: number[],
  size: number,
  beAfter: number,
): SimResult | null {
  if (candles.length === 0 || entry <= 0) return null;
  const dir = side === "long" ? 1 : -1;
  const n = tps.length;
  const frac = n > 0 ? 1 / n : 0;
  let hit = 0;
  let banked = 0;
  let legNotional = 0;
  let effStop = stop;

  const fees = (exitNotional: number) => (entry * size + legNotional + exitNotional) * FEE_RATE;

  for (const k of candles) {
    if (effStop !== undefined) {
      const stopHit = side === "long" ? k.l <= effStop : k.h >= effStop;
      if (stopHit) {
        const remFrac = Math.max(0, 1 - hit * frac);
        const remSize = remFrac * size;
        const gross = banked + (effStop - entry) * dir * remSize;
        const pnl = gross - fees(effStop * remSize);
        return { pnl, outcome: pnl >= 0 ? "win" : "loss" };
      }
    }
    while (hit < n) {
      const tp = tps[hit]!;
      const tpHit = side === "long" ? k.h >= tp : k.l <= tp;
      if (!tpHit) break;
      banked += (tp - entry) * dir * frac * size;
      legNotional += tp * frac * size;
      hit++;
      if (beAfter > 0 && hit >= beAfter) effStop = entry; // move to break-even
    }
    if (n > 0 && hit >= n) {
      const pnl = banked - fees(0);
      return { pnl, outcome: pnl >= 0 ? "win" : "loss" };
    }
  }

  // Horizon end: mark the remainder out at the last close.
  const last = candles[candles.length - 1]!;
  const remFrac = Math.max(0, 1 - hit * frac);
  const remSize = remFrac * size;
  const gross = banked + (last.c - entry) * dir * remSize;
  const pnl = gross - fees(last.c * remSize);
  return { pnl, outcome: pnl >= 0 ? "win" : "loss" };
}

/**
 * Re-parse a channel's imported history with the current parser, then replay
 * each actionable signal against real Hyperliquid candles to estimate how the
 * channel would have performed. Uses the regex parser only (fast, no LLM cost).
 */
export async function backtestGroup(
  groupId: string,
  horizonDays = 14,
  interval = "1h",
): Promise<BacktestResult> {
  const empty: PerformanceStats = computeStats([]);
  const group = groupsRepo.get(groupId);
  if (!group) {
    return { groupId, groupName: "", reparsed: 0, tested: 0, skipped: 0, stats: empty, riskCounts: { green: 0, yellow: 0, red: 0 }, error: "group not found" };
  }

  const history = tradesRepo.forGroup(groupId);
  const sigs = signalsRepo.forGroup(groupId).filter((s) => s.status === "backfill");
  const riskCounts = { green: 0, yellow: 0, red: 0 };

  // 1) Re-parse (regex) + refresh risk on each backfill signal.
  interface Item {
    symbol: string;
    side: TradeSide;
    entry?: number;
    stop?: number;
    tps: number[];
    timeMs: number;
  }
  const items: Item[] = [];
  let reparsed = 0;
  for (const s of sigs) {
    const parsed = parseWithRegex(s.rawText);
    const risk = parsed ? assessRisk(group.settings, parsed, history) : undefined;
    signalsRepo.update(s.id, { parsed: parsed ?? undefined, risk });
    reparsed++;
    if (risk) riskCounts[risk.level as RiskLevel]++;
    if (!parsed) continue;
    if (parsed.stopLoss === undefined && !(parsed.takeProfits && parsed.takeProfits.length)) continue;
    items.push({
      symbol: parsed.symbol,
      side: parsed.side,
      entry: parsed.entry,
      stop: parsed.stopLoss,
      tps: parsed.takeProfits ?? [],
      timeMs: new Date(s.receivedAt).getTime(),
    });
  }

  // 2) Fetch candles per symbol covering all its signals + the horizon.
  const horizonMs = horizonDays * 86400_000;
  const bySymbol = new Map<string, Item[]>();
  for (const it of items) {
    const arr = bySymbol.get(it.symbol);
    if (arr) arr.push(it);
    else bySymbol.set(it.symbol, [it]);
  }
  const candlesFor = new Map<string, Candle[]>();
  for (const [symbol, list] of bySymbol) {
    const minT = Math.min(...list.map((i) => i.timeMs));
    const maxT = Math.max(...list.map((i) => i.timeMs));
    try {
      const c = await hyperliquid.getCandles(symbol, interval, minT, maxT + horizonMs);
      candlesFor.set(symbol, c.sort((a, b) => a.t - b.t));
    } catch (err) {
      log.warn(`backtest ${group.name}: no candles for ${symbol} — ${err instanceof Error ? err.message : err}`);
    }
  }

  // 3) Simulate each item; build synthetic closed trades for the stats.
  const synthetic: Trade[] = [];
  let skipped = 0;
  for (const it of items) {
    const candles = candlesFor.get(it.symbol);
    if (!candles || candles.length === 0) {
      skipped++;
      continue;
    }
    const window = candles.filter((k) => k.t >= it.timeMs && k.t <= it.timeMs + horizonMs);
    if (window.length === 0) {
      skipped++;
      continue;
    }
    const entry = it.entry && it.entry > 0 ? it.entry : window[0]!.o;
    const tps = expandTakeProfits(it.tps, entry, it.side, {
      autoSplit: group.settings.autoSplitSingleTp,
      levels: group.settings.tpLevels,
    });
    const size = group.settings.tradeSizeUsd / entry;
    const res = simulate(window, it.side, entry, it.stop, tps, size, group.settings.breakevenAfterTp);
    if (!res) {
      skipped++;
      continue;
    }
    synthetic.push({
      id: "",
      groupId,
      groupName: group.name,
      symbol: it.symbol,
      side: it.side,
      status: "closed",
      env: "paper",
      leverage: group.settings.leverage,
      notionalUsd: group.settings.tradeSizeUsd,
      size,
      entryPrice: entry,
      realizedPnl: res.pnl,
      openedAt: new Date(it.timeMs).toISOString(),
      closedAt: new Date(it.timeMs + horizonMs).toISOString(),
    });
  }

  log.info(`Backtest ${group.name}: reparsed ${reparsed}, tested ${synthetic.length}, skipped ${skipped}`);
  return {
    groupId,
    groupName: group.name,
    reparsed,
    tested: synthetic.length,
    skipped,
    stats: computeStats(synthetic),
    riskCounts,
  };
}
