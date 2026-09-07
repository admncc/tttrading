/**
 * Sizing-price sanity gate.
 *
 * A market order's size is `notionalUsd / mid`, so a corrupt or stale mid — a bad
 * tick, a freshly listed pair whose feed hasn't settled, an asset-index mix-up —
 * silently mis-sizes the position by orders of magnitude. A real case: a mid of
 * ~32.6 for a $0.55 coin opened ~1/60th of the intended notional.
 *
 * When the caller can supply the signal's stated entry as a reference, we compare
 * the live mid against it. A transient bad tick self-heals, so rather than abort on
 * the first bad read we RE-READ the price a couple of times (waiting a tick): if the
 * fresh mid agrees with the entry we size against that corrected price; only a
 * *persistent* gross deviation fails the order closed, so we never size against a
 * price the feed itself won't confirm.
 */

/** Max fractional deviation between the live sizing mid and the stated entry. */
export const MID_REF_MAX_DEVIATION = 0.2;
/** How many times to re-read the mid when the first read looks corrupt. */
export const MID_REF_RECHECK_TRIES = 2;
/** Wait between re-reads, so the upstream feed has a tick to correct itself. */
export const MID_REF_RECHECK_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when `mid` deviates from `refPrice` beyond the allowed band. */
export function midDeviatesFromRef(
  mid: number,
  refPrice: number,
  max: number = MID_REF_MAX_DEVIATION,
): boolean {
  if (!(refPrice > 0) || !(mid > 0)) return false;
  return Math.abs(mid - refPrice) / refPrice > max;
}

/** Max fraction the notional an order actually represents may differ from the
 *  configured order size before it's treated as a mis-size. Generous, so lot-size
 *  rounding and entry-vs-fill slippage never trip it — only gross errors do. */
export const NOTIONAL_MAX_OFF = 0.5;

/**
 * Fractional gap between the notional a `(size, price)` pair represents and the
 * intended order size. Used as a last gate right before an order is sent — value
 * the computed size at a TRUSTED price (the signal entry, or the confirmed fill)
 * and confirm it matches what was configured (e.g. ~2000 USDC). Returns undefined
 * when any input is non-positive (nothing to compare).
 */
export function notionalOffFraction(
  size: number,
  price: number,
  intendedNotional: number,
): number | undefined {
  if (!(intendedNotional > 0) || !(size > 0) || !(price > 0)) return undefined;
  return Math.abs(size * price - intendedNotional) / intendedNotional;
}

export type SizingMid = { mid: number } | { error: string };

/**
 * Resolve the mid to size an order against.
 *
 * - No reference price (unknown entry) → accept the initial mid as-is; we have
 *   nothing to sanity-check it against.
 * - Initial mid within band of the reference → accept it.
 * - Initial mid grossly off → re-read up to `tries` times (waiting `delayMs`
 *   between reads). The first re-read that lands within band wins — a transient
 *   bad tick is corrected and we size against the fresh price. If every re-read
 *   still deviates (or can't be read), return an error so the caller fails closed.
 */
export async function resolveSizingMid(
  refPrice: number | undefined,
  initialMid: number,
  reReadMid: () => Promise<number | undefined>,
  opts?: { tries?: number; delayMs?: number; max?: number; sleepFn?: (ms: number) => Promise<unknown> },
): Promise<SizingMid> {
  const max = opts?.max ?? MID_REF_MAX_DEVIATION;
  if (!refPrice || refPrice <= 0 || !midDeviatesFromRef(initialMid, refPrice, max)) {
    return { mid: initialMid };
  }
  const tries = opts?.tries ?? MID_REF_RECHECK_TRIES;
  const delayMs = opts?.delayMs ?? MID_REF_RECHECK_MS;
  const wait = opts?.sleepFn ?? sleep;
  let lastMid = initialMid;
  for (let i = 0; i < tries; i++) {
    await wait(delayMs);
    const fresh = await reReadMid().catch(() => undefined);
    if (fresh && fresh > 0) {
      lastMid = fresh;
      if (!midDeviatesFromRef(fresh, refPrice, max)) return { mid: fresh };
    }
  }
  const devPct = ((Math.abs(lastMid - refPrice) / refPrice) * 100).toFixed(0);
  return {
    error: `sizing price sanity: mid ${lastMid} still deviates ${devPct}% from signal entry ${refPrice} (max ${(max * 100).toFixed(0)}%) after ${tries} re-reads — refusing to size, likely a persistent bad price`,
  };
}
