import type { ParsedSignal, TradeSide } from "@tttrading/shared";

function toNumber(raw: string): number | undefined {
  // Handle both "60,000.50" (US) and "60.000,50" (EU) formats: whichever
  // separator appears LAST is the decimal separator.
  const cleaned = raw.replace(/[^0-9.,]/g, "").replace(/[.,]+$/, "");
  if (!cleaned) return undefined;
  let normalized = cleaned;
  if (cleaned.includes(",") && cleaned.includes(".")) {
    if (cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")) {
      normalized = cleaned.replace(/\./g, "").replace(",", "."); // EU: dot=thousands, comma=decimal
    } else {
      normalized = cleaned.replace(/,/g, ""); // US: comma=thousands
    }
  } else if (cleaned.includes(",")) {
    // Lone comma: decimal if followed by 1-2 digits, else thousands.
    normalized = /,\d{1,2}$/.test(cleaned) ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

// Common words that must never be mistaken for a ticker symbol.
const STOPWORDS = new Set([
  "THE", "NOW", "BUY", "SELL", "LONG", "SHORT", "DIP", "AND", "FOR", "ALL", "OUT",
  "TP", "SL", "USDT", "USDC", "USD", "PERP", "THIS", "THAT", "MORE", "SOME", "HERE",
  "WILL", "SETUP", "ENTRY", "TARGET", "STOP", "ARE", "NOT", "WAS", "GET", "NEW",
]);

const QUOTE_SUFFIX = /(USDT|USDC|USD|PERP)$/i;

function extractSymbol(text: string, side: TradeSide): string | undefined {
  // Prefer an explicit $TICKER.
  const dollar = text.match(/\$([A-Za-z]{2,6})\b/);
  if (dollar) return dollar[1]!.toUpperCase();

  // TICKER/QUOTE or TICKERUSDT.
  const pair = text.match(/\b([A-Za-z]{2,6})[\/\-]?(USDT|USDC|USD|PERP)\b/i);
  if (pair) return pair[1]!.toUpperCase();

  const dir = side === "long" ? "long|buy|buying" : "short|sell|selling";

  // Ticker immediately BEFORE the direction word ("Btc long", "ETH buy").
  const beforeDir = new RegExp(`\\b([A-Za-z]{2,6})\\s+(?:${dir})\\b`, "i");
  const b = text.match(beforeDir);
  if (b) {
    const sym = b[1]!.toUpperCase().replace(QUOTE_SUFFIX, "");
    if (sym.length >= 2 && !STOPWORDS.has(sym)) return sym;
  }

  // Ticker directly after the direction word ("long BTC", "buy eth").
  const afterDir = new RegExp(`\\b(?:${dir})\\b[^A-Za-z]*([A-Za-z]{2,6})\\b`, "i");
  const m = text.match(afterDir);
  if (m) {
    const sym = m[1]!.toUpperCase().replace(QUOTE_SUFFIX, "");
    if (sym.length >= 2 && !STOPWORDS.has(sym)) return sym;
  }
  return undefined;
}

/**
 * Human-readable catalog of the deterministic ENTRY-parsing rules, for the
 * diagnostic API's /diagnostic/rules. (These patterns are inline in the parser;
 * this describes them and their precedence so the behaviour is inspectable.)
 */
export const ENTRY_RULES: { name: string; pattern: string; description: string }[] = [
  { name: "direction", pattern: "long|buy|buying  /  short|sell|selling", description: "Trade side; must be present for a fresh entry." },
  { name: "symbol", pattern: "TICKER before/after the direction word; else $/# tag or PAIR/USDT", description: "Base ticker (USDT/USDC/PERP suffixes stripped); 2–6 letters, not a stopword." },
  { name: "market_entry", pattern: "cmp | current price | market (price/order/buy/entry) | at/@ market", description: "Enter now at market; a 'CMP till X' zone ignores X (far DCA bound)." },
  { name: "entry_price", pattern: "entry|enter|entrada|einstieg + price  →  @price  →  till X  →  price", description: "Precedence order: an explicit entry label WINS over a 'till X' DCA bound." },
  { name: "stop_loss", pattern: "sl | stop loss | stop | invalidation + number   (also 🛑 + number)", description: "Stop price; tolerates filler between label and value." },
  { name: "take_profits", pattern: "tp / take profit / target / ziel  labels + number list (comma/slash/space)", description: "One label with several values, or repeated labels; RR-multiples not treated as prices." },
  { name: "scale_in", pattern: "ordinal entries: first/second/third/final/DCA (with cmp/market/limit)", description: "Each labelled entry becomes its own order (market if cmp, else limit), sharing the SL/TPs." },
  { name: "leverage", pattern: "lev|leverage|hebel + N  /  N x", description: "Leverage hint (non-blocking)." },
];

/** Extract a symbol without needing a direction (for management messages). */
export function extractAnySymbol(text: string): string | undefined {
  const tag = text.match(/[$#]([A-Za-z]{2,6})\b/);
  if (tag) {
    const s = tag[1]!.toUpperCase().replace(QUOTE_SUFFIX, "");
    if (s.length >= 2 && !STOPWORDS.has(s)) return s;
  }
  const pair = text.match(/\b([A-Za-z]{2,6})[\/\-](?:USDT|USDC|USD|PERP)\b/i);
  if (pair) return pair[1]!.toUpperCase();
  return undefined;
}

/** Parse a numeric token (handles US/EU separators). Exported for reuse. */
export function parseNumber(raw: string): number | undefined {
  return toNumber(raw);
}

function firstNumber(text: string, patterns: RegExp[]): number | undefined {
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) {
      const n = toNumber(m[1]);
      if (n !== undefined) return n;
    }
  }
  return undefined;
}

/**
 * Expand one whitespace/slash-delimited token into number(s), disambiguating
 * comma as thousands grouping, decimal separator, or list separator.
 */
function expandNumberToken(token: string): number[] {
  const one = (n: number | undefined) => (n === undefined ? [] : [n]);
  // Pure thousands-grouped integer: 64,000 / 1,234,567 -> single value.
  if (/^\d{1,3}(,\d{3})+$/.test(token)) return one(toNumber(token));
  const commas = (token.match(/,/g) ?? []).length;
  // Single comma with a dot => EU number (dot thousands, comma decimal).
  if (commas === 1 && token.includes(".")) return one(toNumber(token));
  // Single comma followed by 1-2 digits => decimal comma (3,5).
  if (commas === 1 && /,\d{1,2}$/.test(token)) return one(toNumber(token));
  // Otherwise any comma is a list separator (64000,65000 / 3.5,4.0,4.5).
  if (commas >= 1) return token.split(",").flatMap((p) => one(toNumber(p)));
  return one(toNumber(token));
}

/**
 * Extract take-profit levels. Handles both repeated labels ("TP1 x TP2 y") and
 * a single label followed by several values ("TP 64000 / 65000", "targets:
 * 64000, 65000"). Separators: comma, slash, or whitespace on the same line.
 */
function extractTakeProfits(text: string): number[] {
  const label = /(?:tp\d*|take[\s-]?profits?\d*|targets?\d*|ziele?\d*)\s*[:=]?\s*/gi;
  const out: number[] = [];
  for (const m of text.matchAll(label)) {
    const rest = text.slice(m.index! + m[0].length);
    // Grab the run of numbers separated by , / or spaces until something else.
    const run = rest.match(/^([0-9][0-9.,]*(?:\s*[\/,\s]\s*[0-9][0-9.,]*)*)/);
    if (!run) continue;
    // Split on slash/whitespace, then expand each token — a comma may be a list
    // separator, a thousands grouping, or a decimal, so disambiguate carefully.
    for (const token of run[1]!.split(/[\/\s]+/)) {
      for (const n of expandNumberToken(token)) out.push(n);
    }
  }
  // De-duplicate while preserving order.
  return [...new Set(out)];
}

/**
 * Detect a scale-in: several entry zones the trader wants to ADD into, e.g.
 * "First Entry zone: ($63842)(cmp)  Second limit Entry zone: ($64747)".
 * Each match's trailing window is inspected for a cmp/market marker → that leg
 * is a market entry. Returns the legs only when ≥2 distinct prices are found;
 * otherwise undefined (a single entry is handled by the normal `entry` field).
 */
function extractEntries(text: string): { price?: number; mode: "market" | "limit" }[] | undefined {
  // The ordinal (first/second/1st/2nd…) is REQUIRED so a single entry that
  // merely mentions the word "entry" twice ("…stop just below entry at 63000")
  // is NOT mis-split into a bogus second full-size order. Real scale-ins from
  // these channels always number their zones.
  // Trailing window (for a cmp/market marker) stops at a period/newline so it
  // can't consume the NEXT leg's ordinal ("…(63842)(cmp). Second …").
  const re =
    /\b(?:1st|2nd|3rd|4th|first|second|third|fourth)\s+(?:limit\s+)?entr(?:y|ies)\b(?:\s*zone)?[^0-9\n]{0,20}([0-9][0-9.,]*)([^\n.]{0,14})/gi;
  const legs: { price?: number; mode: "market" | "limit" }[] = [];
  const seen = new Set<number>();
  for (const m of text.matchAll(re)) {
    const price = toNumber(m[1]!);
    if (price === undefined || seen.has(price)) continue;
    seen.add(price);
    const window = m[2] ?? "";
    const isMarket = /\bcmp\b|\bmarket\b|\bcurrent\b/i.test(window);
    legs.push({ price, mode: isMarket ? "market" : "limit" });
  }
  return legs.length >= 2 ? legs : undefined;
}

/**
 * Best-effort structured extraction from common signal formats. Returns a
 * ParsedSignal (with a confidence score) or null when direction/symbol can't
 * be found.
 */
export function parseWithRegex(text: string): ParsedSignal | null {
  const isLong = /\b(long|buy|buying|bull(?:ish)?)\b/i.test(text) || /🟢|📈/.test(text);
  const isShort = /\b(short|sell|selling|bear(?:ish)?)\b/i.test(text) || /🔴|📉/.test(text);
  if (isLong === isShort) return null; // none or ambiguous
  const side: TradeSide = isLong ? "long" : "short";

  const symbol = extractSymbol(text, side);
  if (!symbol) return null;

  // "CMP" / "at market" / "current price" means enter at the CURRENT price now —
  // a market entry. A "CMP till X" is a buy/sell ZONE whose X is only the far
  // (DCA) bound, NOT the entry; so treat the whole thing as market and ignore X,
  // rather than resting a limit at X or failing "entry missed".
  const marketEntry =
    /\bcmp\b/i.test(text) ||
    /\bcurrent\s*price\b/i.test(text) ||
    /\bmarket\s*(?:price|order|buy|entry)\b/i.test(text) ||
    /\b(?:at|@)\s*(?:market|mkt)\b/i.test(text);

  let entry = marketEntry
    ? undefined
    : firstNumber(text, [
        // An EXPLICIT entry label wins over a "…till X" DCA bound, so
        // "entry 3361, add till 3300" rests at 3361, not the far bound 3300.
        // Allow small filler ("entry at $3361", "entry: 3361", "enter @ 3361").
        // The `(?!\s*[:)])` guard rejects a list ordinal ("Entry 1: buy up till X"
        // → don't capture the "1"), letting the real price/`till` bound win instead.
        /\b(?:entry|enter|entradas?|einstieg)\b(?:\s*(?:at|@|:|=|around|near)?\s*\$?){0,2}\s*([0-9][0-9.,]*)(?!\s*[:)])/i,
        /@\s*([0-9][0-9.,]*)/,
        // Only when there's no labeled entry: "buy up till 0.245" -> the limit.
        /\btill\s*([0-9][0-9.,]*)/i,
        /\bprice\b[:\s]*([0-9][0-9.,]*)/i,
      ]);

  const stopLoss = firstNumber(text, [
    // Tolerate filler words/symbols between the SL label and the value, e.g.
    // "SL at $60500", "same SL at 60500", "stop loss to 60500", "sl: 60500".
    /\b(?:sl|stop[\s-]?loss|stop|invalidation)\b[^0-9\n]{0,12}([0-9][0-9.,]*)/i,
    /🛑[^0-9\n]{0,6}([0-9][0-9.,]*)/,
  ]);

  const takeProfits = extractTakeProfits(text);

  const leverageHint = firstNumber(text, [
    /\b(?:lev(?:erage)?|hebel)\b[:\s]*([0-9]+)\s*x?/i,
    /\b([0-9]{1,3})\s*x\b/i,
  ]);

  // Scale-in: several entry zones to add into (each becomes its own order).
  const entries = extractEntries(text);

  // Confidence grows with the number of well-formed fields.
  let confidence = 0.6;
  if (entry !== undefined || entries) confidence += 0.15;
  if (stopLoss !== undefined) confidence += 0.15;
  if (takeProfits.length > 0) confidence += 0.1;
  confidence = Math.min(confidence, 1);

  return {
    symbol,
    side,
    entry,
    entries,
    stopLoss,
    takeProfits: takeProfits.length ? takeProfits : undefined,
    leverageHint,
    confidence,
    source: "regex",
  };
}
