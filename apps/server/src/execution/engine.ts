import type { Group, ParsedSignal, Signal } from "@tttrading/shared";
import { config } from "../config.js";
import { log } from "../logger.js";
import { groups as groupsRepo, signals as signalsRepo, trades as tradesRepo } from "../db/repositories.js";
import { hyperliquid } from "../hyperliquid/connector.js";
import { parseSignal } from "../signals/parser.js";
import { broadcast } from "../ws/hub.js";
import { pushStats } from "../stats/service.js";

/** Minimum confidence required to act on a parsed signal. */
const ACT_THRESHOLD = 0.6;

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

  if (group.settings.executionMode === "confirm") {
    const signal = signalsRepo.create({
      groupId: group.id,
      groupName: group.name,
      rawText,
      status: "pending",
      parsed,
    });
    log.info(`Signal queued for confirmation: ${parsed.side} ${parsed.symbol} (${group.name})`);
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
  });
  broadcast({ type: "signal", signal });
  return execute(signal, group, parsed);
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

/** Confirm a pending signal from the desk. */
export async function confirmSignal(signalId: string): Promise<Signal | undefined> {
  const signal = signalsRepo.get(signalId);
  if (!signal || signal.status !== "pending" || !signal.parsed) return signal;
  const group = groupsRepo.get(signal.groupId);
  if (!group) return signal;
  const updated = signalsRepo.update(signalId, { status: "executing" })!;
  broadcast({ type: "signal", signal: updated });
  return execute(updated, group, signal.parsed);
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
async function execute(signal: Signal, group: Group, parsed: ParsedSignal): Promise<Signal> {
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
    broadcast({ type: "signal", signal: failed });
    return failed;
  }

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
    takeProfits: parsed.takeProfits,
    exchangeOrderId: result.orderId,
  });

  const executed = signalsRepo.update(signal.id, { status: "executed", tradeId: trade.id })!;
  log.info(
    `${result.simulated ? "SIMULATED" : "LIVE"} ${parsed.side} ${result.size} ${parsed.symbol} ` +
      `@ ${result.filledPrice} (${group.name})`,
  );
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

  let exitPrice = exitPriceOverride;
  if (exitPrice === undefined) {
    exitPrice = (await hyperliquid.getMidPrice(trade.symbol)) ?? trade.entryPrice;
  }

  if (hyperliquid.live) {
    const result = await hyperliquid.placeMarketOrder({
      symbol: trade.symbol,
      side: trade.side === "long" ? "short" : "long", // reduce
      notionalUsd: exitPrice * trade.size,
      leverage: trade.leverage,
      marginMode: "cross",
      maxSlippage: 0.01,
    });
    if (result.ok) exitPrice = result.filledPrice;
  }

  const dir = trade.side === "long" ? 1 : -1;
  const grossPnl = (exitPrice - trade.entryPrice) * dir * trade.size;
  const fees = trade.notionalUsd * 0.00035;
  const updated = tradesRepo.update(tradeId, {
    status: "closed",
    exitPrice,
    realizedPnl: grossPnl - fees,
    fees: (trade.fees ?? 0) + fees,
    closedAt: new Date().toISOString(),
  });
  if (updated) {
    broadcast({ type: "trade", trade: updated });
    pushStats();
    log.info(`Closed ${trade.symbol} ${trade.side} — PnL ${(grossPnl - fees).toFixed(2)} USDC`);
  }
  return updated;
}
