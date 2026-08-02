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
import { byName, resolveForSymbol } from "../exchanges/registry.js";
import type { ExchangeConnector } from "../exchanges/types.js";
import { parseSignal } from "../signals/parser.js";
import { classifyManagement, type ManagementAction } from "../signals/management.js";
import { expandTakeProfits } from "../signals/takeprofit.js";
import { assessRisk } from "../risk/score.js";
import { alertBlocked, alertClosed, alertError, alertOpened, sendAlert } from "../alerts/notifier.js";
import { broadcast } from "../ws/hub.js";
import { pushStats } from "../stats/service.js";

/** Minimum confidence required to act on a parsed signal. */
const ACT_THRESHOLD = 0.6;

/** Trade ids currently being closed/reduced, to prevent concurrent double-closes. */
export const closing = new Set<string>();

/** The venue a trade lives on (defaults to Hyperliquid for legacy rows). */
function connectorFor(trade: Trade): ExchangeConnector {
  return byName(trade.exchange);
}

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
  const ex = connectorFor(trade);
  // Real, live position (open OR resting): put the stop on the exchange. Place
  // the NEW stop first, then cancel the old one (if any) — never leave the
  // position without protection. This also PLACES a stop when none existed yet
  // (e.g. the entry came without an SL), instead of only replacing one.
  // `force` so it still works with the global test switch on — the position is real.
  if (!trade.simulated && ex.live && trade.status === "open") {
    const res = await ex.placeBracketOrders({
      symbol: trade.symbol,
      side: trade.side,
      size: trade.size,
      stopLoss: newStop,
      takeProfits: [],
      slippage: 0.01,
      force: true,
    });
    if (res.protectedOnExchange && res.slOrderId) {
      if (trade.slOrderId) await ex.cancelOrders(trade.symbol, [trade.slOrderId]);
      tradesRepo.update(trade.id, {
        stopLoss: newStop,
        slOrderId: res.slOrderId,
        bracketProtected: true,
        slMovedToBreakeven: breakeven ? true : trade.slMovedToBreakeven,
      });
      return;
    }
    // Placement failed. If an old stop is still live, keep it and don't lie about
    // the desk value. If there was NO stop, record the intent but alert loudly —
    // the live position is NOT protected on the exchange and needs attention.
    if (trade.slOrderId) {
      log.error(
        `moveStop: failed to place new SL for ${trade.symbol} (${res.error ?? "no id"}); ` +
          `keeping existing exchange stop, desk unchanged.`,
      );
      return;
    }
    log.error(
      `moveStop: could NOT place stop ${newStop} for LIVE ${trade.symbol} (${res.error ?? "no id"}) — position is UNPROTECTED on the exchange.`,
    );
    alertError(`SL ${trade.symbol} (${trade.groupName})`, `stop ${newStop} not placed — position unprotected: ${res.error ?? "unknown"}`);
    tradesRepo.update(trade.id, {
      stopLoss: newStop,
      slMovedToBreakeven: breakeven ? true : trade.slMovedToBreakeven,
    });
    return;
  }
  // Simulated trade, or a resting/working limit order (no live position yet):
  // record the (planned) stop for the monitor/promotion to enforce.
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
    const ex = connectorFor(trade);
    const intendedSize = trade.size * frac;
    if (intendedSize <= 0) return;

    // Determine the exit price up front from the live mid, then size the order
    // off THAT price (the connector derives size = notional / mid).
    let exitPx: number | undefined;
    try {
      const mid = await ex.getMidPrice(trade.symbol);
      if (mid && mid > 0) exitPx = mid;
    } catch {
      /* price feed down */
    }
    if (exitPx === undefined || exitPx <= 0) exitPx = trade.entryPrice;

    let closedSize = intendedSize;
    if (!trade.simulated && ex.live) {
      const res = await ex.placeMarketOrder({
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
  // An SL move / break-even may also target a still-resting limit order (the
  // default entry mode) — updating its planned stop so the bracket uses the new
  // level on fill. Partial/close/tp only make sense on an already-open position.
  const slKind = action.kind === "sl_move" || action.kind === "sl_breakeven";
  const workingForGroup = slKind
    ? tradesRepo.working().filter((t) => t.groupId === group.id && !t.shadow)
    : [];
  const manageable = [...openForGroup, ...workingForGroup];
  const sym = action.symbol?.toUpperCase();
  // Only a full `close` (retraction / invalidation) REQUIRES an explicit symbol —
  // stray chatter containing a close word must never flatten a live position.
  // Everything else (SL move / break-even, partial book, TP progress) may fall
  // back to the group's SINGLE managed position when no symbol is given: that's
  // unambiguous and matches how traders post follow-ups ("move SL to 62000")
  // right after opening one trade. An SL move is further guarded by the
  // wrong-side check, so it can't be abused into an instant stop-out.
  const requireExplicitSymbol = action.kind === "close";
  const targets = sym
    ? manageable.filter((t) => t.symbol === sym)
    : !requireExplicitSymbol && manageable.length === 1
      ? manageable
      : [];

  // A "close" (retraction / invalidation) should also cancel a still-resting
  // limit order for that symbol, so an abandoned setup can't fill later.
  let canceledWorking = 0;
  if (action.kind === "close" && sym) {
    const workingForSym = tradesRepo
      .working()
      .filter((t) => t.groupId === group.id && t.symbol === sym && !t.shadow);
    for (const w of workingForSym) {
      await cancelWorkingTrade(w.id, `management: ${action.note}`);
      canceledWorking++;
    }
  }

  if (targets.length === 0) {
    // Distinguish "nothing open" from "ambiguous" so the operator knows whether
    // to name the symbol (the latter happens with 2+ open trades and no symbol).
    const ambiguous = !sym && manageable.length > 1;
    const reason =
      canceledWorking > 0
        ? `${action.note} — canceled ${canceledWorking} working ${sym} order(s)`
        : ambiguous
          ? `${action.note} — ${manageable.length} open positions (${manageable
              .map((t) => t.symbol)
              .join(", ")}); specify the symbol`
          : `${action.note} — no open ${sym ?? ""} position`.trim();
    const signal = signalsRepo.create({
      groupId: group.id,
      groupName: group.name,
      rawText,
      status: "managed",
      error: reason,
    });
    event(
      "manage",
      canceledWorking > 0
        ? `Canceled ${canceledWorking} working ${sym} order(s) (${action.note})`
        : `Management (${action.note}) — no matching open position${sym ? ` for ${sym}` : ""}`,
      { kind: action.kind, canceledWorking },
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
        const mid = await connectorFor(t).getMidPrice(t.symbol);
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
  // Resolve the venue this symbol would trade on so a backup-only coin still
  // gets a reference price and is tagged with the right exchange.
  const resolved = await resolveForSymbol(parsed.symbol);
  const ex = resolved.kind === "found" ? resolved.ex : hyperliquid;
  // Use the signal's stated entry so SL/TP geometry stays coherent; fall back to
  // the live mid only when the signal didn't give an entry.
  let entry = parsed.entry;
  if (entry === undefined) {
    try {
      entry = await ex.getMidPrice(parsed.symbol);
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
    exchange: ex.name,
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

  // Count open positions AND resting working orders (reserved capital).
  const active = tradesRepo.activeAndWorking().filter((t) => !t.shadow);
  if (g.maxOpenTrades > 0 && active.length >= g.maxOpenTrades) {
    return `max open trades reached (${active.length}/${g.maxOpenTrades})`;
  }
  if (g.maxExposureUsd > 0) {
    const exposure = active.reduce((s, t) => s + t.notionalUsd, 0);
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

/** Close every open position AND cancel every working order — the kill-switch. */
export async function closeAllTrades(): Promise<{ closed: number; canceled: number }> {
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
  const working = tradesRepo.working().filter((t) => !t.shadow);
  let canceled = 0;
  for (const t of working) {
    try {
      await cancelWorkingTrade(t.id, "kill-switch");
      canceled++;
    } catch (err) {
      log.error(`killCancel ${t.symbol}:`, err instanceof Error ? err.message : err);
    }
  }
  event("exec", `Kill-switch: closed ${closed} positions, canceled ${canceled} working orders`, { closed, canceled }, { level: "warn" });
  return { closed, canceled };
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

async function effectiveNotional(
  group: Group,
  parsed: ParsedSignal,
  ex: ExchangeConnector,
): Promise<number> {
  const s = group.settings;
  const mode = s.sizingMode ?? "fixed";
  // Never exceed a sane multiple of the channel's own fixed size, nor the hard cap.
  const cap = Math.min(MAX_ORDER_NOTIONAL, Math.max(s.tradeSizeUsd * 10, s.tradeSizeUsd));
  const clamp = (n: number) => Math.min(Math.max(0, n), cap);

  if (mode === "percentEquity" && (s.riskValue ?? 0) > 0) {
    const pct = Math.min(s.riskValue as number, 100); // margin can't exceed 100% of equity
    try {
      const equity = (await ex.getAccountSummary())?.accountValue ?? 0;
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
        ref = await ex.getMidPrice(parsed.symbol);
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

  // Route the symbol to a venue: Hyperliquid first, then any enabled backup
  // (Aster, …) that lists it. Symbols on none are recorded FAILED (Crypto NOT
  // found); when metadata is momentarily unavailable we fall back to the primary
  // and let the order path surface any error. Uses public metadata (runs in test).
  const resolved = await resolveForSymbol(parsed.symbol);
  let ex: ExchangeConnector = hyperliquid;
  if (resolved.kind === "found") {
    ex = resolved.ex;
  } else if (resolved.kind === "notFound") {
    const venues = resolved.tried.join(", ") || "hyperliquid";
    const reason = `Crypto NOT found: ${parsed.symbol} is not listed on ${venues} (${config.tradingEnv})`;
    const failed = signalsRepo.update(signal.id, { status: "failed", error: reason })!;
    event(
      "exec",
      `SKIP ${parsed.symbol}: not listed on any venue (${venues})`,
      { symbol: parsed.symbol, tried: resolved.tried },
      { level: "warn", groupId: group.id, signalId: signal.id },
    );
    broadcast({ type: "signal", signal: failed });
    return failed;
  } // "unavailable" → keep the primary and let the order path surface errors.

  if (ex.name !== "hyperliquid") {
    event("exec", `Routing ${parsed.symbol} to ${ex.name} (not on Hyperliquid)`, { exchange: ex.name }, { groupId: group.id, signalId: signal.id });
  }

  // Position size per the group's sizing mode (against the routed venue).
  const tradeSizeUsd = await effectiveNotional(group, parsed, ex);

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

  // Limit mode (default): rest an order at the signal's entry and wait for a
  // fill — it becomes a position only when filled. Needs an entry price;
  // otherwise fall through to market.
  if ((group.settings.entryMode ?? "limit") === "limit" && parsed.entry !== undefined) {
    return executeLimit(signal, group, parsed, risk, tradeSizeUsd, ex);
  }

  // Market mode: don't chase an entry the market already ran past.
  // If the trader set an entry and the current price is already worse than it
  // (beyond maxSlippage) in the fill direction, record FAILED with the reason
  // instead of entering late at a skewed risk/reward.
  if (parsed.entry !== undefined) {
    let mid: number | undefined;
    try {
      mid = await ex.getMidPrice(parsed.symbol);
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

  const result = await ex.placeMarketOrder({
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

  return recordFilledEntry(signal, group, parsed, risk, tradeSizeUsd, ex, {
    filledPrice: result.filledPrice,
    filledSize: result.size,
    orderId: result.orderId,
    simulated: result.simulated,
  });
}

/**
 * Turn a filled entry into an open, bracket-protected position + trade record.
 * Shared by the market path and an immediately-crossing limit order.
 */
async function recordFilledEntry(
  signal: Signal,
  group: Group,
  parsed: ParsedSignal,
  risk: RiskRating | undefined,
  notionalUsd: number,
  ex: ExchangeConnector,
  fill: { filledPrice: number; filledSize: number; orderId?: string; simulated: boolean },
): Promise<Signal> {
  const entryRef = parsed.entry ?? fill.filledPrice;
  const takeProfits = expandTakeProfits(parsed.takeProfits, entryRef, parsed.side, {
    autoSplit: group.settings.autoSplitSingleTp,
    levels: group.settings.tpLevels,
  });
  // Drop a stop-loss that sits on the wrong side of the actual fill — it would
  // trigger instantly (a long's stop must be below the fill; a short's above).
  let stopLoss = parsed.stopLoss;
  if (stopLoss !== undefined) {
    const wrongSide = parsed.side === "long" ? stopLoss >= fill.filledPrice : stopLoss <= fill.filledPrice;
    if (wrongSide) {
      event("exec", `Dropping SL ${stopLoss} — wrong side of fill ${fill.filledPrice} for ${parsed.side} ${parsed.symbol}`, { stopLoss, fill: fill.filledPrice }, { level: "warn", groupId: group.id, signalId: signal.id });
      stopLoss = undefined;
    }
  }
  const bracket = await ex.placeBracketOrders({
    symbol: parsed.symbol,
    side: parsed.side,
    size: fill.filledSize,
    stopLoss,
    takeProfits,
    slippage: group.settings.maxSlippage,
  });
  if (bracket.error) {
    event("exec", `Bracket (SL/TP) placement failed for ${parsed.symbol}: ${bracket.error}`, { error: bracket.error }, { level: "warn", groupId: group.id, signalId: signal.id });
  }

  const trade = tradesRepo.create({
    signalId: signal.id,
    groupId: group.id,
    groupName: group.name,
    symbol: parsed.symbol,
    side: parsed.side,
    status: "open",
    env: config.tradingEnv,
    exchange: ex.name,
    leverage: group.settings.leverage,
    notionalUsd,
    size: fill.filledSize,
    entryPrice: fill.filledPrice,
    stopLoss,
    takeProfits: takeProfits.length ? takeProfits : undefined,
    exchangeOrderId: fill.orderId,
    slOrderId: bracket.slOrderId,
    tpOrderIds: bracket.tpOrderIds.length ? bracket.tpOrderIds : undefined,
    bracketProtected: bracket.protectedOnExchange,
    tpFilledCount: 0,
    slMovedToBreakeven: false,
    risk,
    simulated: fill.simulated,
  });

  const executed = signalsRepo.update(signal.id, { status: "executed", tradeId: trade.id })!;
  event(
    "exec",
    `Trade opened ${parsed.side} ${parsed.symbol} (${fill.simulated ? "sim" : "live"})`,
    { tradeId: trade.id, entry: trade.entryPrice, size: trade.size, protected: bracket.protectedOnExchange },
    { groupId: group.id, signalId: signal.id },
  );
  alertOpened(trade);
  broadcast({ type: "signal", signal: executed });
  broadcast({ type: "trade", trade });
  pushStats();
  return executed;
}

/**
 * Place a resting limit entry at the signal's price. Records a "working" order
 * (NOT a position); the monitor promotes it to an open position on fill, or
 * cancels it after the channel's limit timeout.
 */
async function executeLimit(
  signal: Signal,
  group: Group,
  parsed: ParsedSignal,
  risk: RiskRating | undefined,
  notionalUsd: number,
  ex: ExchangeConnector,
): Promise<Signal> {
  const entry = parsed.entry!;

  // Don't place a limit that would cross the market far beyond maxSlippage —
  // that degenerates into an unbounded market sweep at a chased price.
  try {
    const mid = await ex.getMidPrice(parsed.symbol);
    if (mid && mid > 0) {
      const tol = group.settings.maxSlippage;
      const crossesFar =
        parsed.side === "long" ? entry > mid * (1 + tol) : entry < mid * (1 - tol);
      if (crossesFar) {
        const reason = `limit entry ${entry} too far past market ${mid} (would chase)`;
        const failed = signalsRepo.update(signal.id, { status: "failed", error: reason })!;
        event("exec", `SKIP limit ${parsed.side} ${parsed.symbol}: ${reason}`, { entry, mid }, { level: "warn", groupId: group.id, signalId: signal.id });
        broadcast({ type: "signal", signal: failed });
        return failed;
      }
    }
  } catch {
    /* no price feed — proceed */
  }

  // Dedup: don't stack a second resting order for the same symbol+side.
  const dup = tradesRepo
    .working()
    .find((t) => t.groupId === group.id && t.symbol === parsed.symbol && t.side === parsed.side && !t.shadow);
  if (dup) {
    const reason = `duplicate: a working ${parsed.side} ${parsed.symbol} order already rests`;
    const ignored = signalsRepo.update(signal.id, { status: "ignored", error: reason })!;
    event("exec", `Skip duplicate working order ${parsed.symbol}`, { reason }, { level: "warn", groupId: group.id, signalId: signal.id });
    broadcast({ type: "signal", signal: ignored });
    return ignored;
  }

  const res = await ex.placeLimitOrder({
    symbol: parsed.symbol,
    side: parsed.side,
    notionalUsd,
    price: entry,
    leverage: group.settings.leverage,
    marginMode: group.settings.marginMode,
  });
  if (!res.ok) {
    const failed = signalsRepo.update(signal.id, { status: "failed", error: res.error })!;
    event("exec", `Limit order FAILED for ${parsed.symbol}: ${res.error}`, { error: res.error }, { level: "error", groupId: group.id, signalId: signal.id });
    alertError(`limit ${parsed.symbol} (${group.name})`, res.error ?? "unknown");
    broadcast({ type: "signal", signal: failed });
    return failed;
  }

  // Crossed immediately → it's a position now.
  if (res.status === "filled" && res.filledPrice) {
    return recordFilledEntry(signal, group, parsed, risk, notionalUsd, ex, {
      filledPrice: res.filledPrice,
      filledSize: res.size,
      orderId: res.orderId,
      simulated: res.simulated,
    });
  }

  // Resting → a working order (not yet a position). SL/TP are placed on fill.
  const takeProfits = expandTakeProfits(parsed.takeProfits, parsed.entry!, parsed.side, {
    autoSplit: group.settings.autoSplitSingleTp,
    levels: group.settings.tpLevels,
  });
  const trade = tradesRepo.create({
    signalId: signal.id,
    groupId: group.id,
    groupName: group.name,
    symbol: parsed.symbol,
    side: parsed.side,
    status: "working",
    env: config.tradingEnv,
    exchange: ex.name,
    leverage: group.settings.leverage,
    notionalUsd,
    size: res.size,
    entryPrice: parsed.entry!, // planned entry until filled
    stopLoss: parsed.stopLoss,
    takeProfits: takeProfits.length ? takeProfits : undefined,
    exchangeOrderId: res.orderId,
    tpFilledCount: 0,
    slMovedToBreakeven: false,
    risk,
    simulated: res.simulated,
  });
  const executed = signalsRepo.update(signal.id, { status: "executed", tradeId: trade.id })!;
  const timeoutH = group.settings.limitTimeoutHours ?? 168;
  event(
    "exec",
    `Working limit order ${parsed.side} ${parsed.symbol} @ ${parsed.entry} (${res.simulated ? "sim" : "live"}, expires in ${timeoutH}h)`,
    { tradeId: trade.id, entry: parsed.entry, size: trade.size, timeoutHours: timeoutH },
    { groupId: group.id, signalId: signal.id },
  );
  void sendAlert(
    `⏳ <b>Limit order placed</b> ${parsed.side.toUpperCase()} ${parsed.symbol} @ ${parsed.entry}\n<i>${group.name}</i> — waiting for fill`,
  );
  broadcast({ type: "signal", signal: executed });
  broadcast({ type: "trade", trade });
  pushStats();
  return executed;
}

/**
 * Promote a filled working limit order to an open, bracket-protected position.
 * Called by the monitor when the resting entry fills. Uses the `closing` guard
 * for mutual exclusion. Returns the updated trade or undefined.
 */
export async function promoteWorkingToOpen(
  tradeId: string,
  filledPrice: number,
  filledSize: number,
): Promise<Trade | undefined> {
  if (closing.has(tradeId)) return tradesRepo.get(tradeId);
  closing.add(tradeId);
  try {
    const t = tradesRepo.get(tradeId);
    if (!t || t.status !== "working") return t;
    const ex = connectorFor(t);
    const size = filledSize > 0 ? filledSize : t.size;
    const entryPrice = filledPrice > 0 ? filledPrice : t.entryPrice;
    // Defensive: cancel any residual resting entry order so it can't fill again
    // into an untracked position (real trades only).
    if (!t.simulated && ex.live && t.exchangeOrderId) {
      try {
        await ex.cancelOrders(t.symbol, [t.exchangeOrderId]);
      } catch {
        /* best-effort */
      }
    }
    const slippage = groupsRepo.get(t.groupId)?.settings.maxSlippage ?? 0.01;
    const bracket = await ex.placeBracketOrders({
      symbol: t.symbol,
      side: t.side,
      size,
      stopLoss: t.stopLoss,
      takeProfits: t.takeProfits ?? [],
      slippage,
      force: !t.simulated, // real brackets only for a real position — never in test mode
    });
    const updated = tradesRepo.update(tradeId, {
      status: "open",
      entryPrice,
      size,
      notionalUsd: entryPrice * size, // reflect the ACTUAL filled notional
      slOrderId: bracket.slOrderId,
      tpOrderIds: bracket.tpOrderIds.length ? bracket.tpOrderIds : undefined,
      bracketProtected: bracket.protectedOnExchange,
    });
    if (updated) {
      event("exec", `Limit filled → opened ${t.side} ${t.symbol} @ ${updated.entryPrice}`, { tradeId, protected: bracket.protectedOnExchange }, { groupId: t.groupId });
      alertOpened(updated);
      broadcast({ type: "trade", trade: updated });
      pushStats();
    }
    return updated;
  } finally {
    closing.delete(tradeId);
  }
}

/** Cancel an expired/aborted working limit order. Guarded against a concurrent promote. */
export async function cancelWorkingTrade(tradeId: string, reason: string): Promise<void> {
  if (closing.has(tradeId)) return; // a promote/close is in flight — don't clobber it
  closing.add(tradeId);
  try {
    const t = tradesRepo.get(tradeId);
    if (!t || t.status !== "working") return; // re-checked under the guard
    if (!t.simulated && connectorFor(t).live && t.exchangeOrderId) {
      try {
        await connectorFor(t).cancelOrders(t.symbol, [t.exchangeOrderId]);
      } catch (err) {
        log.warn(`cancelWorking ${t.symbol}:`, err instanceof Error ? err.message : err);
      }
    }
    const updated = tradesRepo.update(tradeId, { status: "canceled", error: reason });
    if (updated) {
      event("exec", `Working order canceled (${reason}) ${t.side} ${t.symbol}`, { tradeId }, { level: "warn", groupId: t.groupId });
      broadcast({ type: "trade", trade: updated });
      pushStats();
    }
  } finally {
    closing.delete(tradeId);
  }
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
    if (!asset) return { ok: false, error: `Crypto NOT found: ${symbol} is not listed on Hyperliquid ${config.tradingEnv} perps` };
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
    exchange: hyperliquid.name,
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
    const ex = connectorFor(trade);
    let exitPrice = exitPriceOverride;
    if (exitPrice === undefined || exitPrice <= 0) {
      let mid: number | undefined;
      try {
        mid = await ex.getMidPrice(trade.symbol);
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
      await ex.cancelOrders(trade.symbol, restingIds);
    }

    // Portion already scaled out at TP levels vs the remainder we now close.
    const tps = trade.takeProfits ?? [];
    const n = tps.length;
    const fraction = n > 0 ? 1 / n : 0;
    const tpFilled = Math.min(trade.tpFilledCount ?? 0, n);
    const remainingFraction = Math.max(0, 1 - tpFilled * fraction);
    const remainingSize = remainingFraction * trade.size;

    if (!trade.simulated && ex.live && remainingSize > 0) {
      const result = await ex.placeMarketOrder({
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
