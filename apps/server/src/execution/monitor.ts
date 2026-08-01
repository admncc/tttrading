import type { Trade } from "@tttrading/shared";
import { config } from "../config.js";
import { log } from "../logger.js";
import { groups as groupsRepo, trades as tradesRepo } from "../db/repositories.js";
import { hyperliquid, type FillLite } from "../hyperliquid/connector.js";
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
  if (!hyperliquid.live) return;
  const open = tradesRepo.open();
  if (open.length === 0) return;

  let fills: FillLite[];
  try {
    fills = await hyperliquid.getRecentFills();
  } catch (err) {
    log.warn("reconcile: fills unavailable —", err instanceof Error ? err.message : err);
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
      if (await reconcileTrade(trade, byOid)) changed = true;
    } catch (err) {
      log.error(`reconcile ${trade.symbol} (${trade.id}):`, err instanceof Error ? err.message : err);
    }
  }
  if (changed) pushStats();
}

async function reconcileTrade(trade: Trade, byOid: Map<string, FillLite[]>): Promise<boolean> {
  const tpOids = trade.tpOrderIds ?? [];
  const slOids = [trade.slOrderId].filter((x): x is string => !!x);
  const closingOids = [...tpOids, ...slOids];
  if (closingOids.length === 0) return false; // nothing on-exchange to watch

  const tradeFills = closingOids.flatMap((o) => byOid.get(o) ?? []);
  if (tradeFills.length === 0) return false;

  const closedSize = tradeFills.reduce((s, f) => s + f.size, 0);
  const grossPnl = tradeFills.reduce((s, f) => s + f.closedPnl, 0);
  const fees = tradeFills.reduce((s, f) => s + f.fee, 0);
  const tpFilled = tpOids.filter((o) => (byOid.get(o)?.length ?? 0) > 0).length;

  let changed = false;

  // 1) Move stop-loss to break-even once enough TP levels have filled.
  const group = groupsRepo.get(trade.groupId);
  const beAfter = group?.settings.breakevenAfterTp ?? 0;
  if (beAfter > 0 && tpFilled >= beAfter && !trade.slMovedToBreakeven && trade.slOrderId) {
    await moveSlToBreakeven(trade, closedSize, group?.settings.maxSlippage ?? 0.01);
    changed = true;
  }

  // 2) Fully closed on the exchange?
  const fullyClosed = closedSize >= trade.size * 0.999;
  if (fullyClosed) {
    const notional = tradeFills.reduce((s, f) => s + f.price * f.size, 0);
    const exitPrice = closedSize > 0 ? notional / closedSize : trade.entryPrice;
    const updated = tradesRepo.update(trade.id, {
      status: "closed",
      exitPrice,
      realizedPnl: grossPnl - fees,
      fees,
      tpFilledCount: tpFilled,
      closedAt: new Date().toISOString(),
    });
    if (updated) {
      broadcast({ type: "trade", trade: updated });
      log.info(
        `Reconciled close ${trade.symbol} ${trade.side} — PnL ${(grossPnl - fees).toFixed(2)} USDC ` +
          `(${tpFilled}/${tpOids.length} TP)`,
      );
    }
    return true;
  }

  // 3) Partial progress — surface the TP count in the desk.
  if (tpFilled !== (trade.tpFilledCount ?? 0)) {
    const updated = tradesRepo.update(trade.id, { tpFilledCount: tpFilled });
    if (updated) broadcast({ type: "trade", trade: updated });
    changed = true;
  }
  return changed;
}

async function moveSlToBreakeven(trade: Trade, filledSize: number, slippage: number): Promise<void> {
  const remaining = Math.max(0, trade.size - filledSize);
  if (remaining <= 0) return;

  if (trade.slOrderId) await hyperliquid.cancelOrders(trade.symbol, [trade.slOrderId]);
  const res = await hyperliquid.placeBracketOrders({
    symbol: trade.symbol,
    side: trade.side,
    size: remaining,
    stopLoss: trade.entryPrice, // break-even
    takeProfits: [],
    slippage,
  });
  const updated = tradesRepo.update(trade.id, {
    slOrderId: res.slOrderId,
    slMovedToBreakeven: true,
  });
  if (updated) broadcast({ type: "trade", trade: updated });
  log.info(`Moved SL to break-even (${trade.entryPrice}) for ${trade.symbol} — ${remaining} left`);
}

/** Start the periodic reconciliation loop (no-op unless trading live). */
export function startMonitor(): void {
  if (!hyperliquid.live) {
    log.info("Reconciliation monitor idle (not trading live).");
    return;
  }
  const interval = config.monitorIntervalMs;
  log.info(`Reconciliation monitor running every ${Math.round(interval / 1000)}s.`);
  timer = setInterval(() => void reconcileOnce(), interval);
}

export function stopMonitor(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
