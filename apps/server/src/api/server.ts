import fs from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import type { WsEvent } from "@tttrading/shared";
import { config, authEnabled } from "../config.js";
import { checkUpdates, runUpdate } from "../system/update.js";
import { bearer, checkPassword, signToken, verifyToken } from "../auth.js";
import { log, event } from "../logger.js";
import type { FastifyRequest } from "fastify";

/** Record a desk action to the audit trail (category "audit"), with requester IP. */
function audit(req: FastifyRequest, message: string, meta?: Record<string, unknown>): void {
  event("audit", message, { ...meta, ip: req.ip }, { level: "warn" });
}

/**
 * A desk-entered exchange base URL must be a PUBLIC https host — the connectors
 * send the API key in a header, so allowing an internal/loopback/metadata host
 * would be an SSRF + key-exfiltration vector. Empty clears to the env default.
 * (Advanced/local overrides can still be set via the env var, which is trusted.)
 */
function isSafeExchangeUrl(s: string): boolean {
  if (s === "") return true;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return false;
  if (h.includes(":") || h === "0.0.0.0") return false; // IPv6 literal / wildcard
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // Block private / loopback / link-local / multicast IPv4 literals.
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
  }
  return true;
}
import {
  groups as groupsRepo,
  logs as logsRepo,
  messageImages as messageImagesRepo,
  settings as settingsRepo,
  signals as signalsRepo,
  trades as tradesRepo,
} from "../db/repositories.js";
import { dashboard, analytics } from "../stats/service.js";
import { sanitizedBackup } from "../db/index.js";
import { sendReport } from "../alerts/report.js";
import { hyperliquid, hyperliquidTestnet } from "../hyperliquid/connector.js";
import { all as allExchanges, activeHyperliquid, byName as exchangeByName } from "../exchanges/registry.js";
import {
  asterUser,
  asterSigner,
  asterPrivateKey,
  asterBaseUrl,
  asterEnabled,
  hlAccountAddress,
  hlEnabled,
  hlPrivateKey,
  mexcApiKey,
  mexcApiSecret,
  mexcBaseUrl,
  mexcEnabled,
} from "../exchanges/credentials.js";
import {
  bookTradePartial,
  cancelWorkingTrade,
  closeAllTrades,
  closeTrade,
  confirmSignal,
  placeTestOrder,
  rejectSignal,
  setTradeStop,
  setTradeTakeProfits,
  submitManual,
} from "../execution/engine.js";
import { reconcileOnce, evaluateSimulated } from "../execution/monitor.js";
import { backfillAll, backfillGroup } from "../telegram/backfill.js";
import { getListenerHealth } from "../telegram/listener.js";
import { getPrices } from "../market/ticker.js";
import { backtestGroup } from "../backtest/engine.js";
import { suggestChannelInstructions } from "../signals/llm.js";
import { exportAllText, exportGroupText, safeFilename } from "../export/text.js";
import { broadcast, register, unregister, type SocketLike } from "../ws/hub.js";

const groupSettingsSchema = z.object({
  leverage: z.number().positive().max(100),
  tradeSizeUsd: z.number().positive().max(10_000_000),
  executionMode: z.enum(["auto", "confirm"]),
  marginMode: z.enum(["cross", "isolated"]),
  maxSlippage: z.number().min(0).max(0.2),
  autoSplitSingleTp: z.boolean(),
  tpLevels: z.number().int().min(1).max(10),
  breakevenAfterTp: z.number().int().min(0).max(10),
  blockRedTrades: z.boolean(),
  entryMode: z.enum(["limit", "market"]).optional(),
  limitTimeoutHours: z.number().min(0).max(8760).optional(),
  sizingMode: z.enum(["fixed", "percentEquity", "riskPerTrade"]).optional(),
  riskValue: z.number().min(0).max(1_000_000).optional(),
  symbolCooldownMinutes: z.number().min(0).max(100000).optional(),
  instructions: z.string().max(8000).optional(),
  allowedSymbols: z.array(z.string().max(20)).max(500).optional(),
});

const groupInputSchema = z.object({
  name: z.string().min(1).max(200),
  telegramChannel: z.string().min(1).max(200),
  enabled: z.boolean(),
  settings: groupSettingsSchema,
});

export async function buildServer() {
  const app = Fastify({ logger: false });

  // Tolerate empty JSON bodies (e.g. DELETE / no-body POSTs) instead of 400.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const s = (body as string).trim();
      if (!s) return done(null, {});
      try {
        done(null, JSON.parse(s));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  // Reject the reflect-all wildcard — require an explicit host allow-list, else
  // same-origin only (the desk is served from this API, so that's the safe default).
  if (config.corsOrigin === "*") {
    log.warn('CORS_ORIGIN="*" is not allowed (reflects every origin) — using same-origin only.');
  }
  const corsOrigin =
    config.corsOrigin && config.corsOrigin !== "*"
      ? config.corsOrigin.split(",").map((s) => s.trim())
      : false;
  await app.register(cors, { origin: corsOrigin });
  await app.register(websocket);

  /* -------------------------------- auth ------------------------------ */
  // Guard every /api route except health and login. WebSocket auth is handled
  // inside the /ws handler (query token). No-op when auth is disabled.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS") return;
    const path = req.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return;
    if (path === "/api/health" || path === "/api/login") return;
    if (!authEnabled) {
      // No password configured: allow safe reads, but FAIL CLOSED on every
      // mutation (a mutating route must never run unauthenticated — closing a
      // position, confirming a signal, changing keys, etc.). Set DESK_PASSWORD.
      const m = req.method.toUpperCase();
      if (m === "GET" || m === "HEAD") return;
      return reply.code(403).send({ error: "Set DESK_PASSWORD to enable changes." });
    }
    if (!verifyToken(bearer(req.headers.authorization))) {
      // Fallback: a token query param, for resources loaded via <img>/<a> tags
      // that can't set an Authorization header (e.g. message chart images).
      const q = (req.query as { token?: string } | undefined)?.token;
      if (q && verifyToken(q)) return;
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  // Simple in-memory brute-force throttle for the login endpoint.
  const loginAttempts = new Map<string, { count: number; until: number }>();
  const MAX_ATTEMPTS = 8;
  const LOCK_MS = 5 * 60_000;

  app.post("/api/login", async (req, reply) => {
    if (!authEnabled) return { token: null, authRequired: false };
    const ip = req.ip || "unknown";
    const rec = loginAttempts.get(ip);
    const now = Date.now();
    if (rec && rec.count >= MAX_ATTEMPTS && now < rec.until) {
      return reply.code(429).send({ error: "too many attempts — try again later" });
    }
    const schema = z.object({ password: z.string() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "password required" });
    if (!checkPassword(parsed.data.password)) {
      const count = (rec && now < rec.until ? rec.count : 0) + 1;
      loginAttempts.set(ip, { count, until: now + LOCK_MS });
      return reply.code(401).send({ error: "invalid password" });
    }
    loginAttempts.delete(ip);
    return { token: signToken(), authRequired: true };
  });

  /* ------------------------------ health ------------------------------ */
  app.get("/api/health", async () => ({
    ok: true,
    env: config.tradingEnv,
    // The HL network signals actually route to right now (set via the desk
    // switch), independent of the process-level TRADING_ENV. This is what the
    // desk badge should reflect — "am I trading real mainnet funds?".
    activeNetwork: activeHyperliquid().name === "hyperliquid" ? "mainnet" : "testnet",
    live: activeHyperliquid().live,
    shadowMode: settingsRepo.getShadowMode(),
    tradingPaused: settingsRepo.getTradingPaused(),
    authRequired: authEnabled,
    updateEnabled: config.selfUpdate.enabled,
    // Venues in the routing chain (primary first) and whether each can trade live.
    exchanges: allExchanges().map((e) => ({ name: e.name, live: e.live })),
    time: new Date().toISOString(),
  }));

  /* ------------------------------ updates ----------------------------- */
  app.get("/api/update/check", async () => checkUpdates());

  app.post("/api/update", async (_req, reply) => {
    if (!config.selfUpdate.enabled) {
      return reply.code(403).send({ error: "self-update disabled" });
    }
    const res = runUpdate();
    if (!res.started) return reply.code(500).send(res);
    return { ok: true, message: "Update started — the desk will restart shortly." };
  });

  /* -------------------------- global settings ------------------------- */
  const settingsPayload = () => ({
    ...settingsRepo.getGlobalSettings(),
    // Never expose the key itself — only whether one is configured (desk or env).
    anthropicConfigured: !!(settingsRepo.getAnthropicKey() || config.anthropic.apiKey),
    anthropicKeySource: settingsRepo.getAnthropicKey() ? "desk" : config.anthropic.apiKey ? "env" : "none",
    anthropicModel: settingsRepo.getAnthropicModel() || config.anthropic.model,
    autoRefine: settingsRepo.getAutoRefine(config.anthropic.autoRefine),
    parseMode: settingsRepo.getParseMode(),
  });
  app.get("/api/settings", async () => settingsPayload());

  app.put("/api/settings", async (req, reply) => {
    if (!authEnabled) return reply.code(403).send({ error: "Set DESK_PASSWORD to change settings." });
    const schema = z.object({
      shadowMode: z.boolean().optional(),
      tradingPaused: z.boolean().optional(),
      dailyLossLimitUsd: z.number().min(0).max(1e9).optional(),
      maxOpenTrades: z.number().int().min(0).max(1000).optional(),
      maxExposureUsd: z.number().min(0).max(1e9).optional(),
      liveMaxOrderUsd: z.number().min(0).max(1e9).optional(),
      splitOpposingVenues: z.boolean().optional(),
      anthropicKey: z.string().max(500).optional(), // "" clears the desk-stored key
      anthropicModel: z.string().max(100).optional(),
      autoRefine: z.boolean().optional(),
      parseMode: z.enum(["regex", "llm"]).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const d = parsed.data;
    if (d.autoRefine !== undefined) settingsRepo.setAutoRefine(d.autoRefine);
    if (d.shadowMode !== undefined) {
      settingsRepo.setShadowMode(d.shadowMode);
      log.info(`Shadow (test) mode ${d.shadowMode ? "ENABLED" : "DISABLED — LIVE TRADING"}.`);
    }
    if (d.tradingPaused !== undefined) {
      settingsRepo.setTradingPaused(d.tradingPaused);
      log.info(`Trading ${d.tradingPaused ? "PAUSED (kill-switch)" : "resumed"}.`);
    }
    if (d.dailyLossLimitUsd !== undefined) settingsRepo.setRiskLimit("dailyLossLimitUsd", d.dailyLossLimitUsd);
    if (d.maxOpenTrades !== undefined) settingsRepo.setRiskLimit("maxOpenTrades", d.maxOpenTrades);
    if (d.maxExposureUsd !== undefined) settingsRepo.setRiskLimit("maxExposureUsd", d.maxExposureUsd);
    if (d.liveMaxOrderUsd !== undefined) settingsRepo.setRiskLimit("liveMaxOrderUsd", d.liveMaxOrderUsd);
    if (d.splitOpposingVenues !== undefined) settingsRepo.setSplitOpposingVenues(d.splitOpposingVenues);
    if (d.parseMode !== undefined) settingsRepo.setParseMode(d.parseMode);
    if (d.anthropicKey !== undefined) {
      settingsRepo.setAnthropicKey(d.anthropicKey.trim());
      log.info(`Anthropic key ${d.anthropicKey.trim() ? "updated via desk" : "cleared"}.`);
    }
    if (d.anthropicModel !== undefined) settingsRepo.setAnthropicModel(d.anthropicModel.trim());
    audit(req, "settings updated", { fields: Object.keys(d) });
    broadcast({ type: "settings", settings: settingsRepo.getGlobalSettings() });
    return settingsPayload();
  });

  /* --------------------------- exchanges (keys) ----------------------- */
  // Never returns secret values — only whether each key is configured, plus the
  // non-secret bits (enabled, base URL, addresses). Desk-entered keys are stored
  // in the DB and override the env; secrets are redacted from backups.
  const hlBlock = (net: "mainnet" | "testnet", conn: typeof hyperliquid, name: string) => ({
    name,
    enabled: hlEnabled(net),
    live: conn.live,
    privateKeyConfigured: !!hlPrivateKey(net),
    keySource: settingsRepo.hasExchangeValue(`hl.${net}.privateKey`)
      ? "desk"
      : config.hyperliquid[net].privateKey
        ? "env"
        : "none",
    accountAddress: hlAccountAddress(net) || null,
    signer: conn.signerAddress(),
  });
  const exchangesPayload = () => ({
    env: config.tradingEnv,
    priority: settingsRepo.getExchangePriority(),
    hyperliquid: hlBlock("mainnet", hyperliquid, "hyperliquid"),
    hyperliquidTestnet: hlBlock("testnet", hyperliquidTestnet, "hyperliquid-testnet"),
    aster: {
      name: "aster" as const,
      enabled: asterEnabled(),
      live: exchangeByName("aster").live,
      // Addresses are non-secret and shown; the private key is write-only.
      user: asterUser() || null,
      signer: asterSigner() || null,
      privateKeyConfigured: !!asterPrivateKey(),
      keySource: settingsRepo.hasExchangeValue("aster.privateKey")
        ? "desk"
        : config.aster.privateKey
          ? "env"
          : "none",
      baseUrl: asterBaseUrl(),
    },
    mexc: {
      name: "mexc" as const,
      enabled: mexcEnabled(),
      live: exchangeByName("mexc").live,
      apiKeyConfigured: !!mexcApiKey(),
      apiSecretConfigured: !!mexcApiSecret(),
      keySource: settingsRepo.hasExchangeValue("mexc.apiKey")
        ? "desk"
        : config.mexc.apiKey
          ? "env"
          : "none",
      baseUrl: mexcBaseUrl(),
      note: "contract-sized; no testnet — validate live with minimum size",
    },
  });
  app.get("/api/exchanges", async () => exchangesPayload());

  app.put("/api/exchanges", async (req, reply) => {
    if (!authEnabled) return reply.code(403).send({ error: "Set DESK_PASSWORD to change exchange settings." });
    const url = z
      .string()
      .max(200)
      .transform((s) => s.trim())
      .refine(isSafeExchangeUrl, "must be a public https:// URL (no internal/loopback hosts)");
    const hlSchema = z
      .object({
        enabled: z.boolean().optional(),
        privateKey: z.string().max(200).optional(), // "" clears the desk-stored key
        accountAddress: z.string().max(120).optional(),
      })
      .optional();
    const schema = z.object({
      priority: z.array(z.enum(["hyperliquid", "hyperliquid-testnet", "aster", "mexc"])).max(4).optional(),
      hyperliquid: hlSchema,
      hyperliquidTestnet: hlSchema,
      aster: z
        .object({
          enabled: z.boolean().optional(),
          user: z.string().max(120).optional(),
          signer: z.string().max(120).optional(),
          privateKey: z.string().max(200).optional(), // "" clears the desk-stored key
          baseUrl: url.optional(),
        })
        .optional(),
      mexc: z
        .object({
          enabled: z.boolean().optional(),
          apiKey: z.string().max(200).optional(),
          apiSecret: z.string().max(200).optional(),
          baseUrl: url.optional(),
        })
        .optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const d = parsed.data;

    if (d.priority) settingsRepo.setExchangePriority(d.priority);
    const applyHl = (
      net: "mainnet" | "testnet",
      conn: typeof hyperliquid,
      patch: { enabled?: boolean; privateKey?: string; accountAddress?: string } | undefined,
    ) => {
      if (!patch) return;
      if (patch.enabled !== undefined) settingsRepo.setExchangeFlag(`hl.${net}.enabled`, patch.enabled);
      if (patch.privateKey !== undefined) {
        settingsRepo.setExchangeValue(`hl.${net}.privateKey`, patch.privateKey.trim());
        log.info(`Hyperliquid ${net} key ${patch.privateKey.trim() ? "updated via desk" : "cleared"}.`);
      }
      if (patch.accountAddress !== undefined) {
        settingsRepo.setExchangeValue(`hl.${net}.accountAddress`, patch.accountAddress.trim());
      }
      conn.reloadCredentials(); // rebuild the signer with the new key
    };
    applyHl("mainnet", hyperliquid, d.hyperliquid);
    applyHl("testnet", hyperliquidTestnet, d.hyperliquidTestnet);
    if (d.aster) {
      if (d.aster.enabled !== undefined) settingsRepo.setExchangeFlag("aster.enabled", d.aster.enabled);
      if (d.aster.user !== undefined) settingsRepo.setExchangeValue("aster.user", d.aster.user.trim());
      if (d.aster.signer !== undefined) settingsRepo.setExchangeValue("aster.signer", d.aster.signer.trim());
      if (d.aster.privateKey !== undefined) {
        settingsRepo.setExchangeValue("aster.privateKey", d.aster.privateKey.trim());
        log.info(`Aster API-wallet key ${d.aster.privateKey.trim() ? "updated via desk" : "cleared"}.`);
      }
      if (d.aster.baseUrl !== undefined) settingsRepo.setExchangeValue("aster.baseUrl", d.aster.baseUrl.trim());
    }
    if (d.mexc) {
      if (d.mexc.enabled !== undefined) settingsRepo.setExchangeFlag("mexc.enabled", d.mexc.enabled);
      if (d.mexc.apiKey !== undefined) {
        settingsRepo.setExchangeValue("mexc.apiKey", d.mexc.apiKey.trim());
        log.info(`MEXC API key ${d.mexc.apiKey.trim() ? "updated via desk" : "cleared"}.`);
      }
      if (d.mexc.apiSecret !== undefined) settingsRepo.setExchangeValue("mexc.apiSecret", d.mexc.apiSecret.trim());
      if (d.mexc.baseUrl !== undefined) settingsRepo.setExchangeValue("mexc.baseUrl", d.mexc.baseUrl.trim());
    }
    audit(req, "exchange settings updated", { venues: Object.keys(d) });
    return exchangesPayload();
  });

  // One-click switch of the ACTIVE Hyperliquid network (mainnet ⇄ testnet).
  // Enables the chosen network's venue, disables the other, and reorders the
  // routing priority so the chosen HL venue leads. No restart needed — the
  // connectors rebuild their signer. NOTE: switching to mainnet only sends REAL
  // orders once a mainnet key is configured; without one the venue simulates.
  app.post("/api/exchanges/hl-network", async (req, reply) => {
    if (!authEnabled) return reply.code(403).send({ error: "Set DESK_PASSWORD to switch networks." });
    const schema = z.object({ network: z.enum(["mainnet", "testnet"]) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { network } = parsed.data;
    const targetName = network === "mainnet" ? "hyperliquid" : "hyperliquid-testnet";
    const otherName = network === "mainnet" ? "hyperliquid-testnet" : "hyperliquid";

    settingsRepo.setExchangeFlag("hl.mainnet.enabled", network === "mainnet");
    settingsRepo.setExchangeFlag("hl.testnet.enabled", network === "testnet");

    // Put the chosen HL venue first, the other HL venue right after it (kept for
    // when they switch back), then the remaining venues in their existing order.
    const current = settingsRepo.getExchangePriority();
    const rest = current.filter((n) => n !== "hyperliquid" && n !== "hyperliquid-testnet");
    settingsRepo.setExchangePriority([targetName, otherName, ...rest] as typeof current);

    hyperliquid.reloadCredentials();
    hyperliquidTestnet.reloadCredentials();

    const liveNow = network === "mainnet" ? hyperliquid.live : hyperliquidTestnet.live;
    audit(req, "hyperliquid network switched", { network, live: liveNow });
    event(
      "exec",
      `Hyperliquid switched to ${network.toUpperCase()}${liveNow ? "" : " (no key — orders will be simulated)"}`,
      { network, live: liveNow },
      { level: network === "mainnet" ? "warn" : "info" },
    );
    return exchangesPayload();
  });

  // Kill-switch: close all open positions AND pause new entries.
  app.post("/api/kill", async (req, reply) => {
    if (!authEnabled) return reply.code(403).send({ error: "Set DESK_PASSWORD to enable the kill-switch." });
    settingsRepo.setTradingPaused(true);
    const res = await closeAllTrades();
    audit(req, "KILL-SWITCH activated", res);
    broadcast({ type: "settings", settings: settingsRepo.getGlobalSettings() });
    log.warn(`KILL-SWITCH activated — trading paused, closed ${res.closed} trades.`);
    return { ok: true, ...res };
  });

  // Mainnet-readiness checklist for the desk (before flipping to live).
  app.get("/api/readiness", async () => {
    const g = settingsRepo.getGlobalSettings();
    const hl = activeHyperliquid();
    let accountValue: number | undefined;
    try {
      accountValue = (await hl.getAccountSummary())?.accountValue;
    } catch {
      /* ignore */
    }
    const checks = [
      { key: "signingKey", ok: hl.live, label: "Signing key configured" },
      {
        key: "accountAddress",
        ok: !!hl.publicAddress(),
        label: "Account address set",
      },
      { key: "balance", ok: (accountValue ?? 0) > 0, label: "Perps account funded" },
      {
        key: "riskLimits",
        ok: g.dailyLossLimitUsd > 0 || g.maxExposureUsd > 0 || g.maxOpenTrades > 0,
        label: "At least one risk limit set",
      },
      { key: "notPaused", ok: !g.tradingPaused, label: "Trading not paused" },
    ];
    return { env: config.tradingEnv, accountValue, checks, ready: checks.every((c) => c.ok) };
  });

  // Download a backup of the SQLite database, with the desk-stored Anthropic
  // key stripped. Fails closed without a desk password (it carries trade data).
  app.get("/api/backup", async (_req, reply) => {
    if (!authEnabled) return reply.code(403).send({ error: "Set DESK_PASSWORD to enable backups." });
    const buf = sanitizedBackup();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    reply
      .type("application/octet-stream")
      .header("Content-Disposition", `attachment; filename="tttrading-backup-${stamp}.sqlite"`);
    return buf;
  });

  /* ------------------------------ groups ------------------------------ */
  app.get("/api/groups", async () => groupsRepo.list());

  app.post("/api/groups", async (req, reply) => {
    const parsed = groupInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const group = groupsRepo.create(parsed.data);
    broadcast({ type: "group", group });
    return group;
  });

  app.put<{ Params: { id: string } }>("/api/groups/:id", async (req, reply) => {
    const parsed = groupInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const group = groupsRepo.update(req.params.id, parsed.data);
    if (!group) return reply.code(404).send({ error: "not found" });
    broadcast({ type: "group", group });
    return group;
  });

  app.delete<{ Params: { id: string } }>("/api/groups/:id", async (req) => {
    groupsRepo.remove(req.params.id);
    return { ok: true };
  });

  // Import channel history for analysis (parsed + risk-scored, never executed).
  const daysOf = (body: unknown): number => {
    const d = Math.floor(Number((body as { days?: number } | undefined)?.days));
    return Number.isFinite(d) && d > 0 ? Math.min(d, 365) : 30;
  };
  app.post("/api/backfill", async (req) => backfillAll(daysOf(req.body)));
  app.post<{ Params: { id: string } }>("/api/groups/:id/backfill", async (req) =>
    backfillGroup(req.params.id, daysOf(req.body)),
  );

  // Re-parse a channel's history and backtest it against real prices.
  app.post<{ Params: { id: string } }>("/api/groups/:id/backtest", async (req) => {
    const body = req.body as { horizonDays?: number; interval?: string } | undefined;
    const horizon = Math.min(Math.max(Math.floor(Number(body?.horizonDays)) || 14, 1), 60);
    const interval = typeof body?.interval === "string" ? body.interval : "1h";
    return backtestGroup(req.params.id, horizon, interval);
  });

  // Ask the AI to propose improved per-channel parsing instructions, learned
  // from the channel's real message history. Returns a suggestion for review —
  // it is NOT applied automatically (the desk saves it if the user accepts).
  app.post<{ Params: { id: string } }>(
    "/api/groups/:id/suggest-instructions",
    async (req, reply) => {
      const group = groupsRepo.get(req.params.id);
      if (!group) return reply.code(404).send({ error: "not found" });
      const history = signalsRepo.forGroup(group.id);
      // Newest first, so the sample reflects the channel's current style.
      const samples = history
        .slice()
        .reverse()
        .map((s) => ({
          text: s.rawText,
          type:
            s.status === "managed"
              ? "trade-change"
              : s.parsed && s.status !== "unparseable"
                ? "signal"
                : "info",
        }));
      return suggestChannelInstructions(
        group.name,
        group.settings.instructions ?? "",
        samples,
      );
    },
  );

  // Export a channel's full message transcript (timestamp + text) as .txt.
  app.get<{ Params: { id: string } }>("/api/groups/:id/export", async (req, reply) => {
    if (!authEnabled) return reply.code(403).send({ error: "Set DESK_PASSWORD to enable exports." });
    const group = groupsRepo.get(req.params.id);
    if (!group) return reply.code(404).send({ error: "not found" });
    reply
      .type("text/plain; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${safeFilename(group.name)}"`);
    return exportGroupText(group);
  });

  // Export all channels' transcripts as one .txt.
  app.get("/api/export", async (_req, reply) => {
    if (!authEnabled) return reply.code(403).send({ error: "Set DESK_PASSWORD to enable exports." });
    reply
      .type("text/plain; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="all-channels.txt"');
    return exportAllText();
  });

  /* ------------------------------ signals ----------------------------- */
  const clampLimit = (raw: string | undefined, def: number, max: number): number => {
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
  };

  app.get<{ Querystring: { limit?: string } }>("/api/signals", async (req) => {
    const list = signalsRepo.list(clampLimit(req.query.limit, 200, 2000));
    const withImg = messageImagesRepo.withImages(list.map((s) => s.id));
    return list.map((s) => (withImg.has(s.id) ? { ...s, hasImage: true } : s));
  });

  app.get("/api/signals/pending", async () => signalsRepo.pending());

  // Serve a message's attached chart image (inline). Public read (no secrets).
  app.get<{ Params: { id: string } }>("/api/messages/:id/image", async (req, reply) => {
    const img = messageImagesRepo.get(req.params.id);
    if (!img) return reply.code(404).send({ error: "no image" });
    return reply.type(img.mediaType).header("Cache-Control", "private, max-age=86400").send(img.data);
  });

  app.post<{ Params: { id: string } }>("/api/signals/:id/confirm", async (req, reply) => {
    const signal = await confirmSignal(req.params.id);
    if (!signal) return reply.code(404).send({ error: "not found" });
    return signal;
  });

  app.post<{ Params: { id: string } }>("/api/signals/:id/reject", async (req, reply) => {
    const signal = rejectSignal(req.params.id);
    if (!signal) return reply.code(404).send({ error: "not found" });
    return signal;
  });

  // Paste a raw message to test parsing + execution against a group.
  app.post("/api/signals/simulate", async (req, reply) => {
    const schema = z.object({ groupId: z.string().max(64), text: z.string().min(1).max(20000) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const signal = await submitManual(parsed.data.groupId, parsed.data.text);
    if (!signal) return reply.code(404).send({ error: "group not found" });
    return signal;
  });

  /* ------------------------------ trades ------------------------------ */
  app.get<{ Querystring: { limit?: string } }>("/api/trades", async (req) => {
    return tradesRepo.list(clampLimit(req.query.limit, 500, 5000));
  });

  app.post<{ Params: { id: string } }>("/api/trades/:id/close", async (req, reply) => {
    const schema = z.object({ exitPrice: z.number().positive().optional() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    // A working (resting limit) order isn't a position — cancel it instead.
    const existing = tradesRepo.get(req.params.id);
    if (existing?.status === "working") {
      await cancelWorkingTrade(req.params.id, "canceled from desk");
      audit(req, `canceled working ${existing.symbol}`, { id: req.params.id });
      return tradesRepo.get(req.params.id) ?? existing;
    }
    const trade = await closeTrade(req.params.id, parsed.data.exitPrice);
    if (!trade) return reply.code(404).send({ error: "not found" });
    audit(req, `closed ${trade.symbol}`, { id: req.params.id, pnl: trade.realizedPnl });
    return trade;
  });

  // Manually set/move the stop-loss on a trade.
  app.post<{ Params: { id: string } }>("/api/trades/:id/stop", async (req, reply) => {
    const parsed = z.object({ price: z.number().finite().positive().max(1e12) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const res = await setTradeStop(req.params.id, parsed.data.price);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    audit(req, `set SL ${parsed.data.price} on ${res.trade?.symbol ?? req.params.id}`, { id: req.params.id });
    return res.trade;
  });

  // Manually replace the take-profit levels on a trade.
  app.post<{ Params: { id: string } }>("/api/trades/:id/take-profits", async (req, reply) => {
    const parsed = z
      .object({ prices: z.array(z.number().finite().positive().max(1e12)).max(20) })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const res = await setTradeTakeProfits(req.params.id, parsed.data.prices);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    audit(req, `set TPs [${parsed.data.prices.join(", ")}] on ${res.trade?.symbol ?? req.params.id}`, { id: req.params.id });
    return res.trade;
  });

  // Manually book a fraction (0..1) of an open trade.
  app.post<{ Params: { id: string } }>("/api/trades/:id/partial", async (req, reply) => {
    const parsed = z.object({ fraction: z.number().gt(0).lt(1) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const res = await bookTradePartial(req.params.id, parsed.data.fraction);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    audit(req, `booked ${(parsed.data.fraction * 100).toFixed(0)}% of ${res.trade?.symbol ?? req.params.id}`, { id: req.params.id });
    return res.trade;
  });

  /* ------------------------------- logs ------------------------------- */
  app.get<{ Querystring: { limit?: string; category?: string } }>("/api/logs", async (req) => {
    return logsRepo.list(clampLimit(req.query.limit, 300, 3000), req.query.category);
  });
  app.delete("/api/logs", async () => {
    logsRepo.clear();
    return { ok: true };
  });

  /* ------------------------- stats & positions ------------------------ */
  app.get("/api/stats", async () => dashboard());

  // Send a daily/weekly performance report to the alert chat now (test/manual).
  app.post<{ Querystring: { period?: string } }>("/api/report/send", async (req, reply) => {
    const period = req.query.period === "weekly" ? "weekly" : "daily";
    const sent = await sendReport(period);
    if (!sent) return reply.code(400).send({ error: "alerts not configured" });
    return { ok: true, period };
  });

  // Rich analytics: performance by group, symbol and side, with filters.
  app.get<{ Querystring: { from?: string; to?: string; includeShadow?: string } }>(
    "/api/analytics",
    async (req) =>
      analytics({
        from: req.query.from,
        to: req.query.to,
        includeShadow: req.query.includeShadow === "true",
      }),
  );

  // Manually trigger a full monitor pass (reconcile live trades + simulated).
  app.post("/api/reconcile", async () => {
    await reconcileOnce();
    await evaluateSimulated();
    return { ok: true };
  });

  // Operational health of the Telegram listener (connection + per-channel
  // last activity), so a silent outage is visible in the desk.
  app.get("/api/telegram/health", async () => getListenerHealth());

  // Move USDC between the spot/unified wallet and the perps margin account.
  // A deliberate, user-initiated account operation (not an automated trade), so
  // it runs whenever a signing key is present — even in shadow/test mode.
  app.post<{ Body: { amount?: number; toPerp?: boolean } }>(
    "/api/account/transfer",
    async (req, reply) => {
      if (!authEnabled) return reply.code(403).send({ error: "Set DESK_PASSWORD to enable transfers." });
      const amount = Number(req.body?.amount);
      const toPerp = req.body?.toPerp !== false; // default: spot -> perp
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) {
        return reply.code(400).send({ error: "amount must be a positive number below 1e9" });
      }
      const res = await activeHyperliquid().transferUsd(amount, toPerp);
      if (!res.ok) return reply.code(400).send({ error: res.error });
      audit(req, `transferred ${amount} USDC ${toPerp ? "spot→perp" : "perp→spot"}`, { amount, toPerp });
      log.info(`Transferred ${amount} USDC ${toPerp ? "spot→perp" : "perp→spot"}.`);
      return { ok: true };
    },
  );

  // Place a one-off test order from the desk (respects the global test switch).
  app.post<{ Body: { symbol?: string; side?: string; notionalUsd?: number; leverage?: number; exchange?: string } }>(
    "/api/test-order",
    async (req, reply) => {
      if (!authEnabled) return reply.code(403).send({ error: "Set DESK_PASSWORD to enable test orders." });
      const b = req.body ?? {};
      const symbol = typeof b.symbol === "string" ? b.symbol : "";
      const side = b.side === "short" ? "short" : "long";
      const notionalUsd = Number(b.notionalUsd);
      const leverage = Number(b.leverage);
      const VENUES = ["hyperliquid", "hyperliquid-testnet", "aster", "mexc"] as const;
      const exchange = VENUES.includes(b.exchange as (typeof VENUES)[number])
        ? (b.exchange as (typeof VENUES)[number])
        : undefined;
      if (b.exchange && !exchange) return reply.code(400).send({ error: `unknown exchange ${b.exchange}` });
      if (!symbol) return reply.code(400).send({ error: "symbol required" });
      if (!Number.isFinite(notionalUsd) || notionalUsd <= 0 || notionalUsd > 10_000_000) {
        return reply.code(400).send({ error: "notionalUsd must be > 0 and <= 10,000,000" });
      }
      if (!Number.isFinite(leverage) || leverage < 1 || leverage > 100) {
        return reply.code(400).send({ error: "leverage must be between 1 and 100" });
      }
      const res = await placeTestOrder({ symbol, side, notionalUsd, leverage, exchange });
      if (!res.ok) return reply.code(400).send({ error: res.error });
      audit(req, `test order ${side} ${symbol} ${notionalUsd} USDC ${leverage}x on ${exchange ?? "active-hl"}`, { symbol, side, notionalUsd, leverage, exchange });
      return res.trade;
    },
  );

  // Latest mark prices for open-trade symbols (for live unrealized PnL).
  app.get("/api/prices", async () => getPrices());

  app.get("/api/positions", async () => {
    try {
      return await activeHyperliquid().getPositions();
    } catch (err) {
      log.warn("positions unavailable:", err instanceof Error ? err.message : err);
      return [];
    }
  });

  // Exchange connection: address, balance and live positions, for the desk's
  // connection panel. Safe to call when disconnected (returns connected:false).
  app.get("/api/account", async () => {
    const hl = activeHyperliquid();
    const base = {
      connected: hl.live,
      simulating: hl.simulating(),
      env: config.tradingEnv,
      network: hl.name,
      address: hl.publicAddress(),
      signer: hl.signerAddress(),
    };
    if (!base.address) return { ...base, positions: [] };
    try {
      const [summary, positions, spotUsdc] = await Promise.all([
        hl.getAccountSummary(),
        hl.getPositions(),
        hl.getSpotUsdc().catch(() => null),
      ]);
      return {
        ...base,
        accountValue: summary?.accountValue,
        withdrawable: summary?.withdrawable,
        totalMarginUsed: summary?.totalMarginUsed,
        spotUsdc: spotUsdc ?? undefined,
        positions,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("account summary unavailable:", msg);
      return { ...base, positions: [], error: msg };
    }
  });

  /* -------------------------------- ws -------------------------------- */
  app.get("/ws", { websocket: true }, (socket, req) => {
    const sock = socket as unknown as SocketLike & { close(): void };
    if (authEnabled) {
      const token = (req.query as { token?: string } | undefined)?.token;
      if (!verifyToken(token)) {
        try {
          sock.close();
        } catch {
          /* ignore */
        }
        return;
      }
    }
    register(sock);
    // Send a snapshot on connect.
    const snapshot: WsEvent = { type: "stats", stats: dashboard() };
    try {
      sock.send(JSON.stringify(snapshot));
    } catch {
      /* ignore */
    }
    (socket as unknown as { on(ev: string, cb: () => void): void }).on("close", () =>
      unregister(sock),
    );
  });

  /* ------------------------ serve the built web ----------------------- */
  // In production the API also serves the desk (single process, single port).
  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
    // SPA fallback: any non-API/non-ws GET returns index.html.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split("?")[0] ?? "";
      if (req.method === "GET" && !path.startsWith("/api") && !path.startsWith("/ws")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
    log.info(`Serving desk web from ${config.webDist}`);
  }

  return app;
}
