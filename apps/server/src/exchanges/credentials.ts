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

/* ------------------------------ Hyperliquid ---------------------------- */
export function hlPrivateKey(): string {
  return settings.getExchangeValue("hl.privateKey") || config.hyperliquid.privateKey;
}
export function hlAccountAddress(): string {
  return settings.getExchangeValue("hl.accountAddress") || config.hyperliquid.accountAddress;
}
/** Hyperliquid can sign & send real orders (key present, not paper mode). */
export function hlReady(): boolean {
  return !config.isPaper && !!hlPrivateKey();
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
