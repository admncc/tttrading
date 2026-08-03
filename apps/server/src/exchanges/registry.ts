import type { ExchangeName } from "@tttrading/shared";
import { log } from "../logger.js";
import { hyperliquid } from "../hyperliquid/connector.js";
import { aster } from "./aster.js";
import { mexc } from "./mexc.js";
import { asterEnabled, exchangePriority, mexcEnabled } from "./credentials.js";
import type { AssetInfo, ExchangeConnector } from "./types.js";

const CONNECTORS: Record<string, ExchangeConnector> = { hyperliquid, aster, mexc };

/**
 * The venues we route across, in the operator-configured PRIORITY order (first =
 * tried first). A signal routes to the first venue that lists its symbol. A
 * backup participates only when enabled (desk toggle / env flag / API key).
 * Hyperliquid is always included (base venue); backups only when enabled.
 */
function enabledExchanges(): ExchangeConnector[] {
  const enabled: Record<string, boolean> = {
    hyperliquid: true,
    aster: asterEnabled(),
    mexc: mexcEnabled(),
  };
  const out: ExchangeConnector[] = [];
  for (const name of exchangePriority()) {
    const ex = CONNECTORS[name];
    if (ex && enabled[name] && !out.includes(ex)) out.push(ex);
  }
  // Safety: append any enabled venue missing from the priority list.
  for (const [name, ex] of Object.entries(CONNECTORS)) {
    if (enabled[name] && !out.includes(ex)) out.push(ex);
  }
  return out;
}

/** The primary venue for account panel / transfers / test orders (Hyperliquid). */
export const primary: ExchangeConnector = hyperliquid;

/** Look up a connector by its stored name; falls back to the primary. */
export function byName(name: ExchangeName | undefined): ExchangeConnector {
  if (name === "aster") return aster;
  if (name === "mexc") return mexc;
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
  return [hyperliquid, aster, mexc];
}

export type Resolution =
  | { kind: "found"; ex: ExchangeConnector; asset: AssetInfo }
  | { kind: "notFound"; tried: string[] }
  | { kind: "unavailable" };

export type MultiResolution =
  | { kind: "found"; venues: { ex: ExchangeConnector; asset: AssetInfo }[] }
  | { kind: "notFound"; tried: string[] }
  | { kind: "unavailable" };

/**
 * Like resolveForSymbol but returns EVERY enabled venue (priority order) that
 * lists the symbol — for conflict-aware routing (pick a venue with no opposing
 * position). Same primary-error safety: a throw from the primary is inconclusive.
 */
export async function resolveAllForSymbol(symbol: string): Promise<MultiResolution> {
  const chain = enabledExchanges();
  const venues: { ex: ExchangeConnector; asset: AssetInfo }[] = [];
  let anyErrored = false;
  for (let i = 0; i < chain.length; i++) {
    const ex = chain[i]!;
    try {
      const asset = await ex.getAsset(symbol);
      if (asset) venues.push({ ex, asset });
    } catch (err) {
      log.warn(`resolveAllForSymbol ${symbol} on ${ex.name}:`, err instanceof Error ? err.message : err);
      if (i === 0 && venues.length === 0) return { kind: "unavailable" };
      anyErrored = true;
    }
  }
  if (venues.length > 0) return { kind: "found", venues };
  if (anyErrored) return { kind: "unavailable" };
  return { kind: "notFound", tried: chain.map((e) => e.name) };
}

/**
 * Pick the venue for a symbol: the first enabled exchange (primary first) that
 * lists it. Returns `notFound` only when every venue answered and none listed
 * it, and `unavailable` when metadata couldn't be read anywhere (so the caller
 * can fall back to the primary rather than wrongly reporting "not listed").
 */
export async function resolveForSymbol(symbol: string): Promise<Resolution> {
  const chain = enabledExchanges();
  const tried: string[] = [];
  let backupErrored = false;
  for (let i = 0; i < chain.length; i++) {
    const ex = chain[i]!;
    try {
      const asset = await ex.getAsset(symbol);
      tried.push(ex.name);
      if (asset) return { kind: "found", ex, asset };
    } catch (err) {
      log.warn(`resolveForSymbol ${symbol} on ${ex.name}:`, err instanceof Error ? err.message : err);
      // The PRIMARY erroring is inconclusive: never fall through to a backup, or
      // an HL-listed symbol (BTC/ETH/…) could open on the wrong venue during a
      // transient HL outage. Return "unavailable" so the caller keeps the primary
      // and lets the order path surface the error.
      if (i === 0) return { kind: "unavailable" };
      // A backup erroring is also inconclusive — remember it so we don't falsely
      // report "not listed" when that backup might well have carried the symbol.
      backupErrored = true;
    }
  }
  if (backupErrored) return { kind: "unavailable" };
  return { kind: "notFound", tried };
}
