import dotenv from "dotenv";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { TradingEnv } from "@tttrading/shared";

// Load .env from the repo root (two levels up from apps/server/src).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

function bool(v: string | undefined, def = false): boolean {
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function num(v: string | undefined, def: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}

const tradingEnv = (process.env.TRADING_ENV as TradingEnv) || "testnet";

export const config = {
  /** HTTP + WebSocket port for the desk API. */
  port: num(process.env.PORT, 4000),
  host: process.env.HOST || "0.0.0.0",

  /** Where the SQLite file lives. */
  dbPath: process.env.DB_PATH || path.resolve(__dirname, "../../../data/tttrading.sqlite"),

  /** testnet | mainnet | paper. Controls whether real orders are sent. */
  tradingEnv,
  isPaper: tradingEnv === "paper",
  isTestnet: tradingEnv === "testnet",

  /** Seed a couple of demo groups + trades on an empty database. */
  seedDemo: bool(process.env.SEED_DEMO, true),

  /** How often the reconciliation monitor polls the exchange (live only). */
  monitorIntervalMs: num(process.env.MONITOR_INTERVAL_MS, 15000),

  hyperliquid: {
    /** Private key of the Hyperliquid API/agent wallet (0x...). */
    privateKey: process.env.HL_PRIVATE_KEY || "",
    /** Main account address (for reading state); defaults to wallet address. */
    accountAddress: process.env.HL_ACCOUNT_ADDRESS || "",
  },

  telegram: {
    apiId: num(process.env.TG_API_ID, 0),
    apiHash: process.env.TG_API_HASH || "",
    /** StringSession value produced on first interactive login. */
    session: process.env.TG_SESSION || "",
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  },

  auth: {
    /** Desk password. Empty => authentication disabled. */
    password: process.env.DESK_PASSWORD || "",
    /** HMAC secret for session tokens; random per process if unset. */
    secret: process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex"),
    /** Session token lifetime in hours (default 1 week). */
    tokenTtlHours: num(process.env.AUTH_TOKEN_TTL_HOURS, 168),
  },

  alerts: {
    /** Telegram BOT token (separate from the user session used for reading). */
    telegramBotToken: process.env.ALERT_TG_BOT_TOKEN || "",
    /** Chat/channel id the bot posts alerts to. */
    telegramChatId: process.env.ALERT_TG_CHAT_ID || "",
    onFill: bool(process.env.ALERT_ON_FILL, true),
    onError: bool(process.env.ALERT_ON_ERROR, true),
    onBlocked: bool(process.env.ALERT_ON_BLOCKED, false),
  },

  /** Directory of the built web app to serve in production (if present). */
  webDist: process.env.WEB_DIST || path.resolve(__dirname, "../../web/dist"),
} as const;

/** Whether the desk API requires a login. */
export const authEnabled = !!config.auth.password;

/** Whether Telegram bot alerts are configured. */
export const alertsEnabled = !!(config.alerts.telegramBotToken && config.alerts.telegramChatId);

export function hyperliquidReady(): boolean {
  return !config.isPaper && !!config.hyperliquid.privateKey;
}

export function telegramReady(): boolean {
  return (
    config.telegram.apiId > 0 &&
    !!config.telegram.apiHash &&
    !!config.telegram.session
  );
}

export function llmReady(): boolean {
  return !!config.anthropic.apiKey;
}
