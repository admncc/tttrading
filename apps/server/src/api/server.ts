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
import { log } from "../logger.js";
import {
  groups as groupsRepo,
  logs as logsRepo,
  settings as settingsRepo,
  signals as signalsRepo,
  trades as tradesRepo,
} from "../db/repositories.js";
import { dashboard } from "../stats/service.js";
import { hyperliquid } from "../hyperliquid/connector.js";
import {
  closeTrade,
  confirmSignal,
  rejectSignal,
  submitManual,
} from "../execution/engine.js";
import { reconcileOnce, evaluateSimulated } from "../execution/monitor.js";
import { backfillAll, backfillGroup } from "../telegram/backfill.js";
import { getListenerHealth } from "../telegram/listener.js";
import { backtestGroup } from "../backtest/engine.js";
import { suggestChannelInstructions } from "../signals/llm.js";
import { exportAllText, exportGroupText, safeFilename } from "../export/text.js";
import { broadcast, register, unregister, type SocketLike } from "../ws/hub.js";

const groupSettingsSchema = z.object({
  leverage: z.number().positive().max(100),
  tradeSizeUsd: z.number().positive(),
  executionMode: z.enum(["auto", "confirm"]),
  marginMode: z.enum(["cross", "isolated"]),
  maxSlippage: z.number().min(0).max(0.2),
  autoSplitSingleTp: z.boolean(),
  tpLevels: z.number().int().min(1).max(10),
  breakevenAfterTp: z.number().int().min(0).max(10),
  blockRedTrades: z.boolean(),
  instructions: z.string().max(8000).optional(),
  allowedSymbols: z.array(z.string()).optional(),
});

const groupInputSchema = z.object({
  name: z.string().min(1),
  telegramChannel: z.string().min(1),
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

  const corsOrigin = config.corsOrigin
    ? config.corsOrigin === "*"
      ? true
      : config.corsOrigin.split(",").map((s) => s.trim())
    : false; // same-origin only (desk is served from this API)
  await app.register(cors, { origin: corsOrigin });
  await app.register(websocket);

  /* -------------------------------- auth ------------------------------ */
  // Guard every /api route except health and login. WebSocket auth is handled
  // inside the /ws handler (query token). No-op when auth is disabled.
  app.addHook("onRequest", async (req, reply) => {
    if (!authEnabled) return;
    if (req.method === "OPTIONS") return;
    const path = req.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return;
    if (path === "/api/health" || path === "/api/login") return;
    if (!verifyToken(bearer(req.headers.authorization))) {
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
    live: hyperliquid.live,
    shadowMode: settingsRepo.getShadowMode(),
    authRequired: authEnabled,
    updateEnabled: config.selfUpdate.enabled,
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
  app.get("/api/settings", async () => ({
    shadowMode: settingsRepo.getShadowMode(),
    // Never expose the key itself — only whether one is configured (desk or env).
    anthropicConfigured: !!(settingsRepo.getAnthropicKey() || config.anthropic.apiKey),
    anthropicKeySource: settingsRepo.getAnthropicKey() ? "desk" : config.anthropic.apiKey ? "env" : "none",
    anthropicModel: settingsRepo.getAnthropicModel() || config.anthropic.model,
  }));

  app.put("/api/settings", async (req, reply) => {
    const schema = z.object({
      shadowMode: z.boolean().optional(),
      anthropicKey: z.string().optional(), // "" clears the desk-stored key
      anthropicModel: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { shadowMode, anthropicKey, anthropicModel } = parsed.data;
    if (shadowMode !== undefined) {
      settingsRepo.setShadowMode(shadowMode);
      log.info(`Shadow (test) mode ${shadowMode ? "ENABLED" : "DISABLED — LIVE TRADING"}.`);
      broadcast({ type: "settings", settings: { shadowMode } });
    }
    if (anthropicKey !== undefined) {
      settingsRepo.setAnthropicKey(anthropicKey.trim());
      log.info(`Anthropic key ${anthropicKey.trim() ? "updated via desk" : "cleared"}.`);
    }
    if (anthropicModel !== undefined) settingsRepo.setAnthropicModel(anthropicModel.trim());
    return {
      shadowMode: settingsRepo.getShadowMode(),
      anthropicConfigured: !!(settingsRepo.getAnthropicKey() || config.anthropic.apiKey),
      anthropicModel: settingsRepo.getAnthropicModel() || config.anthropic.model,
    };
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
    const group = groupsRepo.get(req.params.id);
    if (!group) return reply.code(404).send({ error: "not found" });
    reply
      .type("text/plain; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${safeFilename(group.name)}"`);
    return exportGroupText(group);
  });

  // Export all channels' transcripts as one .txt.
  app.get("/api/export", async (_req, reply) => {
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
    return signalsRepo.list(clampLimit(req.query.limit, 200, 2000));
  });

  app.get("/api/signals/pending", async () => signalsRepo.pending());

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
    const schema = z.object({ groupId: z.string(), text: z.string().min(1) });
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
    const trade = await closeTrade(req.params.id, parsed.data.exitPrice);
    if (!trade) return reply.code(404).send({ error: "not found" });
    return trade;
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

  // Manually trigger a full monitor pass (reconcile live trades + simulated).
  app.post("/api/reconcile", async () => {
    await reconcileOnce();
    await evaluateSimulated();
    return { ok: true };
  });

  // Operational health of the Telegram listener (connection + per-channel
  // last activity), so a silent outage is visible in the desk.
  app.get("/api/telegram/health", async () => getListenerHealth());

  app.get("/api/positions", async () => {
    try {
      return await hyperliquid.getPositions();
    } catch (err) {
      log.warn("positions unavailable:", err instanceof Error ? err.message : err);
      return [];
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
