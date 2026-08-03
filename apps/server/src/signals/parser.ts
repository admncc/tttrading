import type { ParsedSignal } from "@tttrading/shared";
import { parseWithRegex } from "./regex.js";
import { parseWithLlm, llmReady, type SignalImage } from "./llm.js";
import { settings } from "../db/repositories.js";
import { event } from "../logger.js";

/** Confidence at or above which the regex result is trusted without the LLM. */
const REGEX_TRUST = 0.75;
/** Minimum confidence for an LLM result to be accepted. */
const LLM_MIN = 0.5;

/** Log when the two parsers disagree on symbol/side (visible in Logs → message). */
function crossCheck(rx: ParsedSignal | null, llm: ParsedSignal | null): void {
  if (!rx || !llm) return;
  if (rx.symbol.toUpperCase() !== llm.symbol.toUpperCase() || rx.side !== llm.side) {
    event(
      "message",
      `Parser disagreement — regex ${rx.side} ${rx.symbol} vs LLM ${llm.side} ${llm.symbol}`,
      { regex: { symbol: rx.symbol, side: rx.side }, llm: { symbol: llm.symbol, side: llm.side } },
      { level: "warn" },
    );
  }
}

/**
 * Combined parsing. Two modes (Settings → Message Processing):
 *  - "regex" (default): fast rules first; fall back to the LLM when the regex is
 *    missing/low-confidence or the channel has custom instructions.
 *  - "llm": LLM first (higher priority), with the deterministic rules kept as a
 *    cross-check — a strong regex hit is used as a guardrail if the LLM declines.
 * Returns the best result, or null when the message isn't an actionable signal.
 */
export async function parseSignal(
  text: string,
  instructions?: string,
  image?: SignalImage,
): Promise<ParsedSignal | null> {
  const rx = parseWithRegex(text);

  // LLM path: when the mode is "llm" OR a chart image is attached (only the LLM
  // can read the drawn levels), parse with the LLM and keep the rules as a
  // guardrail. Regex alone can't use the image.
  if ((settings.getParseMode() === "llm" || image) && llmReady()) {
    const llm = await parseWithLlm(text, instructions, image);
    crossCheck(rx, llm);
    if (llm && llm.confidence >= LLM_MIN) return llm;
    // LLM declined — fall back to a strong (trusted) regex hit as a guardrail.
    if (rx && rx.confidence >= REGEX_TRUST) return rx;
    return null;
  }

  // Regex-first (default).
  // With channel instructions, prefer the LLM even on a decent regex hit —
  // the instructions encode this channel's quirks the regex can't know.
  if (rx && rx.confidence >= REGEX_TRUST && !instructions?.trim()) return rx;

  if (llmReady()) {
    const llm = await parseWithLlm(text, instructions);
    crossCheck(rx, llm);
    if (llm && llm.confidence >= LLM_MIN) return llm;
    // The LLM judged this NOT an actionable signal (or low confidence). Trust it
    // over a shaky sub-threshold regex hit to avoid false-positive trades.
    return null;
  }

  // No LLM configured: fall back to a low-confidence regex hit if we have one.
  return rx;
}
