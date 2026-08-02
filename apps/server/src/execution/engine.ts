import type { Group, ParsedSignal, RiskRating, Signal } from "@tttrading/shared";
import { config } from "../config.js";
import { log } from "../logger.js";
import { groups as groupsRepo, signals as signalsRepo, trades as tradesRepo } from "../db/repositories.js";
import { hyperliquid } from "../hyperliquid/connector.js";
import { parseSignal } from "../signals/parser.js";
import { expandTakeProfits } from "../signals/takeprofit.js";
import { assessRisk } from "../risk/score.js";
import { alertBlocked, alertClosed, alertError, alertOpened } from "../alerts/notifier.js";
import { broadcast } from "../ws/hub.js";
import { pushStats } from "../stats/service.js";

/** Minimum confidence required to act on a parsed signal. */
const ACT_THRESHOLD = 0.6;

/** Trade ids currently being closed, to prevent concurrent double-closes. */
const closing = new Set<string>();

function symbolAllowed(group: Group, symbol: string): boolean {
  const allow = group.settings.allowedSymbols;
  if (!allow || allow.length === 0) return true;
  return allow.map((s) => s.toUpperCase()).includes(symbol.toUpperCase());
}

/**
 * Entry point for a raw message from a group. Parses it, applies group rules,
 * and either executes immediately (auto) or queues it for confirmation.
 */
export async function handleIncoming(group: Group, rawText: string): Promise<Signal> {
  const parsed = await parseSignal(rawText);

  if (!parsed || parsed.confidence < ACT_THRESHOLD) {
    const signal = signalsRepo.create({
      groupId: group.id,
      groupName: group.name,
      rawText,
      status: "unparseable",
      parsed: parsed ?? undefined,
    });
    broadcast({ type: "signal", signal });
    return signal;
  }

  if (!group.enabled) {
    return finalizeIgnored(group, rawText, parsed, "group disabled");
  }
  if (!symbolAllowed(group, parsed.symbol)) {
    return finalizeIgnored(group, rawText, parsed, `symbol ${parsed.symbol} not allowed`);
  }

  // Traffic-light risk assessment from the channel's history + this signal.
  const risk = assessRisk(group.settings, parsed, tradesRepo.forGroup(group.id));

  // Block high-risk (red) signals when configured, but track what they'd do.
  if (group.settings.blockRedTrades && risk.level === "red") {
    const signal = signalsRepo.create({
      groupId: group.id,
      groupName: group.name,
      rawText,
      status: "blocked",
      parsed,
      risk,
      error: `Blocked: red risk (${risk.score}/100)`,
    });
    await createShadowTrade(group, parsed, signal.id, risk);
    log.info(`Blocked RED signal: ${parsed.side} ${parsed.symbol} (${group.name}) — tracking shadow`);
    alertBlocked(group.name, `${parsed.side} ${parsed.symbol}`, risk.score);
    broadcast({ type: "signal", signal });
    return signal;
  }

  if (group.settings.executionMode === "confirm") {
    const signal = signalsRepo.create({
      groupId: group.id,
      groupName: group.name,
      rawText,
      status: "pending",
      parsed,
      risk,
    });
    log.info(
      `Signal queued for confirmation: ${parsed.side} ${parsed.symbol} (${group.name}) [${risk.level}]`,
    );
    broadcast({ type: "signal", signal });
    return signal;
  }

  // Auto mode: execute right away.
  const signal = signalsRepo.create({
    groupId: group.id,
    groupName: group.name,
    rawText,
    status: "executing",
    parsed,
    risk,
  });
  broadcast({ type: "signal", signal });
  return execute(signal, group, parsed, risk);
}

function finalizeIgnored(
  group: Group,
  rawText: string,
  parsed: ParsedSignal,
  reason: string,
): Signal {
  const signal = signalsRepo.create({
    groupId: group.id,
    groupName: group.name,
    rawText,
    status: "ignored",
    parsed,
    error: reason,
  });
  log.info(`Signal ignored (${reason}): ${parsed.symbol} ${group.name}`);
  broadcast({ type: "signal", signal });
  return signal;
}

/**
 * Record a shadow trade for a blocked (red) signal: a hypothetical position we
 * did NOT take, so the monitor can later evaluate whether blocking it paid off.
 * Uses the live mid (or the stated entry) as the reference entry price.
 */
async function createShadowTrade(
  group: Group,
  parsed: ParsedSignal,
  signalId: string,
  risk: RiskRating,
): Promise<void> {
  // Use the signal's stated entry so SL/TP geometry stays coherent; fall back to
  // the live mid only when the signal didn't give an entry.
  let entry = parsed.entry;
  if (entry === undefined) {
    try {
      entry = await hyperliquid.getMidPrice(parsed.symbol);
    } catch {
      /* no reference price available */
    }
  }
  if (!entry || entry <= 0) return; // can't track without a reference price

  const { tradeSizeUsd, leverage, autoSplitSingleTp, tpLevels } = group.settings;
  const takeProfits = expandTakeProfits(parsed.takeProfits, entry, parsed.side, {
    autoSplit: autoSplitSingleTp,
    levels: tpLevels,
  });

  const trade = tradesRepo.create({
    signalId,
    groupId: group.id,
    groupName: group.name,
    symbol: parsed.symbol,
    side: parsed.side,
    status: "open",
    env: config.tradingEnv,
    leverage,
    notionalUsd: tradeSizeUsd,
    size: tradeSizeUsd / entry,
    entryPrice: entry,
    stopLoss: parsed.stopLoss,
    takeProfits: takeProfits.length ? takeProfits : undefined,
    tpFilledCount: 0,
    risk,
    shadow: true,
    simulated: true,
  });
  signalsRepo.update(signalId, { tradeId: trade.id });
  broadcast({ type: "trade", trade });
}

/** Confirm a pending signal from the desk. */
export async function confirmSignal(signalId: string): Promise<Signal | undefined> {
  const signal = signalsRepo.get(signalId);
  if (!signal || signal.status !== "pending" || !signal.parsed) return signal;
  const group = groupsRepo.get(signal.groupId);
  if (!group) return signal;
  const updated = signalsRepo.update(signalId, { status: "executing" })!;
  broadcast({ type: "signal", signal: updated });
  return execute(updated, group, signal.parsed, signal.risk);
}

/** Reject a pending signal from the desk. */
export function rejectSignal(signalId: string): Signal | undefined {
  const signal = signalsRepo.get(signalId);
  if (!signal || signal.status !== "pending") return signal;
  const updated = signalsRepo.update(signalId, { status: "rejected" });
  if (updated) broadcast({ type: "signal", signal: updated });
  return updated;
}

/** Place the order for a signal and record the resulting trade. */
async function execute(
  signal: Signal,
  group: Group,
  parsed: ParsedSignal,
  risk?: RiskRating,
): Promise<Signal> {
  const { leverage, tradeSizeUsd, marginMode, maxSlippage } = group.settings;

  const result = await hyperliquid.placeMarketOrder({
    symbol: parsed.symbol,
    side: parsed.side,
    notionalUsd: tradeSizeUsd,
    leverage,
    marginMode,
    maxSlippage,
  });

  if (!result.ok) {
    const failed = signalsRepo.update(signal.id, { status: "failed", error: result.error })!;
    log.error(`Order failed for ${parsed.symbol}: ${result.error}`);
    alertError(`order ${parsed.symbol} (${group.name})`, result.error ?? "unknown");
    broadcast({ type: "signal", signal: failed });
    return failed;
  }

  // If the provider gave only one target, split it into several TP levels per
  // the group's settings. The stated entry (or the actual fill) is the base.
  const entryRef = parsed.entry ?? result.filledPrice;
  const takeProfits = expandTakeProfits(parsed.takeProfits, entryRef, parsed.side, {
    autoSplit: group.settings.autoSplitSingleTp,
    levels: group.settings.tpLevels,
  });

  // Protect the position with reduce-only SL/TP trigger orders (live only).
  // Size is scaled out evenly across the take-profit levels.
  const bracket = await hyperliquid.placeBracketOrders({
    symbol: parsed.symbol,
    side: parsed.side,
    size: result.size,
    stopLoss: parsed.stopLoss,
    takeProfits,
    slippage: maxSlippage,
  });
  if (bracket.error) log.warn(`Bracket orders for ${parsed.symbol} failed: ${bracket.error}`);

  const trade = tradesRepo.create({
    signalId: signal.id,
    groupId: group.id,
    groupName: group.name,
    symbol: parsed.symbol,
    side: parsed.side,
    status: "open",
    env: config.tradingEnv,
    leverage,
    notionalUsd: tradeSizeUsd,
    size: result.size,
    entryPrice: result.filledPrice,
    stopLoss: parsed.stopLoss,
    takeProfits: takeProfits.length ? takeProfits : undefined,
    exchangeOrderId: result.orderId,
    slOrderId: bracket.slOrderId,
    tpOrderIds: bracket.tpOrderIds.length ? bracket.tpOrderIds : undefined,
    bracketProtected: bracket.protectedOnExchange,
    tpFilledCount: 0,
    slMovedToBreakeven: false,
    risk,
    simulated: result.simulated,
  });

  const executed = signalsRepo.update(signal.id, { status: "executed", tradeId: trade.id })!;
  const prot =
    parsed.stopLoss === undefined && (parsed.takeProfits?.length ?? 0) === 0
      ? ""
      : bracket.protectedOnExchange
        ? " [SL/TP live]"
        : " [SL/TP recorded]";
  log.info(
    `${result.simulated ? "SIMULATED" : "LIVE"} ${parsed.side} ${result.size} ${parsed.symbol} ` +
      `@ ${result.filledPrice} (${group.name})${prot}`,
  );
  alertOpened(trade);
  broadcast({ type: "signal", signal: executed });
  broadcast({ type: "trade", trade });
  pushStats();
  return executed;
}

/**
 * Manually submit a signal from the desk (paste a message or craft an order).
 * Used by the "simulate signal" feature and manual entry.
 */
export async function submitManual(groupId: string, rawText: string): Promise<Signal | undefined> {
  const group = groupsRepo.get(groupId);
  if (!group) return undefined;
  return handleIncoming(group, rawText);
}

/**
 * Close an open trade. In live mode this sends a reduce-only market order; in
 * paper/simulated mode it just records the exit. Realized PnL is computed from
 * entry vs exit price.
 */
export async function closeTrade(tradeId: string, exitPriceOverride?: number) {
  const trade = tradesRepo.get(tradeId);
  if (!trade || trade.status !== "open") return trade;
  // Shadow trades are hypothetical — resolved by the monitor, never sent to the exchange.
  if (trade.shadow) return trade;
  // Guard against double-close (double click, or racing the monitor).
  if (closing.has(tradeId)) return trade;
  closing.add(tradeId);
  try {
    let exitPrice = exitPriceOverride;
    if (exitPrice === undefined || exitPrice <= 0) {
      let mid: number | undefined;
      try {
        mid = await hyperliquid.getMidPrice(trade.symbol);
      } catch {
        /* price feed down */
      }
      exitPrice = mid && mid > 0 ? mid : trade.entryPrice;
    }

    // Cancel any resting SL/TP orders so they don't fire after we close.
    const restingIds = [trade.slOrderId, ...(trade.tpOrderIds ?? [])].filter(
      (x): x is string => !!x,
    );
    if (restingIds.length) {
      await hyperliquid.cancelOrders(trade.symbol, restingIds);
    }

    // Portion already scaled out at TP levels vs the remainder we now close.
    const tps = trade.takeProfits ?? [];
    const n = tps.length;
    const fraction = n > 0 ? 1 / n : 0;
    const tpFilled = Math.min(trade.tpFilledCount ?? 0, n);
    const remainingFraction = Math.max(0, 1 - tpFilled * fraction);
    const remainingSize = remainingFraction * trade.size;

    if (!trade.simulated && hyperliquid.live && remainingSize > 0) {
      const result = await hyperliquid.placeMarketOrder({
        symbol: trade.symbol,
        side: trade.side === "long" ? "short" : "long",
        notionalUsd: exitPrice * remainingSize,
        leverage: trade.leverage,
        marginMode: "cross",
        maxSlippage: 0.01,
        reduceOnly: true, // never flip into an opposite position
      });
      if (result.ok) exitPrice = result.filledPrice;
    }

    const dir = trade.side === "long" ? 1 : -1;
    // Banked profit from already-filled TP legs + the remainder at the exit.
    let gross = 0;
    let legNotional = 0;
    for (let i = 0; i < tpFilled; i++) {
      gross += (tps[i]! - trade.entryPrice) * dir * fraction * trade.size;
      legNotional += tps[i]! * fraction * trade.size;
    }
    gross += (exitPrice - trade.entryPrice) * dir * remainingSize;
    const feeBase = trade.entryPrice * trade.size + legNotional + exitPrice * remainingSize;
    const fees = feeBase * 0.00035;
    const updated = tradesRepo.update(tradeId, {
      status: "closed",
      exitPrice,
      realizedPnl: gross - fees,
      fees: (trade.fees ?? 0) + fees,
      closedAt: new Date().toISOString(),
    });
    if (updated) {
      broadcast({ type: "trade", trade: updated });
      pushStats();
      alertClosed(updated);
      log.info(`Closed ${trade.symbol} ${trade.side} — PnL ${(gross - fees).toFixed(2)} USDC`);
    }
    return updated;
  } finally {
    closing.delete(tradeId);
  }
}
