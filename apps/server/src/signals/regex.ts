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

function allNumbers(text: string, pattern: RegExp): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(pattern)) {
    const n = toNumber(m[1]!);
    if (n !== undefined) out.push(n);
  }
  return out;
}

/**
 * Best-effort structured extraction from common signal formats. Returns a
 * ParsedSignal (with a confidence score) or null when direction/symbol can't
 * be found.
 */
export function parseWithRegex(text: string): ParsedSignal | null {
  const isLong = /\b(long|buy|bull)\b/i.test(text) || /🟢|📈/.test(text);
  const isShort = /\b(short|sell|bear)\b/i.test(text) || /🔴|📉/.test(text);
  if (isLong === isShort) return null; // none or ambiguous
  const side: TradeSide = isLong ? "long" : "short";

  const symbol = extractSymbol(text, side);
  if (!symbol) return null;

  const entry = firstNumber(text, [
    /\b(?:entry|enter|entradas?|einstieg)\b[:\s@]*([0-9][0-9.,]*)/i,
    /@\s*([0-9][0-9.,]*)/,
    /\bprice\b[:\s]*([0-9][0-9.,]*)/i,
  ]);

  const stopLoss = firstNumber(text, [
    /\b(?:sl|stop[\s-]?loss|stop)\b[:\s]*([0-9][0-9.,]*)/i,
    /🛑[:\s]*([0-9][0-9.,]*)/,
  ]);

  const takeProfits = allNumbers(
    text,
    /\b(?:tp\d*|take[\s-]?profit\d*|target\d*|ziel\d*)\b[:\s]*([0-9][0-9.,]*)/gi,
  );

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
