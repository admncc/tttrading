import type { Group, ParsedSignal, RiskRating, Signal, Trade, TradeSide } from "@tttrading/shared";
import { config } from "../config.js";
import { log, event } from "../logger.js";
import {
  groups as groupsRepo,
  signals as signalsRepo,
  trades as tradesRepo,
  settings as settingsRepo,
} from "../db/repositories.js";
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

/** Trade ids currently being closed/reduced, to prevent concurrent double-closes. */
export const closing = new Set<string>();

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
  // Real position with a live stop: replace it on the exchange (force, so this
  // still works with the global test switch on — the position is real).
  if (!trade.simulated && hyperliquid.live && trade.slOrderId) {
    const res = await hyperliquid.placeBracketOrders({
      symbol: trade.symbol,
      side: trade.side,
      size: trade.size,
      stopLoss: newStop,
      takeProfits: [],
      slippage: 0.01,
      force: true,
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
    // Do NOT update the desk to a stop we failed to place — the OLD stop is
    // still live on the exchange and keeps protecting the position.
    log.error(
      `moveStop: failed to place new SL for ${trade.symbol} (${res.error ?? "no id"}); ` +
        `keeping existing exchange stop, desk unchanged.`,
    );
    return;
  }
  // Simulated trade: just record the stop for the monitor to enforce.
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
async function partialClose(tradeInput: Trade, rawFraction: number): Promise<void> {
  const frac = Math.min(Math.max(rawFraction, 0), 0.95);
  if (frac <= 0) return;
  const id = tradeInput.id;
  // Serialize with close/other partials on the same trade (prevents over-close).
  if (closing.has(id)) return;
  closing.add(id);
  try {
    const trade = tradesRepo.get(id);
    if (!trade || trade.status !== "open" || trade.shadow) return;
    const intendedSize = trade.size * frac;
    if (intendedSize <= 0) return;

    // Determine the exit price up front from the live mid, then size the order
    // off THAT price (the connector derives size = notional / mid).
    let exitPx: number | undefined;
    try {
      const mid = await hyperliquid.getMidPrice(trade.symbol);
      if (mid && mid > 0) exitPx = mid;
    } catch {
      /* price feed down */
    }
    if (exitPx === undefined || exitPx <= 0) exitPx = trade.entryPrice;

    let closedSize = intendedSize;
    if (!trade.simulated && hyperliquid.live) {
      const res = await hyperliquid.placeMarketOrder({
        symbol: trade.symbol,
        side: trade.side === "long" ? "short" : "long",
        notionalUsd: exitPx * intendedSize, // size off current price, not entry
        leverage: trade.leverage,
        marginMode: "cross",
        maxSlippage: 0.01,
        reduceOnly: true,
        force: true, // real position → always hit the exchange, even in test mode
      });
      if (!res.ok) {
        log.warn(`partialClose: order failed for ${trade.symbol}: ${res.error}`);
        return;
      }
      if (res.filledPrice > 0) exitPx = res.filledPrice;
      if (res.size > 0) closedSize = res.size; // ACTUAL filled size (partials)
    }

    const dir = trade.side === "long" ? 1 : -1;
    const legPnl = (exitPx - trade.entryPrice) * dir * closedSize;
    // Round-trip fee for this leg (entry + exit side); the remaining size's entry
    // fee is charged by closeTrade, so together they sum to one entry fee.
    const legFee = (trade.entryPrice + exitPx) * closedSize * FEE_RATE;
    const remaining = Math.max(0, trade.size - closedSize);

    tradesRepo.update(trade.id, {
      size: remaining,
      bankedPnl: (trade.bankedPnl ?? 0) + legPnl,
      bankedFees: (trade.bankedFees ?? 0) + legFee,
    });
    event(
      "manage",
      `Booked ${(frac * 100).toFixed(0)}% of ${trade.symbol} @ ${exitPx} — banked ${(legPnl - legFee).toFixed(2)} USDC`,
      { fraction: frac, exitPx, closedSize, legPnl, legFee, remainingSize: remaining },
      { groupId: trade.groupId },
    );
  } finally {
    closing.delete(id);
  }
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
  // Don't let messages manage positions of a channel the operator disabled.
  if (!group.enabled) return null;

  const openForGroup = tradesRepo.open().filter((t) => t.groupId === group.id && !t.shadow);
  const sym = action.symbol?.toUpperCase();
  // Destructive actions REQUIRE an explicit symbol — never fall back to "the one
  // open trade", so stray chatter containing a trigger word can't close/alter a
  // live position. Only the informational tp_hit may use the single-trade fallback.
  const destructive = action.kind !== "tp_hit";
  const targets = sym
    ? openForGroup.filter((t) => t.symbol === sym)
    : !destructive && openForGroup.length === 1
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
      // Only accept a stop on the PROTECTIVE side of the market — a long's stop
      // must sit below price, a short's above — else reject (a message like
      // "SL to 999999" would otherwise force an instant stop-out).
      let price = t.entryPrice;
      try {
        const mid = await hyperliquid.getMidPrice(t.symbol);
        if (mid && mid > 0) price = mid;
      } catch {
        /* use entry as the reference */
      }
      const ok = t.side === "long" ? action.newStop < price : action.newStop > price;
      if (ok) {
        await moveStop(t, action.newStop, false);
      } else {
        event(
          "manage",
          `Rejected SL move for ${t.symbol}: ${action.newStop} is on the wrong side of ${price}`,
          { newStop: action.newStop, price, side: t.side },
          { level: "warn", groupId: group.id },
        );
      }
    } else if (action.kind === "partial_close") {
      await partialClose(t, action.fraction ?? 0);
      if (action.alsoBreakeven) {
        const fresh = tradesRepo.get(t.id);
        if (fresh) await moveStop(fresh, fresh.entryPrice, true);
      }
    } else if (action.kind === "tp_hit") {
      // Only advance the TP counter for SIMULATED trades — for live trades,
      // reconciliation from real fills is the sole authority (a stray "TP hit"
      // message must not fabricate banked profit). Clamp to the TP count.
      if (t.simulated) {
        const cap = t.takeProfits?.length ?? 0;
        const next = Math.min((t.tpFilledCount ?? 0) + 1, cap || (t.tpFilledCount ?? 0) + 1);
        tradesRepo.update(t.id, { tpFilledCount: next });
      }
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

/**
 * Global risk gate applied before any new entry: kill-switch pause, max open
 * trades, max total exposure, and daily loss limit. Returns a block reason or
 * null when the trade may proceed.
 */
function preTradeGate(newNotional: number): string | null {
  const g = settingsRepo.getGlobalSettings();
  if (g.tradingPaused) return "trading paused (kill-switch)";

  const open = tradesRepo.open().filter((t) => !t.shadow);
  if (g.maxOpenTrades > 0 && open.length >= g.maxOpenTrades) {
    return `max open trades reached (${open.length}/${g.maxOpenTrades})`;
  }
  if (g.maxExposureUsd > 0) {
    const exposure = open.reduce((s, t) => s + t.notionalUsd, 0);
    if (exposure + newNotional > g.maxExposureUsd) {
      return `max exposure would be exceeded (${(exposure + newNotional).toFixed(0)} > ${g.maxExposureUsd})`;
    }
  }
  if (g.dailyLossLimitUsd > 0) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const iso = start.toISOString();
    const todayPnl = tradesRepo
      .list(10000)
      .filter(
        (t) =>
          !t.shadow &&
          t.status === "closed" &&
          (t.closedAt ?? "") >= iso &&
          Number.isFinite(t.realizedPnl),
      )
      .reduce((s, t) => s + (t.realizedPnl as number), 0);
    if (todayPnl <= -g.dailyLossLimitUsd) {
      return `daily loss limit hit (${todayPnl.toFixed(2)} today, limit −${g.dailyLossLimitUsd})`;
    }
  }
  return null;
}

/** Close every open (non-shadow) trade — used by the kill-switch. */
export async function closeAllTrades(): Promise<{ closed: number }> {
  const open = tradesRepo.open().filter((t) => !t.shadow);
  let closed = 0;
  for (const t of open) {
    try {
      const r = await closeTrade(t.id);
      if (r?.status === "closed") closed++;
    } catch (err) {
      log.error(`closeAll ${t.symbol}:`, err instanceof Error ? err.message : err);
    }
  }
  event("exec", `Kill-switch: closed ${closed}/${open.length} open trades`, { closed }, { level: "warn" });
  return { closed };
}

/**
 * Position size (notional USDC) for a signal per the group's sizing mode:
 * fixed, percent-of-equity, or fixed-risk-from-SL. Falls back to the fixed
 * tradeSizeUsd whenever the inputs for a dynamic mode aren't available.
 */
/** Absolute per-trade notional ceiling — a backstop against dynamic-sizing blowups. */
const MAX_ORDER_NOTIONAL = 10_000_000;
/** Floor on the SL distance used for risk sizing, so a near-entry SL can't blow up size. */
const MIN_STOP_DIST = 0.002; // 0.2%

async function effectiveNotional(group: Group, parsed: ParsedSignal): Promise<number> {
  const s = group.settings;
  const mode = s.sizingMode ?? "fixed";
  // Never exceed a sane multiple of the channel's own fixed size, nor the hard cap.
  const cap = Math.min(MAX_ORDER_NOTIONAL, Math.max(s.tradeSizeUsd * 10, s.tradeSizeUsd));
  const clamp = (n: number) => Math.min(Math.max(0, n), cap);

  if (mode === "percentEquity" && (s.riskValue ?? 0) > 0) {
    const pct = Math.min(s.riskValue as number, 100); // margin can't exceed 100% of equity
    try {
      const equity = (await hyperliquid.getAccountSummary())?.accountValue ?? 0;
      if (equity > 0) return clamp(equity * (pct / 100) * s.leverage);
    } catch {
      /* no equity reading — fall back */
    }
    return s.tradeSizeUsd;
  }
  if (mode === "riskPerTrade" && (s.riskValue ?? 0) > 0 && parsed.stopLoss !== undefined) {
    let ref = parsed.entry;
    if (ref === undefined) {
      try {
        ref = await hyperliquid.getMidPrice(parsed.symbol);
      } catch {
        /* fall back */
      }
    }
    if (ref && ref > 0) {
      const stopDist = Math.max(Math.abs(ref - parsed.stopLoss) / ref, MIN_STOP_DIST);
      return clamp((s.riskValue as number) / stopDist);
    }
    return s.tradeSizeUsd;
  }
  return Math.min(s.tradeSizeUsd, MAX_ORDER_NOTIONAL);
}

/** Place the order for a signal and record the resulting trade. */
async function execute(
  signal: Signal,
  group: Group,
  parsed: ParsedSignal,
  risk?: RiskRating,
): Promise<Signal> {
  const { leverage, marginMode, maxSlippage } = group.settings;

  // Symbol cooldown: skip a same-symbol+side entry too soon after the last one.
  const cd = group.settings.symbolCooldownMinutes ?? 0;
  if (cd > 0) {
    const cutoff = Date.now() - cd * 60_000;
    const recent = tradesRepo
      .forGroup(group.id)
      .find(
        (t) =>
          t.symbol === parsed.symbol &&
          t.side === parsed.side &&
          !t.shadow &&
          new Date(t.openedAt).getTime() >= cutoff,
      );
    if (recent) {
      const reason = `cooldown: ${parsed.symbol} ${parsed.side} traded < ${cd}m ago`;
      const ignored = signalsRepo.update(signal.id, { status: "ignored", error: reason })!;
      event("exec", `Cooldown skip ${parsed.symbol}`, { reason }, {
        level: "warn",
        groupId: group.id,
        signalId: signal.id,
      });
      broadcast({ type: "signal", signal: ignored });
      return ignored;
    }
  }

  // Position size per the group's sizing mode.
  const tradeSizeUsd = await effectiveNotional(group, parsed);

  // Global risk gate (kill-switch / limits) — applies to every new entry.
  const block = preTradeGate(tradeSizeUsd);
  if (block) {
    const ignored = signalsRepo.update(signal.id, { status: "ignored", error: block })!;
    event("exec", `Entry blocked (${block}) for ${parsed.symbol}`, { reason: block }, {
      level: "warn",
      groupId: group.id,
      signalId: signal.id,
    });
    broadcast({ type: "signal", signal: ignored });
    return ignored;
  }

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

  // A test order is still a new entry — respect the kill-switch and risk limits.
  const block = preTradeGate(notionalUsd);
  if (block) return { ok: false, error: block };

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
        force: true, // real position → close on the exchange even in test mode
      });
      if (!result.ok) {
        // The exchange did NOT reduce the position — do not mark it closed, or
        // the desk would show a flat trade while a live position runs on with
        // its SL/TP already cancelled above.
        log.error(`closeTrade: exchange close failed for ${trade.symbol}: ${result.error}`);
        alertError(`close ${trade.symbol} (${trade.groupName})`, result.error ?? "unknown");
        return tradesRepo.get(tradeId);
      }
      exitPrice = result.filledPrice;
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
