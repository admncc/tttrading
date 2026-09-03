/**
 * OKX public market-stats client (Phase 2.2). Read-only, best-effort: returns []
 * on any error or timeout so it never blocks the observe-only feature path. OKX
 * is used because Binance/Bybit geo-block this deployment; the metric (crowd
 * long/short account ratio + OI) is the same.
 */
import { log } from "../logger.js";

const BASE = "https://www.okx.com/api/v5/rubik/stat/contracts";
const TIMEOUT_MS = 6000;

/** OKX uses the base currency ("BTC","SOL","PEPE"); strip a k-prefix meme form. */
function toCcy(symbol: string): string {
  const s = symbol.toUpperCase();
  return s.startsWith("K") && s.length > 3 ? s.slice(1) : s;
}

async function getJson(url: string): Promise<unknown[] | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { code?: string; data?: unknown[] };
    if (body.code !== "0" || !Array.isArray(body.data)) return undefined;
    return body.data;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Long/short ACCOUNT ratio history (newest first): [{time, ratio}]. */
export async function getLongShortRatio(symbol: string, period = "1H", limit = 48): Promise<{ time: number; ratio: number }[]> {
  const data = await getJson(`${BASE}/long-short-account-ratio?ccy=${toCcy(symbol)}&period=${period}&limit=${limit}`);
  if (!data) {
    log.warn(`okx long/short ratio unavailable for ${symbol}`);
    return [];
  }
  return (data as [string, string][])
    .map(([t, r]) => ({ time: Number(t), ratio: Number(r) }))
    .filter((x) => Number.isFinite(x.time) && Number.isFinite(x.ratio));
}

/** Open-interest + volume history (newest first): [{time, oi, vol}]. */
export async function getOpenInterestHistory(symbol: string, period = "1H", limit = 48): Promise<{ time: number; oi: number; vol: number }[]> {
  const data = await getJson(`${BASE}/open-interest-volume?ccy=${toCcy(symbol)}&period=${period}&limit=${limit}`);
  if (!data) return [];
  return (data as [string, string, string][])
    .map(([t, oi, vol]) => ({ time: Number(t), oi: Number(oi), vol: Number(vol) }))
    .filter((x) => Number.isFinite(x.time) && Number.isFinite(x.oi));
}
