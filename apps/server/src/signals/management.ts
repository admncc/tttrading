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
  /**
   * Set when the LLM EXPLICITLY enumerated this exact symbol as one of several
   * to act on together ("close A and B"). Such actions carry a trustworthy
   * per-symbol attribution, so the multi-coin "ambiguous recap" guard skips them.
   */
  explicitSymbol?: boolean;
  note: string;
}

// Remove/cancel a still-RESTING limit ENTRY order (not an open position).
// Checked before close so "cancel/remove the limit entry" isn't read as a close.
// NB: "pull" is deliberately NOT in this alternation — "pull back to the entry
// zone" / "waiting for a pull back to entry" is price commentary, not an order-
// management command, and would otherwise cancel a resting limit on pure TA prose.
const RE_CANCEL_LIMIT =
  /\b(?:cancel\w*|remov\w*|delet\w*|scrap\w*|kill\w*)\b[^.\n]{0,25}\b(?:limit|entry|pending|resting|order)s?\b/i;
// "invalidated"/"stopped"/"closed"/"cut"/"off the table" => close a live trade.
// Two variants: NONCANCEL excludes the bare cancel/remove words (which, next to
// "limit/entry", mean cancel_limit); the cancel word alone (no limit context)
// still means close a filled trade ("cancelled").
// "close" only counts as an EXIT when it isn't "close to/above/below/near/by"
// (price merely approaching a level) and isn't "closed 50%" (a partial — that
// number is caught by RE_PARTIAL_A's `clos` verb below). Bare "stopped" is
// dropped ("stopped at resistance" is not a stop-out); only "stopped out" /
// "got stopped" count.
// A candle-close remark ("BTC closed strong above the range", "daily closed
// green") is market commentary, NOT an instruction to flatten a live position.
// Distinguish it from a real exit: (a) don't count "closed" when it is preceded
// by a timeframe word (candle/daily/…); (b) don't count it when it is followed
// — allowing one adverb in between — by a level word (above/below/near/…) or by
// a candle-colour/strength/timeframe word. A genuine close ("closed the
// position", "closed here", "closed for a loss", bare "position closed") has
// none of those and still matches.
const RE_CLOSE_NONCANCEL =
  /\b(invalidated|stopped\s*out|got\s*stopped|(?<!\b(?:candle|daily|weekly|monthly|hourly)\s)clos(?:e|ed|ing)\b(?!\s+(?:\w+\s+)?(?:above|below|near)\b)(?!\s*(?:\d|to\b|by\b|half\b|part|some\b|green\b|red\b|strong\b|higher\b|lower\b|the\s+(?:day|week|candle|month|session)\b))|cut(?:ting)?\b|exit(?:ed|ing)?\b|off\s+the\s+table|left\s+without\s+us|took\s+profit\s+and\s+clos)/i;
const RE_CANCEL_WORD = /\bcancel(?:led|ed|ing)?\b/i;
// "risk free" / "move SL to entry / breakeven". The second branch requires the
// word "to" before the target so ordinary prose ("moved my stop, we'll be
// fine") can't false-trigger on a stray "be".
// NB: the second branch's target list must NOT include a lowercase "be" — the
// everyday phrase "going to be" would satisfy it and false-fire a break-even.
// The bare "to BE" abbreviation is handled case-sensitively by RE_BE_ABBR.
const RE_BE =
  /\b(break\s*even|risk[-\s]?free)\b|\bmov\w+\b[^.\n]{0,40}\b(?:sl|stop|invalidation)\b[^.\n]{0,25}\bto\s+(?:entry|break\s*even)\b/i;
// "move to BE" with the bare abbreviation. Case-SENSITIVE uppercase BE + a move
// verb, so it won't fire on ordinary prose like "going to be" / "to be honest".
const RE_BE_ABBR = /\bmov\w+[^.\n]{0,25}\bto\s+BE\b/;
/** True when the message asks to move the stop to break-even (spelled or "to BE"). */
function isBreakeven(text: string): boolean {
  return RE_BE.test(text) || RE_BE_ABBR.test(text);
}
// "moving the SL/invalidation to 61491.4". The number must NOT be immediately
// followed by r/R (an "RR" multiple), x (leverage) or % — else "moved SL, 3R
// locked" would set the stop to 3. The engine also range-checks the new stop.
// The gap before the number must NOT cross a "TP<n>" token, else "move stop up,
// TP1 at 65000" would scrape the "1" from TP1 as the new stop (rejected by the
// engine's range check, but the real trail/move intent would be lost meanwhile).
const RE_SLMOVE =
  /\b(?:mov\w+|adjust\w*|trail\w*|reduc\w*\s+risk)\b[^.\n]{0,40}\b(sl|stop\s*loss|stop|invalidation)\b(?:(?!tp\s*\d)[^0-9\n]){0,20}([0-9][0-9.,]*)(?!\s*[rRxX%])/i;
// "book 50%", "take 20% profit", "50% out".
const RE_PARTIAL_A = /\b(?:book(?:ing)?|tak(?:e|ing)|lock(?:ing)?\s*in|secur\w*|clos(?:e|ed|ing)?)\b[^%\n]{0,25}?(\d{1,3}(?:\.\d+)?)\s*%/i;
const RE_PARTIAL_B = /\b(\d{1,3}(?:\.\d+)?)\s*%\s*(?:out|off|pos|position|booked)\b/i;
// A percentage that describes P&L ("down 2.5%", "up 4%", "now 30% in profit") is
// NOT a booking size. If the matched partial phrase carries a P&L word, the % is
// a result, not an instruction — so "close OP long here down 2.5%" is a FULL
// close, not a 2.5% partial.
const RE_PNL_WORD = /\b(?:up|down|now|currently|already|gain(?:ed|s)?|profit|loss|green|red|running)\b/i;
// Partial WITHOUT a percentage ("booked partial profits", "manual TP1", "took
// some off", "lock in some profits", "secured half"). Requires a partial
// QUALIFIER (partial/some/half/TPn) — NOT bare "profit", so "take profit at
// 64000" (a TP target/info line) doesn't get read as a partial. "trim" alone
// also counts.
const RE_PARTIAL_WORD =
  /\b(?:book(?:ed|ing)?|took|tak(?:e|ing|en)|lock(?:ed|ing)?\s*in|secur\w*|scal\w*\s*out|clos(?:e|ed|ing)?)\b[^.\n]{0,30}\b(?:partials?|some|half|tp\s*\d+)\b/i;
// Booking gains/profits in prose without a % ("booking more gains", "took some
// profit", "securing profits here", "banking gains"). A partial ACTION verb
// followed by gains/profit — but NOT when a price follows ("take profit at
// 64000", "TP: 0.67"), which is a target/info line, not a booking instruction.
const RE_PARTIAL_GAINS =
  /\b(?:book(?:ed|ing)?|took|tak(?:e|ing|en)|lock(?:ed|ing)?\s*in|secur\w*|bank(?:ed|ing)?)\b[^.\n%]{0,20}?\b(?:gains?|profits?)\b(?!\s*(?:at|@|:|near|around|of|=|target|tp)?\s*[\d$])/i;
const RE_TRIM = /\btrim(?:med|ming)?\b/i;
// Fractional partial WITHOUT a "%": "take 1/3 off", "sell 1/3 here", "close half",
// "trim a third". A booking/exit verb followed (within a short gap) by a fraction
// word/ratio. Books the exact stated fraction instead of the group default.
const RE_PARTIAL_FRAC =
  /\b(?:book(?:ing)?|took|tak(?:e|ing|en)|sell(?:ing)?|off\s*load\w*|clos(?:e|ed|ing)?|trim(?:med|ming)?|secur\w*|lock(?:ed|ing)?\s*in)\b[^.\n]{0,14}?\b(1\/2|1\/3|2\/3|1\/4|3\/4|half|a\s+(?:half|third|quarter))\b/i;
/** Map a fraction word/ratio ("1/3", "a third", "half") to a 0..1 fraction. */
function fracWord(s: string): number | undefined {
  const t = s.toLowerCase().replace(/\s+/g, " ").trim();
  if (t === "1/2" || t === "a half" || t === "half") return 0.5;
  if (t === "1/3" || t === "a third") return 1 / 3;
  if (t === "2/3") return 2 / 3;
  if (t === "1/4" || t === "a quarter") return 0.25;
  if (t === "3/4") return 0.75;
  return undefined;
}
// "TP1 hit", "target reached", "area 1 reached", "4RR", "done and dusted".
const RE_TPHIT =
  /\b(?:tp\s*\d*\s*(?:hit|reached|done)|target\s*\d*\s*(?:reached|hit|smashed|done)|area\s*\d*\s*reached|\d+\s*rr\b|done\s+and\s+dusted)\b/i;

// Strong markers that a message is a PROGRESS UPDATE about an already-open trade
// (an update heading, a stop already at break-even, the trade "protected/running"
// / "in profit / up X%"). These phrases essentially never appear in a genuine
// fresh-entry call, so a message carrying one must be handled as management —
// NEVER opened as a new position, even if a chart shows drawn levels.
// NB: no bare "in profit" here — it appears in fresh-call hype ("last call already
// in profit, new setup: LONG …") and would wrongly veto a real entry. The markers
// kept are specific enough that a genuine new call won't contain them.
const RE_TRADE_UPDATE =
  /\btrade\s+update\b|\b(?:my\s+)?stop\s+(?:is\s+now|has\s+been\s+moved|(?:is\s+)?now\s+moved|moved)\s+(?:to\s+)?(?:break\s*even|breakeven|\bbe\b|entry)\b|\btrade\s+is\s+(?:protected|running|now\s+risk[-\s]?free)\b|\b(?:now|already)\s+up\s+\d+(?:\.\d+)?\s*%/i;
/** True when the message reads as an update to an EXISTING trade, not a new call. */
export function isTradeUpdate(text: string): boolean {
  return RE_TRADE_UPDATE.test(text);
}

// A MARKET-COMMENTARY / pointer post — a "market/macro/big market update", or one
// that sends the reader to ANOTHER post ("read/see/look at the previous/pinned",
// "answered in …") — is educational commentary, NOT a command on a live trade.
// It often RECAPS that a past setup "was invalidated"; that narrative must not
// fire a close. NB: a real management post is titled "Trade Update"/"#SYM Update"
// (not "market update"), so those are deliberately NOT matched here.
const RE_MARKET_UPDATE =
  /\b(?:market|macro|weekly|monthly|big)\s+(?:market\s+)?update\b|\b(?:read|see|look\s+at|check)\s+(?:the\s+)?(?:previous|last|pinned|big)\b|\banswered\s+in\b/i;
/** True when the message is market commentary / a pointer to another post. */
export function isMarketCommentary(text: string): boolean {
  return RE_MARKET_UPDATE.test(text);
}

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
  // Ignore a percentage that is really a P&L reference (e.g. "close … down 2.5%")
  // — the matched phrase carrying up/down/profit/loss means the % is a result,
  // not a booking size. A genuine "book 50%" / "closed 50%" has no such word.
  if (pm && RE_PNL_WORD.test(pm[0])) {
    // treated as no partial → a bare close (if present) will close in full
  } else if (pm) {
    const pct = Number(pm[1]);
    if (Number.isFinite(pct) && pct >= 100) {
      // "closed 100%" / "book 100%" is a FULL close, not a partial (and the close
      // matcher's \d lookahead deliberately skipped it) — classify it as close.
      add({ kind: "close", symbol, note: "closed 100%" });
    } else if (Number.isFinite(pct) && pct > 0) {
      add({ kind: "partial_close", symbol, fraction: pct / 100, alsoBreakeven: isBreakeven(text), note: `book ${pct}%` });
      partial = true;
    }
  }
  // No explicit "%", but a stated FRACTION ("take 1/3 off", "close half") → book
  // that exact fraction (more precise than the group default).
  if (!partial) {
    const fm = text.match(RE_PARTIAL_FRAC);
    const frac = fm ? fracWord(fm[1]!) : undefined;
    if (frac !== undefined && !(pm && RE_PNL_WORD.test(pm[0]))) {
      add({ kind: "partial_close", symbol, fraction: frac, alsoBreakeven: isBreakeven(text), note: `book ${Math.round(frac * 100)}%` });
      partial = true;
    }
  }
  // No explicit %, but the trader clearly booked a partial in prose → book the
  // group's default fraction (fraction left undefined; the engine fills it in).
  if (!partial && (RE_PARTIAL_WORD.test(text) || RE_TRIM.test(text) || RE_PARTIAL_GAINS.test(text))) {
    add({ kind: "partial_close", symbol, alsoBreakeven: isBreakeven(text), note: "book partial (default %)" });
    partial = true;
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

/**
 * Human-readable catalog of the management/guard regexes, reusing the live RegExp
 * objects (so it can never drift from what actually runs). Surfaced by the
 * diagnostic API's /diagnostic/rules so the exact rules are inspectable.
 */
export const MANAGEMENT_RULES: { name: string; kind: string; pattern: string; description: string }[] = [
  { name: "cancel_limit", kind: "cancel_limit", pattern: RE_CANCEL_LIMIT.source, description: "Cancel a still-resting limit ENTRY order (cancel/remove/pull/kill … limit/entry/pending/order)." },
  { name: "close", kind: "close", pattern: RE_CLOSE_NONCANCEL.source, description: "Full close of a live position (invalidated / stopped out / closed / cut / exited / off the table). Excludes 'close to/above/below/near' and 'closed 50%'." },
  { name: "cancel_word", kind: "close", pattern: RE_CANCEL_WORD.source, description: "Bare 'cancelled' with no limit context → close a filled trade." },
  { name: "sl_breakeven", kind: "sl_breakeven", pattern: RE_BE.source, description: "Move SL to entry / breakeven / risk-free (guarded so 'going to be' can't fire it)." },
  { name: "sl_breakeven_abbr", kind: "sl_breakeven", pattern: RE_BE_ABBR.source, description: "'move to BE' — case-sensitive uppercase BE only." },
  { name: "sl_move", kind: "sl_move", pattern: RE_SLMOVE.source, description: "Move SL to a specific price; the number must not be an RR/x/% multiple." },
  { name: "partial_pct_a", kind: "partial_close", pattern: RE_PARTIAL_A.source, description: "book / take / lock in / secure / close  X%." },
  { name: "partial_pct_b", kind: "partial_close", pattern: RE_PARTIAL_B.source, description: "X% out / off / pos / booked." },
  { name: "partial_word", kind: "partial_close", pattern: RE_PARTIAL_WORD.source, description: "Prose partial with no % (booked/took/secured partial|some|half|TPn)." },
  { name: "partial_gains", kind: "partial_close", pattern: RE_PARTIAL_GAINS.source, description: "Booking gains/profits in prose w/o % (\"booking more gains\", \"took some profit\") → books the group default %; skips 'take profit at <price>' targets." },
  { name: "trim", kind: "partial_close", pattern: RE_TRIM.source, description: "'trim' → partial close (group default %)." },
  { name: "tp_hit", kind: "tp_hit", pattern: RE_TPHIT.source, description: "TP/target reached/hit/done, 'N RR', 'done and dusted'." },
  { name: "trade_update_guard", kind: "guard", pattern: RE_TRADE_UPDATE.source, description: "Progress-update markers ('trade update', 'stop now at breakeven', 'now up X%', …) → NEVER open a new entry; handled as management/info." },
  { name: "market_commentary_guard", kind: "guard", pattern: RE_MARKET_UPDATE.source, description: "Market/macro/'big market update' or pointer posts ('read the previous …', 'answered in …') → NO management action, even if they recap a past 'invalidated' setup." },
];
