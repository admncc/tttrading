import { config, alertsEnabled } from "./config.js";
import { log, addLogSink } from "./logger.js";
import { sendAlert } from "./alerts/notifier.js";
import "./db/index.js"; // open + migrate
import { seedDemo } from "./db/seed.js";
import { buildServer } from "./api/server.js";
import { startTelegram, stopTelegram } from "./telegram/listener.js";
import { startMonitor, stopMonitor } from "./execution/monitor.js";
import { broadcast } from "./ws/hub.js";

async function main(): Promise<void> {
  // Mirror server logs to connected desk clients.
  addLogSink((level, message) =>
    broadcast({ type: "log", level, message, t: new Date().toISOString() }),
  );

  seedDemo();

  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
  log.info(`Desk API listening on http://${config.host}:${config.port}`);

  await startTelegram();
  startMonitor();

  log.info(`Alerts ${alertsEnabled ? "enabled (Telegram bot)" : "disabled"}.`);
  if (alertsEnabled) void sendAlert(`🤖 TT Desk started (${config.tradingEnv}).`);

  const shutdown = async () => {
    log.info("Shutting down...");
    stopMonitor();
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
