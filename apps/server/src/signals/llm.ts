import Anthropic from "@anthropic-ai/sdk";
import type { ParsedSignal, TradeSide } from "@tttrading/shared";
import { config } from "../config.js";
import { settings } from "../db/repositories.js";
import { log } from "../logger.js";

/** Effective key/model: desk-configured value (DB) wins over the .env default. */
function effectiveKey(): string {
  return settings.getAnthropicKey() || config.anthropic.apiKey;
}
function effectiveModel(): string {
  return settings.getAnthropicModel() || config.anthropic.model;
}

/** Whether the LLM fallback is available (key set via desk or env). */
export function llmReady(): boolean {
  return !!effectiveKey();
}

let client: Anthropic | null = null;
let clientKey = "";
function getClient(): Anthropic {
  const key = effectiveKey();
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key });
    clientKey = key;
  }
  return client;
}

const EXTRACT_TOOL: Anthropic.Tool = {
  name: "record_signal",
  description:
    "Record a parsed crypto trading signal. Only call this when the message is genuinely a trade signal.",
  input_schema: {
    type: "object",
    properties: {
      is_signal: {
        type: "boolean",
        description: "True only if the message is an actionable trade signal.",
      },
      symbol: { type: "string", description: "Base asset ticker, e.g. BTC, ETH, SOL." },
      side: { type: "string", enum: ["long", "short"] },
      entry: { type: "number", description: "Entry price. Omit for market entry." },
      stop_loss: { type: "number" },
      take_profits: { type: "array", items: { type: "number" } },
      leverage: { type: "number", description: "Suggested leverage, if stated." },
      confidence: {
        type: "number",
        description: "0..1 confidence that the extraction is correct.",
      },
    },
    required: ["is_signal", "confidence"],
  },
};

const SYSTEM = `You extract structured crypto perpetual trading signals from noisy Telegram messages
in any language. Normalize the ticker to its base symbol (drop USDT/USDC/PERP suffixes).
If the message is chat, news, or not actionable, set is_signal=false.`;

interface ExtractInput {
  is_signal: boolean;
  symbol?: string;
  side?: TradeSide;
  entry?: number;
  stop_loss?: number;
  take_profits?: number[];
  leverage?: number;
  confidence: number;
}

/** Parse a message with Claude. Returns null if not a signal or on error. */
export async function parseWithLlm(text: string): Promise<ParsedSignal | null> {
  if (!llmReady()) return null;
  try {
    const res = await getClient().messages.create({
      model: effectiveModel(),
      max_tokens: 512,
      system: SYSTEM,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: "tool", name: "record_signal" },
      messages: [{ role: "user", content: text }],
    });

    const toolUse = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (!toolUse) return null;
    const input = toolUse.input as ExtractInput;

    // Validate — tool schemas are advisory, not enforced.
    if (!input.is_signal) return null;
    if (typeof input.symbol !== "string" || !input.symbol.trim()) return null;
    if (input.side !== "long" && input.side !== "short") return null;
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    const tps = Array.isArray(input.take_profits)
      ? input.take_profits.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
      : [];

    return {
      symbol: input.symbol.trim().toUpperCase(),
      side: input.side,
      entry: num(input.entry),
      stopLoss: num(input.stop_loss),
      takeProfits: tps.length ? tps : undefined,
      leverageHint: num(input.leverage),
      confidence: Math.max(0, Math.min(1, num(input.confidence) ?? 0.7)),
      source: "llm",
    };
  } catch (err) {
    log.error("LLM signal parse failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
