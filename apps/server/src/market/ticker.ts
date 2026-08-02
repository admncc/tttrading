import { config } from "../config.js";
import { log } from "../logger.js";
import { trades as tradesRepo } from "../db/repositories.js";
import { hyperliquid } from "../hyperliquid/connector.js";
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
    const symbols = new Set(
      tradesRepo.open().filter((t) => !t.shadow).map((t) => t.symbol.toUpperCase()),
    );
    if (symbols.size === 0) {
      if (Object.keys(latest).length) {
        latest = {};
        broadcast({ type: "prices", prices: latest });
      }
      return;
    }
    const all = await hyperliquid.getAllMids();
    const prices: Record<string, number> = {};
    for (const s of symbols) if (all[s] !== undefined) prices[s] = all[s]!;
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
