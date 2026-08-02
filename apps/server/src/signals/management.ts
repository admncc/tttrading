import { extractAnySymbol, parseNumber } from "./regex.js";

export type ManagementKind =
  | "close" // closed / invalidated / stopped / cut / cancel a filled trade
  | "sl_breakeven" // move stop to entry / "risk free"
  | "sl_move" // move stop to a specific price
  | "partial_close" // book X% / take partial
  | "tp_hit" // a target was reached (informational / progress)
  | "none";

export interface ManagementAction {
  kind: ManagementKind;
  symbol?: string;
  /** New stop price for sl_move. */
  newStop?: number;
  /** Fraction 0..1 for partial_close. */
  fraction?: number;
  /** Whether a partial message also asked to move the stop to break-even. */
  alsoBreakeven?: boolean;
  note: string;
}

// "invalidated"/"stopped"/"closed"/"cut"/"off the table" => close a live trade.
const RE_CLOSE =
  /\b(invalidated|stopped\s*out|got\s*stopped|\bstopped\b|clos(?:e|ed|ing)\b|cut(?:ting)?\b|exit(?:ed|ing)?\b|off\s+the\s+table|left\s+without\s+us|took\s+profit\s+and\s+clos)/i;
// "risk free" / "move SL to entry / breakeven".
const RE_BE =
  /\b(break\s*even|risk[-\s]?free)\b|\bmov\w+\b[^.\n]{0,40}\b(?:sl|stop|invalidation)\b[^.\n]{0,25}\b(?:entry|break\s*even|be)\b/i;
// "moving the SL/invalidation to 61491.4".
const RE_SLMOVE =
  /\b(?:mov\w+|adjust\w*|trail\w*|reduc\w*\s+risk)\b[^.\n]{0,40}\b(sl|stop\s*loss|stop|invalidation)\b[^0-9\n]{0,20}([0-9][0-9.,]*)/i;
// "book 50%", "take 20% profit", "50% out".
const RE_PARTIAL_A = /\b(?:book(?:ing)?|tak(?:e|ing)|lock(?:ing)?\s*in|secur\w*)\b[^%\n]{0,25}?(\d{1,3})\s*%/i;
const RE_PARTIAL_B = /\b(\d{1,3})\s*%\s*(?:out|off|pos|position|booked)\b/i;
// "TP1 hit", "target reached", "area 1 reached", "4RR", "done and dusted".
const RE_TPHIT =
  /\b(?:tp\s*\d*\s*(?:hit|reached|done)|target\s*\d*\s*(?:reached|hit|smashed|done)|area\s*\d*\s*reached|\d+\s*rr\b|done\s+and\s+dusted)\b/i;

/**
 * Classify a trade-management message. Returns kind "none" when the text is not
 * a management update. Only meant to run on messages that did NOT parse as a
 * fresh entry (the caller decides that).
 */
export function classifyManagement(text: string): ManagementAction {
  const symbol = extractAnySymbol(text);

  if (RE_CLOSE.test(text)) {
    return { kind: "close", symbol, note: "close/invalidated/stopped" };
  }

  const pm = text.match(RE_PARTIAL_A) ?? text.match(RE_PARTIAL_B);
  if (pm) {
    const pct = Number(pm[1]);
    if (Number.isFinite(pct) && pct > 0 && pct < 100) {
      return {
        kind: "partial_close",
        symbol,
        fraction: pct / 100,
        alsoBreakeven: RE_BE.test(text),
        note: `book ${pct}%`,
      };
    }
  }

  if (RE_BE.test(text)) {
    return { kind: "sl_breakeven", symbol, note: "SL to break-even" };
  }

  const sm = text.match(RE_SLMOVE);
  if (sm) {
    const newStop = parseNumber(sm[2]!);
    if (newStop !== undefined) {
      return { kind: "sl_move", symbol, newStop, note: `move SL to ${newStop}` };
    }
  }

  if (RE_TPHIT.test(text)) {
    return { kind: "tp_hit", symbol, note: "TP reached" };
  }

  return { kind: "none", symbol, note: "" };
}
