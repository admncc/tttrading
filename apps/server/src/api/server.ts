import fs from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import type { WsEvent } from "@tttrading/shared";
import { config, authEnabled } from "../config.js";
import { bearer, checkPassword, signToken, verifyToken } from "../auth.js";
import { log } from "../logger.js";
import {
  groups as groupsRepo,
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

  await app.register(cors, { origin: true });
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

  app.post("/api/login", async (req, reply) => {
    if (!authEnabled) return { token: null, authRequired: false };
    const schema = z.object({ password: z.string() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "password required" });
    if (!checkPassword(parsed.data.password)) {
      return reply.code(401).send({ error: "invalid password" });
    }
    return { token: signToken(), authRequired: true };
  });

  /* ------------------------------ health ------------------------------ */
  app.get("/api/health", async () => ({
    ok: true,
    env: config.tradingEnv,
    live: hyperliquid.live,
    shadowMode: settingsRepo.getShadowMode(),
    authRequired: authEnabled,
    time: new Date().toISOString(),
  }));

  /* -------------------------- global settings ------------------------- */
  app.get("/api/settings", async () => ({ shadowMode: settingsRepo.getShadowMode() }));

  app.put("/api/settings", async (req, reply) => {
    const parsed = z.object({ shadowMode: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    settingsRepo.setShadowMode(parsed.data.shadowMode);
    const shadowMode = settingsRepo.getShadowMode();
    log.info(`Shadow (test) mode ${shadowMode ? "ENABLED" : "DISABLED — LIVE TRADING"}.`);
    broadcast({ type: "settings", settings: { shadowMode } });
    return { shadowMode };
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

  /* ------------------------------ signals ----------------------------- */
  app.get<{ Querystring: { limit?: string } }>("/api/signals", async (req) => {
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    return signalsRepo.list(limit);
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
    const limit = req.query.limit ? Number(req.query.limit) : 500;
    return tradesRepo.list(limit);
  });

  app.post<{ Params: { id: string } }>("/api/trades/:id/close", async (req, reply) => {
    const schema = z.object({ exitPrice: z.number().positive().optional() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const trade = await closeTrade(req.params.id, parsed.data.exitPrice);
    if (!trade) return reply.code(404).send({ error: "not found" });
    return trade;
  });

  /* ------------------------- stats & positions ------------------------ */
  app.get("/api/stats", async () => dashboard());

  // Manually trigger a full monitor pass (reconcile live trades + simulated).
  app.post("/api/reconcile", async () => {
    await reconcileOnce();
    await evaluateSimulated();
    return { ok: true };
  });

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
