import type { ExchangeName } from "@tttrading/shared";
import { config } from "../config.js";
import { log } from "../logger.js";
import { hyperliquid } from "../hyperliquid/connector.js";
import { aster } from "./aster.js";
import type { AssetInfo, ExchangeConnector } from "./types.js";

/**
 * The venues we route across, in PRIORITY order. Hyperliquid is always the
 * primary; a backup only ever catches symbols the primary doesn't list. A
 * backup participates only when it's enabled (env flag or an API key present).
 */
function enabledExchanges(): ExchangeConnector[] {
  const list: ExchangeConnector[] = [hyperliquid];
  if (config.aster.enabled) list.push(aster);
  return list;
}

/** The primary venue — the default for reads, account panels and test orders. */
export const primary: ExchangeConnector = hyperliquid;

/** Look up a connector by its stored name; falls back to the primary. */
export function byName(name: ExchangeName | undefined): ExchangeConnector {
  if (name === "aster") return aster;
  return hyperliquid;
}

/** All venues currently in the routing chain (primary first). */
export function all(): ExchangeConnector[] {
  return enabledExchanges();
}

/**
 * Every connector the process knows about, regardless of whether it currently
 * participates in routing. The monitor uses this so a venue that still holds a
 * live position keeps reconciling even after it's been removed from routing.
 */
export function known(): ExchangeConnector[] {
  return [hyperliquid, aster];
}

export type Resolution =
  | { kind: "found"; ex: ExchangeConnector; asset: AssetInfo }
  | { kind: "notFound"; tried: string[] }
  | { kind: "unavailable" };

/**
 * Pick the venue for a symbol: the first enabled exchange (primary first) that
 * lists it. Returns `notFound` only when every venue answered and none listed
 * it, and `unavailable` when metadata couldn't be read anywhere (so the caller
 * can fall back to the primary rather than wrongly reporting "not listed").
 */
export async function resolveForSymbol(symbol: string): Promise<Resolution> {
  const tried: string[] = [];
  let anyErrored = false;
  for (const ex of enabledExchanges()) {
    try {
      const asset = await ex.getAsset(symbol);
      tried.push(ex.name);
      if (asset) return { kind: "found", ex, asset };
    } catch (err) {
      anyErrored = true;
      log.warn(`resolveForSymbol ${symbol} on ${ex.name}:`, err instanceof Error ? err.message : err);
    }
  }
  // A transient metadata error anywhere (with no positive hit) is inconclusive —
  // don't wrongly report "not listed"; let the caller fall back to the primary.
  if (anyErrored) return { kind: "unavailable" };
  return { kind: "notFound", tried };
}
