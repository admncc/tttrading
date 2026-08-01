import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { z } from "zod";
import type { WsEvent } from "@tttrading/shared";
import { config } from "../config.js";
import { log } from "../logger.js";
import { groups as groupsRepo, signals as signalsRepo, trades as tradesRepo } from "../db/repositories.js";
import { dashboard } from "../stats/service.js";
import { hyperliquid } from "../hyperliquid/connector.js";
import {
  closeTrade,
  confirmSignal,
  rejectSignal,
  submitManual,
} from "../execution/engine.js";
import { broadcast, register, unregister, type SocketLike } from "../ws/hub.js";

const groupSettingsSchema = z.object({
  leverage: z.number().positive().max(100),
  tradeSizeUsd: z.number().positive(),
  executionMode: z.enum(["auto", "confirm"]),
  marginMode: z.enum(["cross", "isolated"]),
  maxSlippage: z.number().min(0).max(0.2),
  autoSplitSingleTp: z.boolean(),
  tpLevels: z.number().int().min(1).max(10),
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
  await app.register(cors, { origin: true });
  await app.register(websocket);

  /* ------------------------------ health ------------------------------ */
  app.get("/api/health", async () => ({
    ok: true,
    env: config.tradingEnv,
    live: hyperliquid.live,
    time: new Date().toISOString(),
  }));

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

  app.get("/api/positions", async () => {
    try {
      return await hyperliquid.getPositions();
    } catch (err) {
      log.warn("positions unavailable:", err instanceof Error ? err.message : err);
      return [];
    }
  });

  /* -------------------------------- ws -------------------------------- */
  app.get("/ws", { websocket: true }, (socket) => {
    const sock = socket as unknown as SocketLike;
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

  return app;
}
