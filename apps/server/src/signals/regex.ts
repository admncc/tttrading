import type { ParsedSignal, TradeSide } from "@tttrading/shared";

function toNumber(raw: string): number | undefined {
  // Handle "60,000.50" and "60.000,50" style separators conservatively.
  const cleaned = raw.replace(/[^0-9.,]/g, "");
  if (!cleaned) return undefined;
  let normalized = cleaned;
  if (cleaned.includes(",") && cleaned.includes(".")) {
    // Assume comma is thousands separator.
    normalized = cleaned.replace(/,/g, "");
  } else if (cleaned.includes(",")) {
    // Lone comma: treat as decimal if it looks like one, else thousands.
    normalized = /,\d{1,2}$/.test(cleaned) ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

const QUOTE_SUFFIX = /(USDT|USDC|USD|PERP)$/i;

function extractSymbol(text: string, side: TradeSide): string | undefined {
  // Prefer an explicit $TICKER.
  const dollar = text.match(/\$([A-Za-z]{2,6})\b/);
  if (dollar) return dollar[1]!.toUpperCase();

  // TICKER/QUOTE or TICKERUSDT.
  const pair = text.match(/\b([A-Za-z]{2,6})[\/\-]?(USDT|USDC|USD|PERP)\b/i);
  if (pair) return pair[1]!.toUpperCase();

  // Ticker directly after the direction word.
  const dir = side === "long" ? "long|buy" : "short|sell";
  const afterDir = new RegExp(`\\b(?:${dir})\\b[^A-Za-z]*([A-Za-z]{2,6})\\b`, "i");
  const m = text.match(afterDir);
  if (m) {
    const sym = m[1]!.toUpperCase().replace(QUOTE_SUFFIX, "");
    if (sym.length >= 2) return sym;
  }
  return undefined;
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
    // Split on slash/whitespace only; toNumber() resolves any thousands commas.
    for (const token of run[1]!.split(/[\/\s]+/)) {
      const n = toNumber(token);
      if (n !== undefined) out.push(n);
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
    /\b(?:entry|enter|entradas?|einstieg)\b[:\s@]*([0-9][0-9.,]*)/i,
    /@\s*([0-9][0-9.,]*)/,
    /\bprice\b[:\s]*([0-9][0-9.,]*)/i,
  ]);

  const stopLoss = firstNumber(text, [
    /\b(?:sl|stop[\s-]?loss|stop)\b[:\s]*([0-9][0-9.,]*)/i,
    /🛑[:\s]*([0-9][0-9.,]*)/,
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
