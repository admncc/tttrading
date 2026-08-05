import type { ExchangeName, Group, ParsedSignal, RiskRating, Signal, Trade, TradeSide } from "@tttrading/shared";
import { config } from "../config.js";
import { log, event } from "../logger.js";
import {
  groups as groupsRepo,
  signals as signalsRepo,
  trades as tradesRepo,
  settings as settingsRepo,
} from "../db/repositories.js";
import { activeHyperliquid, byName, known, resolveAllForSymbol, resolveForSymbol } from "../exchanges/registry.js";
import type { ExchangeConnector } from "../exchanges/types.js";
import { parseSignal } from "../signals/parser.js";
import { readManagementLevels, type SignalImage } from "../signals/llm.js";
import { classifyManagementAll, isTradeUpdate, type ManagementAction } from "../signals/management.js";
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
export async function handleIncoming(group: Group, rawText: string, images?: SignalImage[]): Promise<Signal> {
  const imgs = (images ?? []).filter(Boolean);
  const primary = imgs[0];
  const preview = rawText.replace(/\s+/g, " ").trim().slice(0, 160);
  event("message", `Incoming from ${group.name}${primary ? ` (with ${imgs.length} chart image${imgs.length > 1 ? "s" : ""})` : ""}`, {
    channel: group.telegramChannel,
    length: rawText.length,
    hasImage: !!primary,
    imageCount: imgs.length,
    preview,
  }, { groupId: group.id });

  const parsed = await parseSignal(rawText, group.settings.instructions, imgs);

  // A progress UPDATE about an existing trade ("$UNI Trade Update … my stop is now
  // at breakeven … up 7%") must never open a NEW position, even when the LLM reads
  // the attached chart as a fresh long/short. Route it to management instead.
  const tradeUpdate = isTradeUpdate(rawText);
  if (parsed && parsed.confidence >= ACT_THRESHOLD && tradeUpdate) {
    event(
      "message",
      `Parsed as ${parsed.side.toUpperCase()} ${parsed.symbol} but message is a trade UPDATE — not opening a new position`,
      { source: parsed.source, confidence: parsed.confidence, symbol: parsed.symbol },
      { level: "warn", groupId: group.id },
    );
  }

  if (!parsed || parsed.confidence < ACT_THRESHOLD || tradeUpdate) {
    // Not a fresh entry — maybe it's one or more trade-management updates (SL
    // move, partial, close, cancel-limit) for existing positions/orders.
    let actions = classifyManagementAll(rawText);
    // With an attached chart (vision on), let the LLM read levels the text omits
    // — e.g. a stop moved to a price only drawn on the chart — and merge them in.
    if (primary) {
      try {
        const mv = await readManagementLevels(rawText, group.settings.instructions, imgs);
        if (mv?.isManagement && mv.confidence >= 0.5) {
          const kinds = new Set(actions.map((a) => a.kind));
          const extra: ManagementAction[] = [];
          if (mv.closed && !kinds.has("close")) extra.push({ kind: "close", symbol: mv.symbol, note: "chart: closed" });
          // The stop-move / partial / break-even extras require an EXPLICIT
          // symbol from the chart — without one they'd fall back to the sole open
          // position and could act on the wrong coin the chart actually showed.
          if (mv.symbol) {
            if (mv.newStop !== undefined && !kinds.has("sl_move"))
              extra.push({ kind: "sl_move", symbol: mv.symbol, newStop: mv.newStop, note: `chart: SL to ${mv.newStop}` });
            if (mv.breakeven && !kinds.has("sl_breakeven") && !kinds.has("partial_close"))
              extra.push({ kind: "sl_breakeven", symbol: mv.symbol, note: "chart: SL to break-even" });
            if (mv.partialPercent !== undefined && mv.partialPercent > 0 && mv.partialPercent < 100 && !kinds.has("partial_close"))
              extra.push({ kind: "partial_close", symbol: mv.symbol, fraction: mv.partialPercent / 100, note: `chart: book ${mv.partialPercent}%` });
          }
          if (extra.length) actions = [...actions, ...extra];
        }
      } catch (err) {
        log.warn("Management vision read failed:", err instanceof Error ? err.message : err);
      }
    }
    if (actions.length > 0) {
      const managed = await applyManagement(group, rawText, actions);
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
      marginMode: groupsRepo.get(trade.groupId)?.settings.marginMode,
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
    // Base the fraction on the ACTUAL live position, not trade.size: a TP
    // scale-out bumps tpFilledCount but does NOT decrement trade.size, so
    // booking "50%" off the stale size would close more than half of what's
    // really left. Fall back to trade.size if the position can't be read.
    let base = trade.size;
    if (!trade.simulated && ex.live) {
      try {
        const positions = await ex.getPositions();
        const pos = positions.find(
          (p) =>
            p.symbol.toUpperCase() === trade.symbol.toUpperCase() &&
            p.size !== 0 &&
            (trade.side === "long" ? p.size > 0 : p.size < 0),
        );
        if (pos && Math.abs(pos.size) > 0) base = Math.abs(pos.size);
      } catch {
        /* fall back to the recorded size */
      }
    }
    const intendedSize = base * frac;
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
    const remaining = Math.max(0, base - closedSize);

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

    // Re-size the resting protective orders to the REMAINING position. A partial
    // otherwise leaves the SL/TP legs at the old (larger) size — harmless because
    // they're reduce-only, but it misreads on the desk (a TP showing 253 on a 127
    // position). Place fresh legs first, then cancel the stale ones, so there's
    // never a moment without protection.
    if (!trade.simulated && ex.live && remaining > 0) {
      const oldIds = [trade.slOrderId, ...(trade.tpOrderIds ?? [])].filter((x): x is string => !!x);
      const unfilledTps = (trade.takeProfits ?? []).slice(trade.tpFilledCount ?? 0);
      const hasProtection = trade.stopLoss !== undefined || unfilledTps.length > 0;
      if (oldIds.length > 0 && hasProtection) {
        try {
          const bracket = await ex.placeBracketOrders({
            symbol: trade.symbol,
            side: trade.side,
            size: remaining,
            stopLoss: trade.stopLoss,
            takeProfits: unfilledTps,
            slippage: 0.01,
            marginMode: groupsRepo.get(trade.groupId)?.settings.marginMode,
            force: true,
          });
          // Only cancel the old legs once the REPLACEMENTS we intended actually
          // confirmed — never drop a live SL because a TP was rejected (or vice
          // versa). If either half didn't confirm, keep the old legs (reduce-only,
          // so a brief duplicate can't over-close) rather than strip protection.
          const slOk = trade.stopLoss === undefined || bracket.slOrderId !== undefined;
          const tpOk = unfilledTps.length === 0 || bracket.tpOrderIds.length > 0;
          if (slOk && tpOk) {
            await ex.cancelOrders(trade.symbol, oldIds);
            const updated = tradesRepo.update(trade.id, {
              slOrderId: bracket.slOrderId,
              tpOrderIds: bracket.tpOrderIds.length ? bracket.tpOrderIds : undefined,
            });
            if (updated) broadcast({ type: "trade", trade: updated });
          } else {
            log.warn(
              `partialClose: bracket re-size for ${trade.symbol} only partially confirmed (sl=${!!bracket.slOrderId}, tps=${bracket.tpOrderIds.length}/${unfilledTps.length}) — keeping the old legs so protection isn't dropped.`,
            );
          }
        } catch (err) {
          log.warn(
            `partialClose: failed to re-size brackets for ${trade.symbol}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  } finally {
    closing.delete(id);
  }
}

/**
 * Resolve a management action's target symbol: the one the classifier tagged
 * ($BTC/#BTC/BTC-USDT), else derived by matching the message against the coins
 * the group actually HOLDS (case-insensitive) — so a bare "Btc moving nicely…
 * move SL to 62000" binds to the open BTC position. Precise: only ever matches a
 * symbol we truly have a position/order in, so unrelated chatter can't select one.
 */
function deriveSymbol(
  action: ManagementAction,
  held: string[],
  rawText: string,
): { sym?: string; named: string[] } {
  if (action.symbol) {
    const s = action.symbol.toUpperCase();
    return { sym: s, named: [s] };
  }
  // Derive from held coins named in the text — but ONLY tickers ≥3 chars, so
  // short word-like symbols (ME, OP, ID, BE, GO) can't match ordinary English
  // ("book 50% for me"). Two-char coins must be tagged ($OP) or be the sole
  // managed position (the single-position fallback in applyManagement handles that).
  const named = held.filter((c) => {
    const clean = c.replace(/[^A-Z0-9]/g, "");
    return clean.length >= 3 && new RegExp(`\\b${clean}\\b`, "i").test(rawText);
  });
  // Only resolve to a symbol when the text names EXACTLY one held coin. Naming
  // several (a status recap) is ambiguous — the caller must not guess one.
  return { sym: named.length === 1 ? named[0] : undefined, named };
}

/**
 * Apply one or more trade-management intents from a single message to the group's
 * matching positions/orders. Records ONE "managed" signal summarizing all of
 * them. Returns null only when the group is disabled (caller falls through).
 */
async function applyManagement(
  group: Group,
  rawText: string,
  actions: ManagementAction[],
): Promise<Signal | null> {
  // Don't let messages manage positions of a channel the operator disabled.
  if (!group.enabled) return null;

  const results: string[] = [];
  let acted = false;

  for (const action of actions) {
    // Re-read state per action — an earlier action (e.g. cancel_limit) may have
    // changed what's open/working.
    const openForGroup = tradesRepo.open().filter((t) => t.groupId === group.id && !t.shadow);
    const groupWorking = tradesRepo.working().filter((t) => t.groupId === group.id && !t.shadow);
    const held = [...new Set([...openForGroup, ...groupWorking].map((t) => t.symbol.toUpperCase()))];
    const { sym, named } = deriveSymbol(action, held, rawText);

    // A status RECAP that names several held coins ("1. BTC … SL breakeven 2. SOL
    // active … 6. PENGU active") must never fire a position change: a single
    // SL/close/partial can't be attributed to one of them. Skip and record why —
    // rather than guess a symbol and act on the wrong trade.
    if (!action.symbol && named.length > 1) {
      results.push(
        `${action.note} — message names ${named.length} open symbols (${named.join(", ")}); ambiguous recap, not acting`,
      );
      continue;
    }

    // Cancel a still-RESTING limit ENTRY order — never touches an open position.
    if (action.kind === "cancel_limit") {
      const targetsW = sym
        ? groupWorking.filter((t) => t.symbol.toUpperCase() === sym)
        : groupWorking.length === 1
          ? groupWorking
          : [];
      if (targetsW.length === 0) {
        results.push(`cancel limit — no ${sym ?? ""} working order`.replace(/\s+/g, " ").trim());
        continue;
      }
      for (const w of targetsW) {
        await cancelWorkingTrade(w.id, `management: ${action.note}`);
        acted = true;
      }
      results.push(`canceled ${targetsW.length} working ${sym ?? ""} order(s)`.replace(/\s+/g, " ").trim());
      continue;
    }

    // SL move / break-even may also target a still-resting limit order (updating
    // its planned stop). Partial/close/tp only apply to an already-open position.
    const slKind = action.kind === "sl_move" || action.kind === "sl_breakeven";
    const manageable = slKind ? [...openForGroup, ...groupWorking] : openForGroup;
    // Only a full `close` REQUIRES an explicit/derived symbol — stray chatter must
    // never flatten a position. Others may fall back to the single managed position.
    const requireExplicitSymbol = action.kind === "close";
    const targets = sym
      ? manageable.filter((t) => t.symbol.toUpperCase() === sym)
      : !requireExplicitSymbol && manageable.length === 1
        ? manageable
        : [];

    // A `close` should also cancel a still-resting limit for that symbol.
    if (action.kind === "close" && sym) {
      for (const w of groupWorking.filter((t) => t.symbol.toUpperCase() === sym)) {
        await cancelWorkingTrade(w.id, `management: ${action.note}`);
        acted = true;
      }
    }

    if (targets.length === 0) {
      const ambiguous = !sym && manageable.length > 1;
      results.push(
        ambiguous
          ? `${action.note} — ${manageable.length} open (${manageable.map((t) => t.symbol).join(", ")}); name the symbol`
          : `${action.note} — no open ${sym ?? ""} position`.replace(/\s+/g, " ").trim(),
      );
      continue;
    }

    for (const t of targets) {
      if (action.kind === "close") {
        await closeTrade(t.id);
      } else if (action.kind === "sl_breakeven") {
        await moveStop(t, t.entryPrice, true);
      } else if (action.kind === "sl_move" && action.newStop !== undefined) {
        // Accept a stop only on the PROTECTIVE side of the market (long below,
        // short above) — else reject, so "SL to 999999" can't force a stop-out.
        let price = t.entryPrice;
        try {
          const mid = await connectorFor(t).getMidPrice(t.symbol);
          if (mid && mid > 0) price = mid;
        } catch {
          /* use entry as the reference */
        }
        // Protective side AND a plausible magnitude: a real stop sits within
        // ~50% of the current price. This rejects a garbage number scraped from
        // prose (e.g. "3R locked in" → newStop 3 while price is 64000), which
        // would otherwise pass the side check for a long and strip protection.
        const plausible = action.newStop >= price * 0.5 && action.newStop <= price * 1.5;
        const rightSide = t.side === "long" ? action.newStop < price : action.newStop > price;
        if (plausible && rightSide) await moveStop(t, action.newStop, false);
        else {
          const why = !plausible ? "implausible distance" : "wrong side";
          event("manage", `Rejected SL move for ${t.symbol}: ${action.newStop} (${why} vs ${price})`, { newStop: action.newStop, price, side: t.side }, { level: "warn", groupId: group.id });
          results.push(`SL ${action.newStop} rejected (${why}) for ${t.symbol}`);
          continue;
        }
      } else if (action.kind === "partial_close") {
        // Explicit % from the message, else the group's default partial fraction.
        const frac = action.fraction ?? Math.min(0.95, Math.max(0.01, (group.settings.defaultPartialPct ?? 50) / 100));
        await partialClose(t, frac);
        if (action.alsoBreakeven) {
          const fresh = tradesRepo.get(t.id);
          if (fresh) await moveStop(fresh, fresh.entryPrice, true);
        }
      } else if (action.kind === "tp_hit") {
        if (t.simulated) {
          const cap = t.takeProfits?.length ?? 0;
          const next = Math.min((t.tpFilledCount ?? 0) + 1, cap || (t.tpFilledCount ?? 0) + 1);
          tradesRepo.update(t.id, { tpFilledCount: next });
        }
      }
      acted = true;
      const u = tradesRepo.get(t.id);
      if (u) broadcast({ type: "trade", trade: u });
    }
    results.push(`${action.note} → ${targets.map((t) => t.symbol).join(", ")}`);
  }

  const signal = signalsRepo.create({
    groupId: group.id,
    groupName: group.name,
    rawText,
    status: "managed",
    error: results.join(" | "),
  });
  event(
    "manage",
    `Managed (${actions.map((a) => a.kind).join(", ")}): ${results.join(" | ")}`,
    { kinds: actions.map((a) => a.kind), acted },
    { groupId: group.id, signalId: signal.id },
  );
  broadcast({ type: "signal", signal });
  if (acted) pushStats();
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
  const ex = resolved.kind === "found" ? resolved.ex : activeHyperliquid();
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
  const resolved = await resolveAllForSymbol(parsed.symbol);
  let ex: ExchangeConnector = activeHyperliquid();
  if (resolved.kind === "found") {
    let venues = resolved.venues;
    // Conflict policy: if a venue already holds an OPPOSING position for this
    // symbol, prefer the next backup that lists it and has none — so a long on
    // the primary and a later short go to different venues instead of netting.
    if (settingsRepo.getSplitOpposingVenues()) {
      const opposing = tradesRepo
        .activeAndWorking()
        .filter((t) => !t.shadow && t.symbol.toUpperCase() === parsed.symbol.toUpperCase() && t.side !== parsed.side);
      if (opposing.length > 0) {
        const busy = new Set(opposing.map((t) => byName(t.exchange).name));
        const free = venues.filter((v) => !busy.has(v.ex.name));
        if (free.length === 0) {
          const reason = `conflict: an opposing ${parsed.symbol} position is already open on every venue that lists it (${venues
            .map((v) => v.ex.name)
            .join(", ")})`;
          const failed = signalsRepo.update(signal.id, { status: "failed", error: reason })!;
          event("exec", `SKIP ${parsed.side} ${parsed.symbol}: opposing position, no free venue`, { reason }, { level: "warn", groupId: group.id, signalId: signal.id });
          broadcast({ type: "signal", signal: failed });
          return failed;
        }
        venues = free;
      }
    }
    ex = venues[0]!.ex;
  } else if (resolved.kind === "notFound") {
    const tried = resolved.tried.join(", ") || "hyperliquid";
    const reason = `Crypto NOT found: ${parsed.symbol} is not listed on ${tried} (${config.tradingEnv})`;
    const failed = signalsRepo.update(signal.id, { status: "failed", error: reason })!;
    event(
      "exec",
      `SKIP ${parsed.symbol}: not listed on any venue (${tried})`,
      { symbol: parsed.symbol, tried: resolved.tried },
      { level: "warn", groupId: group.id, signalId: signal.id },
    );
    broadcast({ type: "signal", signal: failed });
    return failed;
  } // "unavailable" → keep the primary and let the order path surface errors.

  if (ex.name !== "hyperliquid" && ex.name !== "hyperliquid-testnet") {
    event("exec", `Routing ${parsed.symbol} to ${ex.name}`, { exchange: ex.name }, { groupId: group.id, signalId: signal.id });
  }

  // Scale-in: a signal with several entry zones becomes one FULL-size order per
  // leg, all sharing this signal, stop-loss and take-profits. A single entry
  // takes the normal path.
  if (parsed.entries && parsed.entries.length > 1) {
    return executeScaleIn(signal, group, parsed, risk, ex, parsed.entries);
  }
  return placeEntry(signal, group, parsed, risk, ex);
}

/** Leg context when placing one entry of a multi-entry scale-in. */
interface LegCtx {
  index: number;
  total: number;
  mode: "market" | "limit";
}

/**
 * Snap a price level to the SAME order of magnitude as a reference price by the
 * nearest power of 10 — a decimal-typo corrector. E.g. with ref ~0.08, an SL of
 * 0.725 → 0.0725 and a TP of 0.84 → 0.084. Only genuine order-of-magnitude slips
 * (≳5× off) are touched; anything within ~0.2×–5× of the reference (normal stops
 * and even aggressive targets) is returned unchanged, so real levels are safe.
 */
function snapMagnitude(level: number, ref: number): number {
  if (!(level > 0) || !(ref > 0)) return level;
  const decades = Math.log10(ref / level);
  if (Math.abs(decades) < 0.7) return level; // within ~5× — leave as written
  const k = Math.round(decades);
  if (k === 0) return level;
  return Number((level * 10 ** k).toPrecision(12)); // trim float dust
}

/**
 * Place a single entry (a whole single-entry signal, or one leg of a scale-in)
 * and record the resulting trade: sizing, risk gate, collateral check, then the
 * limit or market path. `leg` is set only for scale-in legs — it forces that
 * leg's entry mode and relaxes the working-order dedup so intentional legs at
 * different prices aren't rejected as duplicates.
 */
async function placeEntry(
  signal: Signal,
  group: Group,
  parsed: ParsedSignal,
  risk: RiskRating | undefined,
  ex: ExchangeConnector,
  leg?: LegCtx,
): Promise<Signal> {
  const { leverage, marginMode, maxSlippage } = group.settings;

  // Position size per the group's sizing mode (against the routed venue).
  let tradeSizeUsd = await effectiveNotional(group, parsed, ex);

  // Live-order safety cap: clamp the notional of any REAL (non-simulated) order
  // to the global ceiling. Testnet/paper/shadow orders simulate and are exempt.
  // Lets you validate mainnet (or Aster/MEXC) with tiny size before scaling up.
  const liveCap = settingsRepo.getGlobalSettings().liveMaxOrderUsd;
  if (liveCap > 0 && !ex.simulating() && tradeSizeUsd > liveCap) {
    event(
      "exec",
      `Capping real order ${parsed.symbol} on ${ex.name}: ${tradeSizeUsd.toFixed(0)} → ${liveCap} (live-order limit)`,
      { requested: tradeSizeUsd, cap: liveCap, venue: ex.name },
      { level: "warn", groupId: group.id, signalId: signal.id },
    );
    tradeSizeUsd = liveCap;
  }

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

  // Pre-route collateral check: a real order on the routed venue needs enough
  // free margin. Skip in sim (no real order) and when the balance can't be read
  // (don't block on a transient error — let the order path surface it).
  if (!ex.simulating()) {
    try {
      // Pass the symbol so HL reads the right collateral pot (HIP-3 builder dexs
      // have separate per-dex balances).
      const summary = await ex.getAccountSummary(parsed.symbol);
      if (summary) {
        const needMargin = tradeSizeUsd / Math.max(1, group.settings.leverage);
        if (summary.withdrawable < needMargin * 0.99) {
          const reason = `insufficient collateral on ${ex.name}: need ~${needMargin.toFixed(2)} free, have ${summary.withdrawable.toFixed(2)}`;
          const failed = signalsRepo.update(signal.id, { status: "failed", error: reason })!;
          event("exec", `SKIP ${parsed.symbol}: ${reason}`, { need: needMargin, have: summary.withdrawable, venue: ex.name }, { level: "warn", groupId: group.id, signalId: signal.id });
          alertError(`collateral ${parsed.symbol} (${group.name})`, reason);
          broadcast({ type: "signal", signal: failed });
          return failed;
        }
      }
    } catch {
      /* balance unreadable — don't block; the order path will surface any error */
    }
  }

  // Decimal-typo safety net + wrong-side stop guard. First CONSISTENTLY snap the
  // SL and EVERY TP to the entry's (or live mid's) order of magnitude, so a
  // channel that writes "SL 0.725, Tp 0.84" for a coin trading ~0.08 becomes
  // SL 0.0725 AND TP 0.084 — never a half-fix that leaves the targets 10× off.
  // Then, if the (normalized) stop is still on the wrong side, it's a real error,
  // not a decimal slip — reject rather than enter a position we can't protect.
  {
    let ref = parsed.entry;
    if (ref === undefined) {
      try {
        ref = await ex.getMidPrice(parsed.symbol);
      } catch {
        /* no price feed — can't normalize or side-check; let the order path handle it */
      }
    }
    if (ref && ref > 0) {
      const fixes: string[] = [];
      const sl = parsed.stopLoss !== undefined ? snapMagnitude(parsed.stopLoss, ref) : undefined;
      if (sl !== undefined && sl !== parsed.stopLoss) fixes.push(`SL ${parsed.stopLoss}→${sl}`);
      const tps = parsed.takeProfits?.map((t) => snapMagnitude(t, ref!));
      if (tps && parsed.takeProfits && tps.some((t, i) => t !== parsed.takeProfits![i])) {
        fixes.push(`TP [${parsed.takeProfits.join(", ")}]→[${tps.join(", ")}]`);
      }
      if (fixes.length) {
        parsed = { ...parsed, stopLoss: sl, takeProfits: tps };
        event(
          "exec",
          `Decimal-normalized ${parsed.symbol} to price ~${ref}: ${fixes.join("; ")}`,
          { ref, fixes },
          { level: "warn", groupId: group.id, signalId: signal.id },
        );
      }

      if (parsed.stopLoss !== undefined) {
        const wrongSide = parsed.side === "long" ? parsed.stopLoss >= ref : parsed.stopLoss <= ref;
        if (wrongSide) {
          const reason = `SL ${parsed.stopLoss} on the wrong side of price ${ref} for a ${parsed.side} — likely a mis-scaled signal; not entering`;
          const failed = signalsRepo.update(signal.id, { status: "failed", error: reason })!;
          event("exec", `SKIP ${parsed.side} ${parsed.symbol}: ${reason}`, { stopLoss: parsed.stopLoss, ref, side: parsed.side }, { level: "warn", groupId: group.id, signalId: signal.id });
          alertError(`SL side ${parsed.symbol} (${group.name})`, reason);
          broadcast({ type: "signal", signal: failed });
          return failed;
        }
      }
    }
  }

  // Limit mode (default): rest an order at the signal's entry and wait for a
  // fill — it becomes a position only when filled. Needs an entry price;
  // otherwise fall through to market.
  const mode = leg?.mode ?? (group.settings.entryMode ?? "limit");
  if (mode === "limit" && parsed.entry !== undefined) {
    return executeLimit(signal, group, parsed, risk, tradeSizeUsd, ex, leg);
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
 * Scale-in: place one FULL-size order per entry leg, sequentially, on the same
 * venue. Each leg is a market order (cmp) or a resting limit at its price, and
 * every leg shares this signal's stop-loss + take-profits. Legs are placed in
 * order so the per-leg risk gate (max open trades / max exposure) sees the
 * capital already reserved by earlier legs — that is the guard that stops a
 * scale-in from blowing the exposure budget: once it's hit, the remaining legs
 * are skipped, not forced. The signal's final status reflects what actually got
 * placed.
 */
async function executeScaleIn(
  signal: Signal,
  group: Group,
  parsed: ParsedSignal,
  risk: RiskRating | undefined,
  ex: ExchangeConnector,
  legs: NonNullable<ParsedSignal["entries"]>,
): Promise<Signal> {
  event(
    "exec",
    `Scale-in: ${legs.length} entries for ${parsed.side} ${parsed.symbol}`,
    { legs: legs.map((l) => ({ price: l.price, mode: l.mode })) },
    { groupId: group.id, signalId: signal.id },
  );

  const legErrors: string[] = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const mode: "market" | "limit" = leg.mode === "market" ? "market" : "limit";
    // A market/cmp leg enters now (no entry price → no missed-entry guard); a
    // limit leg rests at its price. Drop the scale-in list on the per-leg copy.
    const legParsed: ParsedSignal = {
      ...parsed,
      entries: undefined,
      entry: mode === "market" ? undefined : leg.price,
    };
    if (mode === "limit" && legParsed.entry === undefined) {
      legErrors.push(`leg ${i + 1}: limit entry without a price`);
      continue;
    }
    try {
      await placeEntry(signal, group, legParsed, risk, ex, { index: i, total: legs.length, mode });
    } catch (err) {
      legErrors.push(`leg ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      log.error(`scale-in leg ${i + 1} for ${parsed.symbol} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // Final status from the trades actually created for this signal (each leg
  // persists its own trade regardless of how the others fared).
  const placed = tradesRepo.forSignal(signal.id).filter((t) => !t.shadow);
  if (placed.length > 0) {
    const note =
      legErrors.length || placed.length < legs.length
        ? `scale-in: ${placed.length}/${legs.length} legs placed${legErrors.length ? ` — ${legErrors.join("; ")}` : " (others gated/blocked)"}`
        : undefined;
    const updated = signalsRepo.update(signal.id, { status: "executed", tradeId: placed[0]!.id, error: note })!;
    event(
      "exec",
      `Scale-in placed ${placed.length}/${legs.length} legs for ${parsed.side} ${parsed.symbol}`,
      { placed: placed.length, total: legs.length, errors: legErrors },
      { groupId: group.id, signalId: signal.id, level: legErrors.length ? "warn" : "info" },
    );
    broadcast({ type: "signal", signal: updated });
    return updated;
  }

  const reason = legErrors.join("; ") || "scale-in: no legs placed";
  const failed = signalsRepo.update(signal.id, { status: "failed", error: reason })!;
  event("exec", `Scale-in FAILED for ${parsed.symbol}: ${reason}`, { errors: legErrors }, { level: "error", groupId: group.id, signalId: signal.id });
  broadcast({ type: "signal", signal: failed });
  return failed;
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
    marginMode: group.settings.marginMode,
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
    signalEntry: parsed.entry,
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
  leg?: LegCtx,
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

  // Dedup: don't stack a second resting order for the same symbol+side — UNLESS
  // this is an intentional scale-in leg (multiple legs at different prices).
  const dup = leg
    ? undefined
    : tradesRepo
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
    const gset = groupsRepo.get(t.groupId)?.settings;
    const slippage = gset?.maxSlippage ?? 0.01;
    const bracket = await ex.placeBracketOrders({
      symbol: t.symbol,
      side: t.side,
      size,
      stopLoss: t.stopLoss,
      takeProfits: t.takeProfits ?? [],
      slippage,
      marginMode: gset?.marginMode,
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
      alertOpened(updated, true);
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

/* ------------------------- manual desk management ---------------------- */

/** Manually set/move a trade's stop-loss from the desk (open or resting). */
export async function setTradeStop(
  tradeId: string,
  price: number,
): Promise<{ ok: boolean; error?: string; trade?: Trade }> {
  const trade = tradesRepo.get(tradeId);
  if (!trade) return { ok: false, error: "not found" };
  if (trade.shadow) return { ok: false, error: "shadow trade" };
  if (trade.status !== "open" && trade.status !== "working") return { ok: false, error: "trade not open" };
  if (!(price > 0)) return { ok: false, error: "price must be > 0" };
  // Reject a stop on the wrong side of the market (long below, short above),
  // measured against the live mid (fall back to entry) — mirrors the message path.
  let ref = trade.entryPrice;
  try {
    const mid = await connectorFor(trade).getMidPrice(trade.symbol);
    if (mid && mid > 0) ref = mid;
  } catch {
    /* use entry */
  }
  const ok = trade.side === "long" ? price < ref : price > ref;
  if (!ok) return { ok: false, error: `stop ${price} is on the wrong side of ${ref} for a ${trade.side}` };
  await moveStop(trade, price, false);
  event("manage", `Desk set SL ${price} for ${trade.symbol}`, { price }, { groupId: trade.groupId });
  return { ok: true, trade: tradesRepo.get(tradeId) };
}

/** Manually book a fraction (0..0.95) of an open trade from the desk. */
export async function bookTradePartial(
  tradeId: string,
  fraction: number,
): Promise<{ ok: boolean; error?: string; trade?: Trade }> {
  const trade = tradesRepo.get(tradeId);
  if (!trade) return { ok: false, error: "not found" };
  if (trade.shadow) return { ok: false, error: "shadow trade" };
  if (trade.status !== "open") return { ok: false, error: "trade not open" };
  if (!(fraction > 0 && fraction < 1)) return { ok: false, error: "fraction must be between 0 and 1" };
  await partialClose(trade, fraction);
  event("manage", `Desk booked ${(fraction * 100).toFixed(0)}% of ${trade.symbol}`, { fraction }, { groupId: trade.groupId });
  return { ok: true, trade: tradesRepo.get(tradeId) };
}

/** Manually replace a trade's take-profit levels from the desk. */
export async function setTradeTakeProfits(
  tradeId: string,
  prices: number[],
): Promise<{ ok: boolean; error?: string; trade?: Trade }> {
  const trade = tradesRepo.get(tradeId);
  if (!trade) return { ok: false, error: "not found" };
  if (trade.shadow) return { ok: false, error: "shadow trade" };
  if (trade.status !== "open" && trade.status !== "working") return { ok: false, error: "trade not open" };
  // Keep only TPs on the profit side (long above entry, short below).
  const tps = prices
    .filter((p) => p > 0 && (trade.side === "long" ? p > trade.entryPrice : p < trade.entryPrice))
    .sort((a, b) => (trade.side === "long" ? a - b : b - a));

  const ex = connectorFor(trade);
  // Real open position: replace the resting TP orders on the exchange.
  if (trade.status === "open" && !trade.simulated && ex.live) {
    const bracket = await ex.placeBracketOrders({
      symbol: trade.symbol,
      side: trade.side,
      size: trade.size,
      takeProfits: tps,
      slippage: 0.01,
      marginMode: groupsRepo.get(trade.groupId)?.settings.marginMode,
      force: true,
    });
    if (tps.length > 0 && !bracket.protectedOnExchange) {
      return { ok: false, error: `TP placement failed: ${bracket.error ?? "unknown"}` };
    }
    if (trade.tpOrderIds?.length) await ex.cancelOrders(trade.symbol, trade.tpOrderIds);
    const updated = tradesRepo.update(tradeId, {
      takeProfits: tps.length ? tps : undefined,
      tpOrderIds: bracket.tpOrderIds.length ? bracket.tpOrderIds : undefined,
      tpFilledCount: 0,
    });
    if (updated) broadcast({ type: "trade", trade: updated });
    event("manage", `Desk set TPs [${tps.join(", ")}] for ${trade.symbol}`, { tps }, { groupId: trade.groupId });
    return { ok: true, trade: updated };
  }
  // Simulated or resting order: just record the levels.
  const updated = tradesRepo.update(tradeId, { takeProfits: tps.length ? tps : undefined, tpFilledCount: 0 });
  if (updated) broadcast({ type: "trade", trade: updated });
  event("manage", `Desk set TPs [${tps.join(", ")}] for ${trade.symbol}`, { tps }, { groupId: trade.groupId });
  return { ok: true, trade: updated };
}

/**
 * On-demand reconcile of a single trade against its exchange ("Sync" button).
 * Reads the live position on the trade's venue and compares it to the desk's
 * record:
 *  - Desk says closed/failed but the position is STILL open on the exchange
 *    (e.g. a monitor false-close after a network switch, or a wrong-address
 *    read) → flip it back to OPEN so the bot manages it again, adopting the
 *    exchange's real size/entry.
 *  - Desk says open and the exchange agrees → confirm (no change).
 *  - Desk says open but the exchange is flat → report it; leave the actual
 *    close to the monitor/close path (never fabricate an exit here).
 * Only meaningful for real trades on a venue that can currently read positions.
 */
export async function syncTrade(
  tradeId: string,
): Promise<{ ok: boolean; error?: string; changed?: boolean; live?: boolean; venue?: string; trade?: Trade }> {
  const trade = tradesRepo.get(tradeId);
  if (!trade) return { ok: false, error: "not found" };
  if (trade.shadow || trade.simulated) return { ok: false, error: "not a real trade" };

  // Search the trade's OWN venue first, then every other venue that can read
  // positions. This also re-homes a MIS-TAGGED trade: e.g. a signal recorded as
  // "hyperliquid-testnet" whose order actually filled on mainnet — Sync finds it
  // on mainnet and moves the trade there so it reconciles against reality.
  const own = connectorFor(trade);
  const candidates = [own, ...known().filter((e) => e !== own)];
  let found: { ex: ExchangeConnector; pos: { size: number; entryPrice: number } } | undefined;
  let readAny = false;
  for (const ex of candidates) {
    let positions;
    try {
      positions = await ex.getPositions(); // read-only where a key/address exists
    } catch {
      continue;
    }
    readAny = true;
    const pos = positions.find(
      (p) =>
        p.symbol.toUpperCase() === trade.symbol.toUpperCase() &&
        p.size !== 0 &&
        (trade.side === "long" ? p.size > 0 : p.size < 0),
    );
    if (pos) {
      found = { ex, pos };
      break;
    }
  }

  if (!found) {
    if (!readAny) {
      return { ok: false, error: "no venue could read positions (no key / no read address configured)" };
    }
    return { ok: true, changed: false, live: false, trade };
  }

  const { ex, pos } = found;
  const venueChanged = ex.name !== trade.exchange;
  const wasClosed = trade.status !== "open" && trade.status !== "working";
  if (!venueChanged && !wasClosed) {
    return { ok: true, changed: false, live: true, venue: ex.name, trade };
  }
  // Ownership guard: if ANOTHER open/working real trade already maps to this
  // symbol+side on the found venue, the live position (Hyperliquid nets per
  // symbol) is already accounted for by that trade. Reopening/adopting here would
  // bind two desk trades to one real position — a later close/SL-move on one
  // would reduce the other's position out from under it. Leave this one as-is.
  const otherOwner = tradesRepo
    .activeAndWorking()
    .find(
      (t) =>
        t.id !== trade.id &&
        !t.simulated &&
        !t.shadow &&
        t.symbol.toUpperCase() === trade.symbol.toUpperCase() &&
        t.side === trade.side &&
        byName(t.exchange).name === ex.name,
    );
  if (otherOwner) {
    event(
      "exec",
      `Sync: ${trade.symbol} ${trade.side} on ${ex.name} is already tracked by another open trade — not reopening (would double-map one position)`,
      { otherTradeId: otherOwner.id, venue: ex.name },
      { level: "warn", groupId: trade.groupId, signalId: trade.signalId },
    );
    return { ok: true, changed: false, live: false, venue: ex.name, trade };
  }
  // Reopen and adopt the exchange's real venue/size/entry so management resumes.
  const updated = tradesRepo.update(tradeId, {
    status: "open",
    exchange: ex.name,
    exitPrice: undefined,
    realizedPnl: undefined,
    closedAt: undefined,
    error: undefined,
    size: Math.abs(pos.size),
    entryPrice: pos.entryPrice > 0 ? pos.entryPrice : trade.entryPrice,
  });
  if (updated) broadcast({ type: "trade", trade: updated });
  event(
    "exec",
    `Sync: ${trade.symbol} ${trade.side} live on ${ex.name}` +
      `${venueChanged ? ` (was tagged ${trade.exchange})` : ""} — reopened in desk`,
    { size: pos.size, entry: pos.entryPrice, venue: ex.name, wasVenue: trade.exchange },
    { level: "warn", groupId: trade.groupId, signalId: trade.signalId },
  );
  pushStats();
  return { ok: true, changed: true, live: true, venue: ex.name, trade: updated ?? trade };
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
  exchange?: ExchangeName;
}): Promise<{ ok: boolean; error?: string; trade?: Trade }> {
  const symbol = params.symbol.trim().toUpperCase();
  const { side, notionalUsd, leverage } = params;
  if (!symbol) return { ok: false, error: "symbol required" };
  if (!(notionalUsd > 0)) return { ok: false, error: "size must be > 0" };
  if (!(leverage >= 1)) return { ok: false, error: "leverage must be >= 1" };

  // Target venue: an explicitly chosen one (must be a known connector), else the
  // active Hyperliquid. The live-order cap and kill-switch still apply below.
  let ex = activeHyperliquid() as ExchangeConnector;
  if (params.exchange) {
    const chosen = known().find((e) => e.name === params.exchange);
    if (!chosen) return { ok: false, error: `unknown exchange ${params.exchange}` };
    ex = chosen;
  }

  // Clamp real (non-simulated) test orders to the global live-order cap FIRST,
  // so the exposure gate below is evaluated against the size we'll actually send.
  let sizeUsd = notionalUsd;
  const liveCap = settingsRepo.getGlobalSettings().liveMaxOrderUsd;
  if (liveCap > 0 && !ex.simulating() && sizeUsd > liveCap) sizeUsd = liveCap;

  // A test order is still a new entry — respect the kill-switch and risk limits.
  const block = preTradeGate(sizeUsd);
  if (block) return { ok: false, error: block };

  try {
    const asset = await ex.getAsset(symbol);
    if (!asset) return { ok: false, error: `Crypto NOT found: ${symbol} is not listed on ${ex.name}` };
  } catch {
    /* metadata unavailable — let the order path surface any error */
  }

  const result = await ex.placeMarketOrder({
    symbol,
    side,
    notionalUsd: sizeUsd,
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
    exchange: ex.name,
    leverage,
    notionalUsd: sizeUsd,
    size: result.size,
    entryPrice: result.filledPrice,
    exchangeOrderId: result.orderId,
    tpFilledCount: 0,
    slMovedToBreakeven: false,
    simulated: result.simulated,
  });
  event(
    "exec",
    `Test order ${side} ${symbol} on ${ex.name} (${result.simulated ? "sim" : "live"}) @ ${result.filledPrice}`,
    { tradeId: trade.id, size: trade.size, notionalUsd: sizeUsd, leverage, exchange: ex.name },
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

    // Portion already scaled out at TP levels vs the remainder we now close.
    const tps = trade.takeProfits ?? [];
    const n = tps.length;
    const fraction = n > 0 ? 1 / n : 0;
    const tpFilled = Math.min(trade.tpFilledCount ?? 0, n);
    const remainingFraction = Math.max(0, 1 - tpFilled * fraction);
    const remainingSize = remainingFraction * trade.size;

    if (!trade.simulated && ex.live && remainingSize > 0) {
      // Send the reduce-only close FIRST — the resting SL/TP are only cancelled
      // AFTER it confirms, so a failed close never strips a still-live position
      // of its protection.
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
        // The order was rejected. If the position is ALREADY FLAT on the exchange
        // (it netted against an opposite trade, or was closed manually there),
        // don't leave a ghost "open" trade that can never be closed — book it as
        // closed at the mid. Only keep the error when a real position still runs;
        // its SL/TP are still in place because we haven't cancelled them yet.
        let flat = false;
        try {
          const positions = await ex.getPositions();
          flat = !positions.some(
            (p) =>
              p.symbol.toUpperCase() === trade.symbol.toUpperCase() &&
              p.size !== 0 &&
              (trade.side === "long" ? p.size > 0 : p.size < 0),
          );
        } catch {
          flat = false; // couldn't verify — treat as still-open and surface the error
        }
        if (!flat) {
          log.error(`closeTrade: exchange close failed for ${trade.symbol}: ${result.error}`);
          alertError(`close ${trade.symbol} (${trade.groupName})`, result.error ?? "unknown");
          return tradesRepo.get(tradeId);
        }
        log.warn(`closeTrade: ${trade.symbol} already flat on ${ex.name} (${result.error}) — booking as closed at mid.`);
        // fall through: exitPrice stays the mid we resolved above.
      } else {
        exitPrice = result.filledPrice;
      }
    }

    // Position is now closed/flat (or simulated) — NOW cancel any resting SL/TP so
    // they can't fire on a future position. cancelOrders no-ops when not live.
    const restingIds = [trade.slOrderId, ...(trade.tpOrderIds ?? [])].filter(
      (x): x is string => !!x,
    );
    if (restingIds.length) {
      await ex.cancelOrders(trade.symbol, restingIds);
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
