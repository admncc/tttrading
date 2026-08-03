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

  const entry = firstNumber(text, [
    // "Entry: CMP till 3361" / "buy up till 0.245" -> the limit after "till".
    /\btill\s*([0-9][0-9.,]*)/i,
    // Allow small filler between the label and the number ("entry at $3361",
    // "entry: 3361", "enter @ 3361"). Bare "Cmp"/"market" gives no number → market.
    /\b(?:entry|enter|entradas?|einstieg)\b(?:\s*(?:at|@|:|=|around|near)?\s*\$?){0,2}\s*([0-9][0-9.,]*)/i,
    /@\s*([0-9][0-9.,]*)/,
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

  // Confidence grows with the number of well-formed fields.
  let confidence = 0.6;
  if (entry !== undefined) confidence += 0.15;
  if (stopLoss !== undefined) confidence += 0.15;
  if (takeProfits.length > 0) confidence += 0.1;
  confidence = Math.min(confidence, 1);

  return {
    symbol,
    side,
    entry,
    stopLoss,
    takeProfits: takeProfits.length ? takeProfits : undefined,
    leverageHint,
    confidence,
    source: "regex",
  };
}
