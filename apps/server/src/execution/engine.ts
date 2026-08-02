import type { Group, ParsedSignal, RiskRating, Signal, Trade, TradeSide } from "@tttrading/shared";
import { config } from "../config.js";
import { log, event } from "../logger.js";
import { groups as groupsRepo, signals as signalsRepo, trades as tradesRepo } from "../db/repositories.js";
import { hyperliquid } from "../hyperliquid/connector.js";
import { parseSignal } from "../signals/parser.js";
import { classifyManagement, type ManagementAction } from "../signals/management.js";
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
  const preview = rawText.replace(/\s+/g, " ").trim().slice(0, 160);
  event("message", `Incoming from ${group.name}`, {
    channel: group.telegramChannel,
    length: rawText.length,
    preview,
  }, { groupId: group.id });

  const parsed = await parseSignal(rawText, group.settings.instructions);

  if (!parsed || parsed.confidence < ACT_THRESHOLD) {
    // Not a fresh entry — maybe it's a trade-management update (SL move, partial,
    // close, invalidation) for an existing position.
    const action = classifyManagement(rawText);
    if (action.kind !== "none") {
      const managed = await applyManagement(group, rawText, action);
      if (managed) return managed;
    }
    const signal = signalsRepo.create({
      groupId: group.id,
      groupName: group.name,
      rawText,
      status: "unparseable",
      parsed: parsed ?? undefined,
    });
    event(
      "message",
      parsed ? `Parsed but below threshold — ignored` : `No signal detected — ignored`,
      { confidence: parsed?.confidence, source: parsed?.source, threshold: ACT_THRESHOLD },
      { groupId: group.id, signalId: signal.id },
    );
    broadcast({ type: "signal", signal });
    return signal;
  }

  event(
    "message",
    `Parsed ${parsed.side.toUpperCase()} ${parsed.symbol}`,
    {
      source: parsed.source,
      confidence: parsed.confidence,
      entry: parsed.entry,
      stopLoss: parsed.stopLoss,
      takeProfits: parsed.takeProfits,
    },
    { groupId: group.id },
  );

  if (!group.enabled) {
    return finalizeIgnored(group, rawText, parsed, "group disabled");
  }
  if (!symbolAllowed(group, parsed.symbol)) {
    return finalizeIgnored(group, rawText, parsed, `symbol ${parsed.symbol} not allowed`);
  }

  // Traffic-light risk assessment from the channel's history + this signal.
  const risk = assessRisk(group.settings, parsed, tradesRepo.forGroup(group.id));
  event(
    "message",
    `Risk ${risk.level.toUpperCase()} (${risk.score}/100)`,
    { level: risk.level, score: risk.score, reasons: risk.reasons, sampleSize: risk.sampleSize },
    { groupId: group.id },
  );

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
    event(
      "exec",
      `BLOCKED red ${parsed.side} ${parsed.symbol} — tracking shadow`,
      { score: risk.score },
      { level: "warn", groupId: group.id, signalId: signal.id },
    );
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
    event(
      "message",
      `Queued for confirmation: ${parsed.side} ${parsed.symbol}`,
      { risk: risk.level },
      { groupId: group.id, signalId: signal.id },
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
  event(
    "exec",
    `Auto-executing ${parsed.side} ${parsed.symbol}`,
    undefined,
    { groupId: group.id, signalId: signal.id },
  );
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
  event("message", `Ignored (${reason}): ${parsed.symbol}`, { reason }, {
    groupId: group.id,
    signalId: signal.id,
  });
  broadcast({ type: "signal", signal });
  return signal;
}

/** Move a trade's stop-loss (break-even or explicit). Place-then-cancel when live. */
async function moveStop(trade: Trade, newStop: number, breakeven: boolean): Promise<void> {
  if (!trade.simulated && hyperliquid.live && trade.slOrderId) {
    const res = await hyperliquid.placeBracketOrders({
      symbol: trade.symbol,
      side: trade.side,
      size: trade.size,
      stopLoss: newStop,
      takeProfits: [],
      slippage: 0.01,
    });
    if (res.protectedOnExchange && res.slOrderId) {
      await hyperliquid.cancelOrders(trade.symbol, [trade.slOrderId]);
      tradesRepo.update(trade.id, {
        stopLoss: newStop,
        slOrderId: res.slOrderId,
        slMovedToBreakeven: breakeven ? true : trade.slMovedToBreakeven,
      });
      return;
    }
    log.warn(`moveStop: failed to place new SL for ${trade.symbol}; keeping old.`);
  }
  tradesRepo.update(trade.id, {
    stopLoss: newStop,
    slMovedToBreakeven: breakeven ? true : trade.slMovedToBreakeven,
  });
}

/** Taker fee rate applied to each exit leg (Hyperliquid-ish). */
const FEE_RATE = 0.00035;

/**
 * Partially close a trade ("book X%"): reduce the remaining size and BANK the
 * realized PnL of the exited fraction (with fees), so it carries into the final
 * realizedPnl when the trade eventually closes. Does NOT touch tpFilledCount —
 * that counter belongs to native TP scale-out, a separate mechanism.
 */
async function partialClose(trade: Trade, rawFraction: number): Promise<void> {
  const frac = Math.min(Math.max(rawFraction, 0), 0.95);
  const closeSize = trade.size * frac;
  if (closeSize <= 0) return;

  // Reference exit price: the real fill in live mode, else the live mid.
  let exitPx: number | undefined;
  if (!trade.simulated && hyperliquid.live) {
    const res = await hyperliquid.placeMarketOrder({
      symbol: trade.symbol,
      side: trade.side === "long" ? "short" : "long",
      notionalUsd: trade.entryPrice * closeSize,
      leverage: trade.leverage,
      marginMode: "cross",
      maxSlippage: 0.01,
      reduceOnly: true,
    });
    if (res.ok && res.filledPrice > 0) exitPx = res.filledPrice;
  }
  if (exitPx === undefined) {
    try {
      const mid = await hyperliquid.getMidPrice(trade.symbol);
      if (mid && mid > 0) exitPx = mid;
    } catch {
      /* price feed down */
    }
  }
  if (exitPx === undefined || exitPx <= 0) exitPx = trade.entryPrice;

  const dir = trade.side === "long" ? 1 : -1;
  const legPnl = (exitPx - trade.entryPrice) * dir * closeSize;
  // Round-trip fee for this leg (entry + exit side). The remaining size's entry
  // fee is charged by closeTrade on the reduced size, so together they add up to
  // exactly one entry fee on the original position.
  const legFee = (trade.entryPrice + exitPx) * closeSize * FEE_RATE;

  tradesRepo.update(trade.id, {
    size: trade.size - closeSize,
    bankedPnl: (trade.bankedPnl ?? 0) + legPnl,
    bankedFees: (trade.bankedFees ?? 0) + legFee,
  });
  event(
    "manage",
    `Booked ${(frac * 100).toFixed(0)}% of ${trade.symbol} @ ${exitPx} — banked ${(legPnl - legFee).toFixed(2)} USDC`,
    { fraction: frac, exitPx, legPnl, legFee, remainingSize: trade.size - closeSize },
    { groupId: trade.groupId },
  );
}

/**
 * Apply a trade-management message to the group's matching open position(s).
 * Records a "managed" signal for visibility. Returns null if it couldn't act
 * (so the caller falls through to the unparseable path).
 */
async function applyManagement(
  group: Group,
  rawText: string,
  action: ManagementAction,
): Promise<Signal | null> {
  const openForGroup = tradesRepo.open().filter((t) => t.groupId === group.id && !t.shadow);
  const sym = action.symbol?.toUpperCase();
  // Target by symbol; if no symbol and exactly one open trade, target that.
  const targets = sym
    ? openForGroup.filter((t) => t.symbol === sym)
    : openForGroup.length === 1
      ? openForGroup
      : [];

  if (targets.length === 0) {
    const signal = signalsRepo.create({
      groupId: group.id,
      groupName: group.name,
      rawText,
      status: "managed",
      error: `${action.note} — no open ${sym ?? ""} position`.trim(),
    });
    event(
      "manage",
      `Management (${action.note}) — no matching open position${sym ? ` for ${sym}` : ""}`,
      { kind: action.kind },
      { groupId: group.id, signalId: signal.id },
    );
    broadcast({ type: "signal", signal });
    return signal;
  }

  for (const t of targets) {
    if (action.kind === "close") {
      await closeTrade(t.id);
    } else if (action.kind === "sl_breakeven") {
      await moveStop(t, t.entryPrice, true);
    } else if (action.kind === "sl_move" && action.newStop !== undefined) {
      await moveStop(t, action.newStop, false);
    } else if (action.kind === "partial_close") {
      await partialClose(t, action.fraction ?? 0);
      if (action.alsoBreakeven) {
        const fresh = tradesRepo.get(t.id);
        if (fresh) await moveStop(fresh, fresh.entryPrice, true);
      }
    } else if (action.kind === "tp_hit") {
      tradesRepo.update(t.id, { tpFilledCount: (t.tpFilledCount ?? 0) + 1 });
    }
    const u = tradesRepo.get(t.id);
    if (u) broadcast({ type: "trade", trade: u });
  }

  const signal = signalsRepo.create({
    groupId: group.id,
    groupName: group.name,
    rawText,
    status: "managed",
    error: `${action.note} → ${targets.map((t) => t.symbol).join(", ")}`,
  });
  event(
    "manage",
    `Applied "${action.note}" to ${targets.length} ${targets[0]!.symbol} position(s)`,
    { kind: action.kind, newStop: action.newStop, fraction: action.fraction },
    { groupId: group.id, signalId: signal.id },
  );
  broadcast({ type: "signal", signal });
  pushStats();
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

  // Guard: the symbol must exist on the exchange. Some tickers a channel posts
  // aren't listed on Hyperliquid — record FAILED (Crypto NOT found) rather than
  // erroring out at order time. Uses public metadata, so it also runs in test.
  try {
    const asset = await hyperliquid.getAsset(parsed.symbol);
    if (!asset) {
      const reason = `Crypto NOT found: ${parsed.symbol} is not listed on Hyperliquid`;
      const failed = signalsRepo.update(signal.id, { status: "failed", error: reason })!;
      event(
        "exec",
        `SKIP ${parsed.symbol}: not listed on the exchange`,
        { symbol: parsed.symbol },
        { level: "warn", groupId: group.id, signalId: signal.id },
      );
      broadcast({ type: "signal", signal: failed });
      return failed;
    }
  } catch (err) {
    // Metadata unavailable — don't block; let the order path surface any error.
    log.warn(
      `Asset check for ${parsed.symbol} failed:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Guard: don't chase a signal whose entry the market has already run past.
  // If the trader set an entry and the current price is already worse than it
  // (beyond maxSlippage) in the fill direction, record FAILED with the reason
  // instead of entering late at a skewed risk/reward.
  if (parsed.entry !== undefined) {
    let mid: number | undefined;
    try {
      mid = await hyperliquid.getMidPrice(parsed.symbol);
    } catch {
      /* no price feed — can't judge, fall through and let the order try */
    }
    if (mid && mid > 0) {
      const past =
        parsed.side === "long"
          ? mid > parsed.entry * (1 + maxSlippage)
          : mid < parsed.entry * (1 - maxSlippage);
      if (past) {
        const reason = `entry missed: price ${mid} already past entry ${parsed.entry}`;
        const failed = signalsRepo.update(signal.id, { status: "failed", error: reason })!;
        event(
          "exec",
          `SKIP ${parsed.side} ${parsed.symbol}: ${reason}`,
          { mid, entry: parsed.entry, side: parsed.side, maxSlippage },
          { level: "warn", groupId: group.id, signalId: signal.id },
        );
        broadcast({ type: "signal", signal: failed });
        return failed;
      }
    }
  }

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
    event(
      "exec",
      `Order FAILED for ${parsed.symbol}: ${result.error}`,
      { error: result.error, simulated: result.simulated },
      { level: "error", groupId: group.id, signalId: signal.id },
    );
    alertError(`order ${parsed.symbol} (${group.name})`, result.error ?? "unknown");
    broadcast({ type: "signal", signal: failed });
    return failed;
  }

  event(
    "exec",
    `${result.simulated ? "Simulated" : "Live"} fill ${parsed.side} ${result.size} ${parsed.symbol} @ ${result.filledPrice}`,
    { simulated: result.simulated, size: result.size, price: result.filledPrice, orderId: result.orderId },
    { groupId: group.id, signalId: signal.id },
  );

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
  if (bracket.error) {
    event(
      "exec",
      `Bracket (SL/TP) placement failed for ${parsed.symbol}: ${bracket.error}`,
      { error: bracket.error },
      { level: "warn", groupId: group.id, signalId: signal.id },
    );
  } else if (bracket.protectedOnExchange) {
    event(
      "exec",
      `SL/TP placed on exchange for ${parsed.symbol}`,
      { sl: bracket.slOrderId, tps: bracket.tpOrderIds, levels: takeProfits },
      { groupId: group.id, signalId: signal.id },
    );
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
  event(
    "exec",
    `Trade opened ${parsed.side} ${parsed.symbol} (${result.simulated ? "sim" : "live"})`,
    {
      tradeId: trade.id,
      entry: trade.entryPrice,
      size: trade.size,
      leverage: trade.leverage,
      protected: bracket.protectedOnExchange,
    },
    { groupId: group.id, signalId: signal.id },
  );
  alertOpened(trade);
  broadcast({ type: "signal", signal: executed });
  broadcast({ type: "trade", trade });
  pushStats();
  return executed;
}

/**
 * Place a one-off test order straight from the desk (not tied to a channel).
 * Creates a tracked Trade so it shows up in the Trades area and can be closed
 * there like any other. Respects the global shadow/test switch: simulated when
 * test mode is on, real when live.
 */
export async function placeTestOrder(params: {
  symbol: string;
  side: TradeSide;
  notionalUsd: number;
  leverage: number;
}): Promise<{ ok: boolean; error?: string; trade?: Trade }> {
  const symbol = params.symbol.trim().toUpperCase();
  const { side, notionalUsd, leverage } = params;
  if (!symbol) return { ok: false, error: "symbol required" };
  if (!(notionalUsd > 0)) return { ok: false, error: "size must be > 0" };
  if (!(leverage >= 1)) return { ok: false, error: "leverage must be >= 1" };

  try {
    const asset = await hyperliquid.getAsset(symbol);
    if (!asset) return { ok: false, error: `Crypto NOT found: ${symbol} is not listed on Hyperliquid` };
  } catch {
    /* metadata unavailable — let the order path surface any error */
  }

  const result = await hyperliquid.placeMarketOrder({
    symbol,
    side,
    notionalUsd,
    leverage,
    marginMode: "cross",
    maxSlippage: 0.01,
  });
  if (!result.ok) {
    event(
      "exec",
      `Test order FAILED ${side} ${symbol}: ${result.error}`,
      { error: result.error, simulated: result.simulated },
      { level: "error" },
    );
    return { ok: false, error: result.error };
  }

  const trade = tradesRepo.create({
    groupId: "manual",
    groupName: "Manual test",
    symbol,
    side,
    status: "open",
    env: config.tradingEnv,
    leverage,
    notionalUsd,
    size: result.size,
    entryPrice: result.filledPrice,
    exchangeOrderId: result.orderId,
    tpFilledCount: 0,
    slMovedToBreakeven: false,
    simulated: result.simulated,
  });
  event(
    "exec",
    `Test order ${side} ${symbol} (${result.simulated ? "sim" : "live"}) @ ${result.filledPrice}`,
    { tradeId: trade.id, size: trade.size, notionalUsd, leverage },
    {},
  );
  alertOpened(trade);
  broadcast({ type: "trade", trade });
  pushStats();
  return { ok: true, trade };
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
    const fees = feeBase * FEE_RATE;
    // Fold in profit/fees already banked from earlier partial exits ("book X%").
    const bankedPnl = trade.bankedPnl ?? 0;
    const bankedFees = trade.bankedFees ?? 0;
    const updated = tradesRepo.update(tradeId, {
      status: "closed",
      exitPrice,
      realizedPnl: bankedPnl - bankedFees + gross - fees,
      fees: (trade.fees ?? 0) + bankedFees + fees,
      closedAt: new Date().toISOString(),
    });
    if (updated) {
      broadcast({ type: "trade", trade: updated });
      pushStats();
      alertClosed(updated);
      log.info(
        `Closed ${trade.symbol} ${trade.side} — PnL ${(bankedPnl - bankedFees + gross - fees).toFixed(2)} USDC` +
          (bankedPnl ? ` (incl. ${(bankedPnl - bankedFees).toFixed(2)} banked)` : ""),
      );
    }
    return updated;
  } finally {
    closing.delete(tradeId);
  }
}
