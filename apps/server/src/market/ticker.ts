import { config } from "../config.js";
import { log } from "../logger.js";
import { trades as tradesRepo } from "../db/repositories.js";
import { known as knownExchanges, byName } from "../exchanges/registry.js";
import { broadcast } from "../ws/hub.js";

let timer: ReturnType<typeof setInterval> | undefined;
let ticking = false;
/** Latest mark prices for symbols we hold, symbol -> price. */
let latest: Record<string, number> = {};

/** Prices last broadcast (for late-joining clients via GET /api/prices). */
export function getPrices(): Record<string, number> {
  return latest;
}

/**
 * Fetch mark prices for every open (non-shadow) trade's symbol and broadcast
 * them so the desk can show live unrealized PnL. One allMids call covers all
 * symbols. No-op when nothing is open.
 */
export async function refreshPrices(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const openTrades = tradesRepo.open().filter((t) => !t.shadow);
    if (openTrades.length === 0) {
      if (Object.keys(latest).length) {
        latest = {};
        broadcast({ type: "prices", prices: latest });
      }
      return;
    }
    // Group the symbols we hold by the venue they trade on, then pull each
    // venue's marks once and merge (backups only hold HL-missing symbols, so
    // there's no cross-venue key collision in practice).
    const byExchange = new Map<string, Set<string>>();
    for (const t of openTrades) {
      const name = byName(t.exchange).name;
      const set = byExchange.get(name) ?? new Set<string>();
      set.add(t.symbol.toUpperCase());
      byExchange.set(name, set);
    }
    const prices: Record<string, number> = {};
    for (const ex of knownExchanges()) {
      const want = byExchange.get(ex.name);
      if (!want || want.size === 0) continue;
      try {
        const mids = await ex.getAllMids();
        for (const s of want) if (mids[s] !== undefined) prices[s] = mids[s]!;
      } catch (err) {
        log.warn(`price ticker (${ex.name}):`, err instanceof Error ? err.message : err);
      }
    }
    latest = prices;
    broadcast({ type: "prices", prices });
  } catch (err) {
    log.warn("price ticker:", err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
  }
}

/** Start the periodic price ticker (marks for open trades). */
export function startPriceTicker(): void {
  if (timer) return;
  const interval = config.priceTickerMs;
  void refreshPrices(); // immediate first tick so the desk isn't blank
  timer = setInterval(() => void refreshPrices(), interval);
  log.info(`Price ticker every ${Math.round(interval / 1000)}s (open-trade marks).`);
}

export function stopPriceTicker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
