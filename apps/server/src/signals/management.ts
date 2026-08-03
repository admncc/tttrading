import { extractAnySymbol, parseNumber } from "./regex.js";

export type ManagementKind =
  | "close" // closed / invalidated / stopped / cut / cancel a filled trade
  | "cancel_limit" // remove/cancel a still-resting limit ENTRY order (not a position)
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

// Remove/cancel a still-RESTING limit ENTRY order (not an open position).
// Checked before close so "cancel/remove the limit entry" isn't read as a close.
const RE_CANCEL_LIMIT =
  /\b(?:cancel\w*|remov\w*|delet\w*|pull\w*|scrap\w*|kill\w*)\b[^.\n]{0,25}\b(?:limit|entry|pending|resting|order)s?\b/i;
// "invalidated"/"stopped"/"closed"/"cut"/"off the table" => close a live trade.
// Two variants: NONCANCEL excludes the bare cancel/remove words (which, next to
// "limit/entry", mean cancel_limit); the cancel word alone (no limit context)
// still means close a filled trade ("cancelled").
const RE_CLOSE_NONCANCEL =
  /\b(invalidated|stopped\s*out|got\s*stopped|\bstopped\b|clos(?:e|ed|ing)\b|cut(?:ting)?\b|exit(?:ed|ing)?\b|off\s+the\s+table|left\s+without\s+us|took\s+profit\s+and\s+clos)/i;
const RE_CANCEL_WORD = /\bcancel(?:led|ed|ing)?\b/i;
// "risk free" / "move SL to entry / breakeven".
const RE_BE =
  /\b(break\s*even|risk[-\s]?free)\b|\bmov\w+\b[^.\n]{0,40}\b(?:sl|stop|invalidation)\b[^.\n]{0,25}\b(?:entry|break\s*even|be)\b/i;
// "move to BE" with the bare abbreviation. Case-SENSITIVE uppercase BE + a move
// verb, so it won't fire on ordinary prose like "going to be" / "to be honest".
const RE_BE_ABBR = /\bmov\w+[^.\n]{0,25}\bto\s+BE\b/;
/** True when the message asks to move the stop to break-even (spelled or "to BE"). */
function isBreakeven(text: string): boolean {
  return RE_BE.test(text) || RE_BE_ABBR.test(text);
}
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
 * Classify ALL trade-management intents in a message. A single message may carry
 * several ("remove the limit entry and move SL to 62000" → cancel_limit +
 * sl_move). Returns [] when the text is not a management update. Only meant to
 * run on messages that did NOT parse as a fresh entry (the caller decides that).
 */
export function classifyManagementAll(text: string): ManagementAction[] {
  const out: ManagementAction[] = [];
  const symbol = extractAnySymbol(text);
  const seen = new Set<ManagementKind>();
  const add = (a: ManagementAction) => {
    if (seen.has(a.kind)) return;
    seen.add(a.kind);
    out.push(a);
  };

  const cancelLimit = RE_CANCEL_LIMIT.test(text);
  if (cancelLimit) add({ kind: "cancel_limit", symbol, note: "cancel limit entry" });

  // A real close word → close. A bare "cancelled" (no limit context) also closes;
  // but if it's the limit-cancel phrasing, cancel_limit already covered it.
  if (RE_CLOSE_NONCANCEL.test(text)) add({ kind: "close", symbol, note: "close/invalidated/stopped" });
  else if (!cancelLimit && RE_CANCEL_WORD.test(text)) add({ kind: "close", symbol, note: "cancelled" });

  const pm = text.match(RE_PARTIAL_A) ?? text.match(RE_PARTIAL_B);
  let partial = false;
  if (pm) {
    const pct = Number(pm[1]);
    if (Number.isFinite(pct) && pct > 0 && pct < 100) {
      add({ kind: "partial_close", symbol, fraction: pct / 100, alsoBreakeven: isBreakeven(text), note: `book ${pct}%` });
      partial = true;
    }
  }

  // Break-even as its own intent only when a partial didn't already fold it in.
  if (!partial && isBreakeven(text)) add({ kind: "sl_breakeven", symbol, note: "SL to break-even" });

  const sm = text.match(RE_SLMOVE);
  if (sm) {
    const newStop = parseNumber(sm[2]!);
    if (newStop !== undefined) add({ kind: "sl_move", symbol, newStop, note: `move SL to ${newStop}` });
  }

  if (RE_TPHIT.test(text)) add({ kind: "tp_hit", symbol, note: "TP reached" });

  return out;
}

/**
 * Classify a single (primary) trade-management intent — the first of
 * classifyManagementAll, or kind "none". Kept for callers that want one action.
 */
export function classifyManagement(text: string): ManagementAction {
  return classifyManagementAll(text)[0] ?? { kind: "none", symbol: extractAnySymbol(text), note: "" };
}
