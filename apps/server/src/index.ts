import { config, alertsEnabled, authEnabled } from "./config.js";
import { log, addLogSink } from "./logger.js";
import { logs as logsRepo } from "./db/repositories.js";
import { sendAlert } from "./alerts/notifier.js";
import { llmReady } from "./signals/llm.js";
import "./db/index.js"; // open + migrate
import { seedDemo } from "./db/seed.js";
import { buildServer } from "./api/server.js";
import { startTelegram, stopTelegram } from "./telegram/listener.js";
import { startMonitor, stopMonitor } from "./execution/monitor.js";
import { startReports, stopReports } from "./alerts/report.js";
import { broadcast } from "./ws/hub.js";

async function main(): Promise<void> {
  // Persist every log entry and mirror it live to connected desk clients.
  addLogSink((entry) => {
    try {
      logsRepo.create(entry);
    } catch {
      /* don't let persistence break logging */
    }
    broadcast({ type: "log", entry });
  });

  seedDemo();

  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
  log.info(`Desk API listening on http://${config.host}:${config.port}`);

  await startTelegram();
  startMonitor();
  startReports();

  log.info(`Alerts ${alertsEnabled ? "enabled (Telegram bot)" : "disabled"}.`);
  log.info(`LLM signal fallback ${llmReady() ? "enabled" : "disabled (regex only)"}.`);
  if (authEnabled && !process.env.AUTH_SECRET) {
    log.warn("AUTH_SECRET not set — session tokens will not survive a restart. Set a persistent AUTH_SECRET.");
  }
  if (alertsEnabled) void sendAlert(`🤖 TT Desk started (${config.tradingEnv}).`);

  const shutdown = async () => {
    log.info("Shutting down...");
    stopMonitor();
    stopReports();
    await stopTelegram();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("Fatal startup error:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
