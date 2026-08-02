import type { Trade } from "@tttrading/shared";
import { config } from "../config.js";
import { log } from "../logger.js";
import { groups as groupsRepo, trades as tradesRepo } from "../db/repositories.js";
import type { FillLite } from "../hyperliquid/connector.js";
import { known as knownExchanges, byName } from "../exchanges/registry.js";
import type { ExchangeConnector } from "../exchanges/types.js";
import { closing, promoteWorkingToOpen, cancelWorkingTrade } from "./engine.js";
import { alertClosed } from "../alerts/notifier.js";
import { broadcast } from "../ws/hub.js";
import { pushStats } from "../stats/service.js";

let timer: ReturnType<typeof setInterval> | undefined;

/**
 * Reconcile our open trades with the exchange:
 *  - detect externally-filled SL/TP orders and close the trade with real PnL
 *  - move the stop-loss to break-even once the configured TP level has filled
 *
 * Stateless per tick and idempotent: closed trades are skipped next time, and
 * the break-even move is guarded by a flag on the trade.
 */
export async function reconcileOnce(): Promise<void> {
  // Reconcile each live venue against its own trades (a trade only reconciles on
  // the exchange it lives on). Simulated trades are handled by evaluateSimulated().
  for (const ex of knownExchanges().filter((e) => e.live)) {
    try {
      await reconcileExchange(ex);
    } catch (err) {
      log.error(`reconcile ${ex.name}:`, err instanceof Error ? err.message : err);
    }
  }
}

async function reconcileExchange(ex: ExchangeConnector): Promise<void> {
  const onThis = (t: Trade) => byName(t.exchange).name === ex.name;
  // Skip trades a manual close/partial is actively working on (race guard).
  const open = tradesRepo.open().filter((t) => !t.simulated && !closing.has(t.id) && onThis(t));
  const working = tradesRepo.working().filter((t) => !t.simulated && onThis(t));
  // Nothing to reconcile if there are neither open positions NOR working orders.
  if (open.length === 0 && working.length === 0) return;

  const symbols = [...new Set([...open, ...working].map((t) => t.symbol))];
  let fills: FillLite[];
  try {
    fills = await ex.getRecentFills(symbols);
  } catch (err) {
    log.warn(`reconcile ${ex.name}: fills unavailable —`, err instanceof Error ? err.message : err);
    return;
  }

  const byOid = new Map<string, FillLite[]>();
  for (const f of fills) {
    const arr = byOid.get(f.oid);
    if (arr) arr.push(f);
    else byOid.set(f.oid, [f]);
  }

  let changed = false;
  for (const trade of open) {
    try {
      if (await reconcileTrade(ex, trade, byOid)) changed = true;
    } catch (err) {
      log.error(`reconcile ${trade.symbol} (${trade.id}):`, err instanceof Error ? err.message : err);
    }
  }
  await reconcileWorking(ex, byOid, working);
  // MEXC: SL/TP fire as plan orders whose triggered fills carry a DIFFERENT order
  // id than the plan id we stored, so fill-matching (above) can't see the close.
  // Fall back to position state — if the position is flat, book the close.
  if (ex.name === "mexc" && open.length > 0) {
    try {
      if (await reconcileByPosition(ex, open, fills)) changed = true;
    } catch (err) {
      log.warn(`reconcile-by-position ${ex.name}:`, err instanceof Error ? err.message : err);
    }
  }
  if (changed) pushStats();
}

/**
 * Close trades whose exchange position has gone flat but which weren't caught by
 * fill-matching (used for MEXC, where SL/TP plan-order fills don't carry the
 * stored id). Only acts when the positions read SUCCEEDS — an empty list from a
 * failed/misconfigured read must not be mistaken for "everything closed", so any
 * error aborts. A grace period avoids closing a just-opened trade before its
 * position registers.
 */
async function reconcileByPosition(
  ex: ExchangeConnector,
  open: Trade[],
  fills: FillLite[],
): Promise<boolean> {
  const positions = await ex.getPositions(); // throws → caller skips (inconclusive)
  let changed = false;
  for (const t of open) {
    if (closing.has(t.id)) continue;
    const fresh = tradesRepo.get(t.id);
    if (!fresh || fresh.status !== "open" || fresh.simulated) continue;
    if (Date.now() - new Date(fresh.openedAt).getTime() < 60_000) continue; // grace
    const stillOpen = positions.some(
      (p) =>
        p.symbol.toUpperCase() === fresh.symbol.toUpperCase() &&
        p.size !== 0 &&
        (fresh.side === "long" ? p.size > 0 : p.size < 0),
    );
    if (stillOpen) continue;

    closing.add(fresh.id);
    try {
      const again = tradesRepo.get(fresh.id);
      if (!again || again.status !== "open") continue;
      const openedMs = new Date(again.openedAt).getTime();
      const symFills = fills.filter(
        (f) => f.symbol.toUpperCase() === again.symbol.toUpperCase() && f.time >= openedMs - 5000,
      );
      const grossPnl = symFills.reduce((s, f) => s + f.closedPnl, 0);
      const fee = symFills.reduce((s, f) => s + f.fee, 0);
      // Exit price: weighted avg of the close-side fills, else the live mid.
      const closeSide = again.side === "long" ? "A" : "B"; // closing a long sells
      const cf = symFills.filter((f) => f.side === closeSide && f.price > 0);
      let exit = again.entryPrice;
      if (cf.length) {
        const v = cf.reduce((s, f) => s + f.size, 0);
        if (v > 0) exit = cf.reduce((s, f) => s + f.price * f.size, 0) / v;
      } else {
        try {
          const mid = await ex.getMidPrice(again.symbol);
          if (mid && mid > 0) exit = mid;
        } catch {
          /* keep entry as the fallback */
        }
      }
      // Cancel any still-resting bracket legs so they can't fire on a later position.
      const restingIds = [again.slOrderId, ...(again.tpOrderIds ?? [])].filter((x): x is string => !!x);
      if (restingIds.length) await ex.cancelOrders(again.symbol, restingIds);

      const bankedPnl = again.bankedPnl ?? 0;
      const bankedFees = again.bankedFees ?? 0;
      const updated = tradesRepo.update(again.id, {
        status: "closed",
        exitPrice: exit,
        realizedPnl: bankedPnl - bankedFees + grossPnl - fee,
        fees: bankedFees + fee,
        closedAt: new Date().toISOString(),
      });
      if (updated) {
        broadcast({ type: "trade", trade: updated });
        alertClosed(updated);
        changed = true;
        log.info(
          `MEXC position flat → closed ${again.symbol} ${again.side} — PnL ${(bankedPnl - bankedFees + grossPnl - fee).toFixed(2)} USDC`,
        );
      }
    } finally {
      closing.delete(fresh.id);
    }
  }
  return changed;
}

/**
 * Live working (resting limit) orders: promote to a position when the entry
 * order fills, or cancel once the channel's limit timeout elapses.
 */
async function reconcileWorking(
  ex: ExchangeConnector,
  byOid: Map<string, FillLite[]>,
  working: Trade[],
): Promise<void> {
  if (working.length === 0) return;
  // Resting order ids still open on the exchange (best-effort; empty on error).
  let openOids: Set<string> | undefined;
  try {
    openOids = await ex.getOpenOrderIds();
  } catch {
    openOids = undefined;
  }

  for (const t of working) {
    if (closing.has(t.id)) continue;
    try {
      const fills = t.exchangeOrderId ? byOid.get(t.exchangeOrderId) ?? [] : [];
      const size = fills.reduce((s, f) => s + f.size, 0);
      // Promote only once the cumulative fill covers (nearly) the full order —
      // a partial fill would otherwise orphan the unfilled remainder.
      if (size >= t.size * 0.999 && size > 0) {
        const notional = fills.reduce((s, f) => s + f.price * f.size, 0);
        await promoteWorkingToOpen(t.id, notional / size, size);
        continue;
      }

      // Timeout: 0 (or negative) means "never expire".
      const timeoutH = groupsRepo.get(t.groupId)?.settings.limitTimeoutHours ?? 168;
      const expired = timeoutH > 0 && Date.now() - new Date(t.openedAt).getTime() > timeoutH * 3_600_000;

      // If the order is no longer resting on the exchange but we saw no fill in
      // the recent window (e.g. it filled during downtime), cross-check the
      // account's positions and promote from there instead of orphaning it.
      if (openOids && t.exchangeOrderId && !openOids.has(t.exchangeOrderId)) {
        try {
          const positions = await ex.getPositions();
          const pos = positions.find(
            (p) => p.symbol.toUpperCase() === t.symbol.toUpperCase() && p.size !== 0 &&
              (t.side === "long" ? p.size > 0 : p.size < 0),
          );
          if (pos) {
            await promoteWorkingToOpen(t.id, pos.entryPrice || t.entryPrice, Math.abs(pos.size));
            continue;
          }
        } catch {
          /* positions unavailable — fall through */
        }
        // Not resting and no matching position → the order is truly gone.
        if (size > 0) {
          const notional = fills.reduce((s, f) => s + f.price * f.size, 0);
          await promoteWorkingToOpen(t.id, notional / size, size);
        } else if (expired) {
          await cancelWorkingTrade(t.id, `limit expired (not resting, no position)`);
        }
        continue;
      }

      if (expired) await cancelWorkingTrade(t.id, `limit timeout (${timeoutH}h)`);
    } catch (err) {
      log.error(`working ${t.symbol} (${t.id}):`, err instanceof Error ? err.message : err);
    }
  }
}

async function reconcileTrade(
  ex: ExchangeConnector,
  trade: Trade,
  byOid: Map<string, FillLite[]>,
): Promise<boolean> {
  const tpOids = trade.tpOrderIds ?? [];
  const slOids = [trade.slOrderId].filter((x): x is string => !!x);
  const closingOids = [...tpOids, ...slOids];
  if (closingOids.length === 0) return false; // nothing on-exchange to watch

  const tradeFills = closingOids.flatMap((o) => byOid.get(o) ?? []);
  if (tradeFills.length === 0) return false;

  const closedSize = tradeFills.reduce((s, f) => s + f.size, 0);
  const grossPnl = tradeFills.reduce((s, f) => s + f.closedPnl, 0);
  const fees = tradeFills.reduce((s, f) => s + f.fee, 0);

  // Count a TP level as filled only when its cumulative fill meets that level's
  // expected allocation (a single partial fill must not count the whole level).
  const n = tpOids.length;
  const perTpExpected = n > 0 ? trade.size / n : 0;
  const tpFilled = tpOids.filter((o) => {
    const filled = (byOid.get(o) ?? []).reduce((s, f) => s + f.size, 0);
    return perTpExpected > 0 ? filled >= perTpExpected * 0.9 : filled > 0;
  }).length;

  // 1) Fully closed on the exchange? (checked first, so a closing tick never
  //    also tries to move the stop for a flat position).
  const fullyClosed = closedSize >= trade.size * 0.999;
  if (fullyClosed) {
    // Re-check status right before the terminal write — a manual close may have
    // resolved it while we awaited fills.
    const fresh = tradesRepo.get(trade.id);
    if (!fresh || fresh.status !== "open" || closing.has(trade.id)) return false;
    // A partialClose may have landed since we captured `trade`; only proceed if
    // the fills actually cover the CURRENT remaining size, and bank from fresh.
    if (closedSize < fresh.size * 0.999) return false;
    const notional = tradeFills.reduce((s, f) => s + f.price * f.size, 0);
    const exitPrice = closedSize > 0 ? notional / closedSize : fresh.entryPrice;
    // Fold in profit/fees banked from earlier partial exits ("book X%").
    const bankedPnl = fresh.bankedPnl ?? 0;
    const bankedFees = fresh.bankedFees ?? 0;
    const updated = tradesRepo.update(trade.id, {
      status: "closed",
      exitPrice,
      realizedPnl: bankedPnl - bankedFees + grossPnl - fees,
      fees: bankedFees + fees,
      tpFilledCount: tpFilled,
      closedAt: new Date().toISOString(),
    });
    if (updated) {
      broadcast({ type: "trade", trade: updated });
      alertClosed(updated);
      log.info(
        `Reconciled close ${trade.symbol} ${trade.side} — PnL ${(bankedPnl - bankedFees + grossPnl - fees).toFixed(2)} USDC ` +
          `(${tpFilled}/${tpOids.length} TP)`,
      );
    }
    return true;
  }

  let changed = false;

  // 2) Move stop-loss to break-even once enough TP levels have filled.
  const group = groupsRepo.get(trade.groupId);
  const beAfter = group?.settings.breakevenAfterTp ?? 0;
  if (beAfter > 0 && tpFilled >= beAfter && !trade.slMovedToBreakeven && trade.slOrderId) {
    await moveSlToBreakeven(ex, trade, closedSize, group?.settings.maxSlippage ?? 0.01);
    changed = true;
  }

  // 3) Partial progress — surface the TP count in the desk.
  if (tpFilled !== (trade.tpFilledCount ?? 0)) {
    const updated = tradesRepo.update(trade.id, { tpFilledCount: tpFilled });
    if (updated) broadcast({ type: "trade", trade: updated });
    changed = true;
  }
  return changed;
}

async function moveSlToBreakeven(
  ex: ExchangeConnector,
  trade: Trade,
  filledSize: number,
  slippage: number,
): Promise<void> {
  const remaining = Math.max(0, trade.size - filledSize);
  if (remaining <= 0) return;

  // Place the new break-even stop FIRST, then cancel the old one — never leave
  // the position without a resting stop if placement fails.
  const res = await ex.placeBracketOrders({
    symbol: trade.symbol,
    side: trade.side,
    size: remaining,
    stopLoss: trade.entryPrice, // break-even
    takeProfits: [],
    slippage,
    marginMode: groupsRepo.get(trade.groupId)?.settings.marginMode,
    force: true, // real position — place even when the global test switch is on
  });
  if (!res.protectedOnExchange || !res.slOrderId) {
    log.warn(
      `Break-even stop placement failed for ${trade.symbol} (${res.error ?? "no id"}); keeping existing SL.`,
    );
    return;
  }
  if (trade.slOrderId) await ex.cancelOrders(trade.symbol, [trade.slOrderId]);
  const updated = tradesRepo.update(trade.id, {
    slOrderId: res.slOrderId,
    slMovedToBreakeven: true,
  });
  if (updated) broadcast({ type: "trade", trade: updated });
  log.info(`Moved SL to break-even (${trade.entryPrice}) for ${trade.symbol} — ${remaining} left`);
}

/**
 * Resolve all simulated open trades against the live price — both shadow trades
 * (blocked reds) and normal trades placed in shadow/test mode. Mirrors the real
 * management rules (TP scale-out + break-even after TP N), so the full lifecycle
 * plays out without touching the exchange.
 */
export async function evaluateSimulated(): Promise<void> {
  await evaluateWorkingSim();
  const sims = tradesRepo
    .open()
    .filter((t) => (t.simulated || t.shadow) && !closing.has(t.id));
  if (sims.length === 0) return;
  let changed = false;
  for (const trade of sims) {
    try {
      if (await evaluateSimulatedTrade(trade)) changed = true;
    } catch (err) {
      log.error(`sim eval ${trade.symbol}:`, err instanceof Error ? err.message : err);
    }
  }
  if (changed) pushStats();
}

/** Simulated working (resting limit) orders: fill when the mid crosses the
 *  limit, or cancel after the channel's timeout. */
async function evaluateWorkingSim(): Promise<void> {
  const working = tradesRepo.working().filter((t) => t.simulated);
  for (const t of working) {
    if (closing.has(t.id)) continue;
    try {
      const timeoutH = groupsRepo.get(t.groupId)?.settings.limitTimeoutHours ?? 168;
      if (timeoutH > 0 && Date.now() - new Date(t.openedAt).getTime() > timeoutH * 3_600_000) {
        await cancelWorkingTrade(t.id, `limit timeout (${timeoutH}h)`);
        continue;
      }
      const mid = await byName(t.exchange).getMidPrice(t.symbol);
      if (!mid || mid <= 0) continue;
      const crossed = t.side === "long" ? mid <= t.entryPrice : mid >= t.entryPrice;
      if (crossed) await promoteWorkingToOpen(t.id, t.entryPrice, t.size);
    } catch (err) {
      log.error(`working-sim ${t.symbol}:`, err instanceof Error ? err.message : err);
    }
  }
}

async function evaluateSimulatedTrade(trade: Trade): Promise<boolean> {
  const mid = await byName(trade.exchange).getMidPrice(trade.symbol);
  if (!mid || mid <= 0) return false;

  const dir = trade.side === "long" ? 1 : -1;
  const entry = trade.entryPrice;
  const tps = trade.takeProfits ?? [];
  const n = tps.length;
  const fraction = n > 0 ? 1 / n : 0;

  // How many TP levels the price has reached so far.
  const hitTps = tps.filter((tp) => (trade.side === "long" ? mid >= tp : mid <= tp)).length;

  const group = groupsRepo.get(trade.groupId);
  const beAfter = group?.settings.breakevenAfterTp ?? 0;
  const stopPrice = beAfter > 0 && hitTps >= beAfter ? entry : trade.stopLoss;
  const stopHit =
    stopPrice !== undefined && (trade.side === "long" ? mid <= stopPrice : mid >= stopPrice);
  const allTpsHit = n > 0 && hitTps >= n;

  if (!allTpsHit && !stopHit) {
    // Not resolved yet — surface TP progress if it advanced.
    if (hitTps !== (trade.tpFilledCount ?? 0)) {
      const updated = tradesRepo.update(trade.id, { tpFilledCount: hitTps });
      if (updated) broadcast({ type: "trade", trade: updated });
      return true;
    }
    return false;
  }

  // Resolve: realized profit from hit TPs + remainder at the stop (or final TP).
  let gross = 0;
  for (let i = 0; i < hitTps; i++) gross += (tps[i]! - entry) * dir * fraction * trade.size;
  let exitPrice: number;
  if (allTpsHit) {
    exitPrice = tps[n - 1]!;
  } else {
    const remainingFraction = Math.max(0, 1 - hitTps * fraction);
    gross += (stopPrice! - entry) * dir * remainingFraction * trade.size;
    exitPrice = stopPrice!;
  }
  // Fee on the REMAINING size only (round-trip); the partially-closed portion
  // already had its fee banked in bankedFees — avoid double-charging it.
  const fees = trade.size * entry * 0.0007;
  // Fold in profit/fees banked from earlier partial exits ("book X%").
  const bankedPnl = trade.bankedPnl ?? 0;
  const bankedFees = trade.bankedFees ?? 0;
  const realizedPnl = bankedPnl - bankedFees + gross - fees;

  // Re-check status before the terminal write (a manual close may have won).
  const fresh = tradesRepo.get(trade.id);
  if (!fresh || fresh.status !== "open" || closing.has(trade.id)) return false;

  const updated = tradesRepo.update(trade.id, {
    status: "closed",
    exitPrice,
    realizedPnl,
    fees: bankedFees + fees,
    tpFilledCount: hitTps,
    closedAt: new Date().toISOString(),
  });
  if (updated) {
    broadcast({ type: "trade", trade: updated });
    if (trade.shadow) {
      log.info(
        `Shadow resolved ${trade.symbol} ${trade.side} — would ${realizedPnl >= 0 ? "WIN" : "LOSE"} ` +
          `${realizedPnl.toFixed(2)} USDC (block ${realizedPnl >= 0 ? "cost us" : "saved us"})`,
      );
    } else {
      alertClosed(updated);
      log.info(
        `Simulated close ${trade.symbol} ${trade.side} — PnL ${realizedPnl.toFixed(2)} USDC ` +
          `(${hitTps}/${tps.length} TP)`,
      );
    }
  }
  return true;
}

/** Start the periodic monitor loop: reconcile live trades + evaluate shadows. */
export function startMonitor(): void {
  const interval = config.monitorIntervalMs;
  const what = knownExchanges().some((e) => e.live) ? "reconcile + simulated eval" : "simulated eval";
  log.info(`Monitor running every ${Math.round(interval / 1000)}s (${what}).`);
  let ticking = false;
  timer = setInterval(() => {
    if (ticking) return; // skip if the previous tick is still running
    ticking = true;
    void (async () => {
      try {
        await reconcileOnce();
        await evaluateSimulated();
      } catch (err) {
        log.error("monitor tick:", err instanceof Error ? err.message : err);
      } finally {
        ticking = false;
      }
    })();
  }, interval);
}

export function stopMonitor(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
