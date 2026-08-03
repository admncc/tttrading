import { config } from "../config.js";
import { settings } from "../db/repositories.js";

/**
 * Effective exchange credentials: a value entered in the desk (Settings →
 * Exchanges, stored in the DB) takes precedence over the corresponding env var.
 * Secrets are only ever read here and by the connectors — never returned to the
 * client. Clearing a desk value (empty string) falls back to the env var.
 *
 * These are read at the point of use, so Aster/MEXC pick up new keys without a
 * restart; the Hyperliquid connector rebuilds its signer when its key changes.
 */

/** Venue routing priority order (names), first = tried first. */
export function exchangePriority(): string[] {
  return settings.getExchangePriority();
}

/* ------------------------------ Hyperliquid ---------------------------- */
export type HlNetwork = "testnet" | "mainnet";

export function hlPrivateKey(net: HlNetwork): string {
  const desk = settings.getExchangeValue(`hl.${net}.privateKey`);
  if (desk) return desk;
  // Legacy single desk key mapped to the TRADING_ENV network (backward compat).
  if (config.tradingEnv === net) {
    const legacy = settings.getExchangeValue("hl.privateKey");
    if (legacy) return legacy;
  }
  return config.hyperliquid[net].privateKey;
}
export function hlAccountAddress(net: HlNetwork): string {
  const desk = settings.getExchangeValue(`hl.${net}.accountAddress`);
  if (desk) return desk;
  if (config.tradingEnv === net) {
    const legacy = settings.getExchangeValue("hl.accountAddress");
    if (legacy) return legacy;
  }
  return config.hyperliquid[net].accountAddress;
}
/** A Hyperliquid network can sign & send real orders (key present, not paper). */
export function hlReady(net: HlNetwork): boolean {
  return !config.isPaper && !!hlPrivateKey(net);
}
/**
 * Whether a Hyperliquid network participates in routing. An explicit desk toggle
 * wins; otherwise the TRADING_ENV network is on by default and the other only
 * when it has a key (so adding a mainnet key auto-enables mainnet).
 */
export function hlEnabled(net: HlNetwork): boolean {
  const v = settings.getExchangeFlag(`hl.${net}.enabled`);
  if (v !== undefined) return v;
  if (config.tradingEnv === net) return true;
  // Paper mode isn't tied to a network — keep mainnet on as the market-data /
  // simulation venue so routing always has somewhere to go.
  if (config.isPaper && net === "mainnet") return true;
  return !!hlPrivateKey(net);
}

/* --------------------------------- Aster ------------------------------- */
export function asterEnabled(): boolean {
  // An explicit desk toggle wins (so it can be turned OFF even with a key set);
  // only auto-enable from env/key presence when the desk hasn't set it.
  const v = settings.getExchangeFlag("aster.enabled");
  return v === undefined ? config.aster.enabled || !!asterApiKey() : v;
}
export function asterApiKey(): string {
  return settings.getExchangeValue("aster.apiKey") || config.aster.apiKey;
}
export function asterApiSecret(): string {
  return settings.getExchangeValue("aster.apiSecret") || config.aster.apiSecret;
}
export function asterBaseUrl(): string {
  return (settings.getExchangeValue("aster.baseUrl") || config.aster.baseUrl).replace(/\/+$/, "");
}
export function asterReady(): boolean {
  return !config.isPaper && !!asterApiKey() && !!asterApiSecret();
}

/* --------------------------------- MEXC -------------------------------- */
export function mexcEnabled(): boolean {
  // Explicit desk toggle wins; only auto-enable from env/key when unset.
  const v = settings.getExchangeFlag("mexc.enabled");
  return v === undefined ? config.mexc.enabled || !!mexcApiKey() : v;
}
export function mexcApiKey(): string {
  return settings.getExchangeValue("mexc.apiKey") || config.mexc.apiKey;
}
export function mexcApiSecret(): string {
  return settings.getExchangeValue("mexc.apiSecret") || config.mexc.apiSecret;
}
export function mexcBaseUrl(): string {
  return (settings.getExchangeValue("mexc.baseUrl") || config.mexc.baseUrl).replace(/\/+$/, "");
}
export function mexcReady(): boolean {
  return !config.isPaper && !!mexcApiKey() && !!mexcApiSecret();
}
