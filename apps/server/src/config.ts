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

// Validate TRADING_ENV against the allowed set. An unknown/typo'd value must
// NEVER silently fall through to the live-mainnet branch — fail closed to paper.
const rawEnv = (process.env.TRADING_ENV ?? "testnet").trim();
const VALID_ENVS: TradingEnv[] = ["testnet", "mainnet", "paper"];
if (!VALID_ENVS.includes(rawEnv as TradingEnv)) {
  // eslint-disable-next-line no-console
  console.error(
    `[config] Invalid TRADING_ENV="${rawEnv}". Must be one of ${VALID_ENVS.join(", ")}. ` +
      `Falling back to "paper" (no real orders).`,
  );
}
const tradingEnv: TradingEnv = VALID_ENVS.includes(rawEnv as TradingEnv)
  ? (rawEnv as TradingEnv)
  : "paper";

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

  /** How often to pull mark prices for open trades (live unrealized PnL). */
  priceTickerMs: num(process.env.PRICE_TICKER_MS, 300000),

  hyperliquid: {
    /** Private key of the Hyperliquid API/agent wallet (0x...). */
    privateKey: process.env.HL_PRIVATE_KEY || "",
    /** Main account address (for reading state); defaults to wallet address. */
    accountAddress: process.env.HL_ACCOUNT_ADDRESS || "",
  },

  aster: {
    /**
     * Aster (asterdex.com) — a backup venue for symbols Hyperliquid doesn't
     * list. Participates in routing only when enabled (or when an API key is
     * present). Real orders need both key & secret; otherwise it behaves like
     * paper (market data + simulated fills), exactly like the HL connector.
     */
    enabled:
      bool(process.env.ASTER_ENABLED, false) || !!(process.env.ASTER_API_KEY || "").trim(),
    apiKey: (process.env.ASTER_API_KEY || "").trim(),
    apiSecret: (process.env.ASTER_API_SECRET || "").trim(),
    /** USDⓈ-M futures REST host. Override for testnet. */
    baseUrl: (process.env.ASTER_BASE_URL || "https://fapi.asterdex.com").replace(/\/+$/, ""),
    /** Fallback max leverage when exchangeInfo doesn't report one per symbol. */
    defaultMaxLeverage: num(process.env.ASTER_MAX_LEVERAGE, 20),
  },

  mexc: {
    /**
     * MEXC (mexc.com) — the LAST backup, after Aster. MEXC's contract API uses
     * contract-unit sizing, numeric side codes and an entry-attached SL/TP model
     * that differs from the others, and its futures order API only reopened in
     * Jan 2026 with no public testnet. Real order execution is therefore NOT
     * enabled yet: MEXC provides routing + market data + SIMULATION only, so a
     * MEXC-only coin is tracked instead of hard-failing. Enable participation to
     * catch those symbols; real sending is a separate, validated follow-up.
     */
    enabled: bool(process.env.MEXC_ENABLED, false),
    /** USDⓈ-M contract REST host. */
    baseUrl: (process.env.MEXC_BASE_URL || "https://contract.mexc.com").replace(/\/+$/, ""),
    defaultMaxLeverage: num(process.env.MEXC_MAX_LEVERAGE, 20),
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
    /** Periodically let the AI refine each channel's parsing instructions. */
    autoRefine: bool(process.env.AUTO_REFINE_INSTRUCTIONS, false),
    /** Min days between auto-refines of the same channel. */
    autoRefineDays: num(process.env.AUTO_REFINE_DAYS, 7),
    /** Min stored messages a channel needs before it is auto-refined. */
    autoRefineMinMessages: num(process.env.AUTO_REFINE_MIN_MESSAGES, 25),
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
    /** Send a daily performance summary to the alert chat. */
    dailyReport: bool(process.env.ALERT_DAILY_REPORT, false),
    /** Send a weekly performance summary to the alert chat. */
    weeklyReport: bool(process.env.ALERT_WEEKLY_REPORT, false),
    /** Hour (UTC) at which the daily/weekly report is sent. */
    reportHour: num(process.env.ALERT_REPORT_HOUR, 8),
    /** Weekday for the weekly report (0=Sun … 1=Mon … 6=Sat). */
    reportWeekday: num(process.env.ALERT_REPORT_WEEKDAY, 1),
  },

  /** Directory of the built web app to serve in production (if present). */
  webDist: process.env.WEB_DIST || path.resolve(__dirname, "../../web/dist"),

  /**
   * CORS allow-list. Empty => same-origin only (the desk is served from the API,
   * so this is the safe default). Set CORS_ORIGIN to "*" or a comma list to open.
   */
  corsOrigin: process.env.CORS_ORIGIN || "",

  selfUpdate: {
    /** Allow the "Update" button to pull + rebuild. Off by default (security). */
    enabled: bool(process.env.ALLOW_SELF_UPDATE, false),
    /** Path to the git checkout to update (bind-mounted at the same host path). */
    repoDir: process.env.REPO_DIR || path.resolve(__dirname, "../../.."),
    /** docker compose project name (must match the running stack). */
    project: process.env.COMPOSE_PROJECT_NAME || "tttrading",
    /** Override the update command; empty => sensible default (see update.ts). */
    command: process.env.UPDATE_COMMAND || "",
  },
} as const;

/** Whether the desk API requires a login. */
export const authEnabled = !!config.auth.password;

/** Whether Telegram bot alerts are configured. */
export const alertsEnabled = !!(config.alerts.telegramBotToken && config.alerts.telegramChatId);

export function hyperliquidReady(): boolean {
  return !config.isPaper && !!config.hyperliquid.privateKey;
}

/** Aster can sign & send real orders (key + secret present, not paper mode). */
export function asterReady(): boolean {
  return !config.isPaper && !!config.aster.apiKey && !!config.aster.apiSecret;
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
