import type { ParsedSignal } from "@tttrading/shared";
import { parseWithRegex } from "./regex.js";
import { parseWithLlm, llmReady } from "./llm.js";

/** Confidence at or above which the regex result is trusted without the LLM. */
const REGEX_TRUST = 0.75;
/** Minimum confidence for an LLM result to be accepted. */
const LLM_MIN = 0.5;

/**
 * Combined parsing: try the fast regex parser first; if it's missing or low
 * confidence, fall back to the LLM (when configured). Returns the best result
 * or null when the message isn't an actionable signal.
 */
export async function parseSignal(text: string): Promise<ParsedSignal | null> {
  const rx = parseWithRegex(text);
  if (rx && rx.confidence >= REGEX_TRUST) return rx;

  if (llmReady()) {
    const llm = await parseWithLlm(text);
    if (llm && llm.confidence >= LLM_MIN) return llm;
    // The LLM judged this NOT an actionable signal (or low confidence). Trust it
    // over a shaky sub-threshold regex hit to avoid false-positive trades.
    return null;
  }

  // No LLM configured: fall back to a low-confidence regex hit if we have one.
  return rx;
}
