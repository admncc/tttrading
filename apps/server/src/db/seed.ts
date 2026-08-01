import type { TradeSide } from "@tttrading/shared";
import { config } from "../config.js";
import { log } from "../logger.js";
import { groups, trades } from "./repositories.js";

/**
 * Populate an empty database with a couple of demo groups and historical trades
 * so the desk shows meaningful data on first launch. No-op if data exists or
 * SEED_DEMO is disabled.
 */
export function seedDemo(): void {
  if (!config.seedDemo) return;
  if (groups.count() > 0) return;

  log.info("Seeding demo groups and trades...");

  const alpha = groups.create({
    name: "Alpha Scalps",
    telegramChannel: "@alpha_scalps",
    enabled: true,
    settings: {
      leverage: 4,
      tradeSizeUsd: 5000,
      executionMode: "auto",
      marginMode: "cross",
      maxSlippage: 0.01,
    },
  });

  const swing = groups.create({
    name: "Swing Desk VIP",
    telegramChannel: "@swing_desk_vip",
    enabled: true,
    settings: {
      leverage: 3,
      tradeSizeUsd: 2500,
      executionMode: "confirm",
      marginMode: "isolated",
      maxSlippage: 0.008,
      allowedSymbols: ["BTC", "ETH", "SOL"],
    },
  });

  const demoGroups = [alpha, swing];

  const symbols = ["BTC", "ETH", "SOL", "ARB", "AVAX", "LINK"];
  const basePrice: Record<string, number> = {
    BTC: 62000,
    ETH: 3200,
    SOL: 145,
    ARB: 1.1,
    AVAX: 34,
    LINK: 15,
  };

  // Deterministic pseudo-random so seeds are reproducible.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const nowMs = Date.now();
  for (let i = 0; i < 40; i++) {
    const group = demoGroups[i % demoGroups.length]!;
    const symbol = symbols[Math.floor(rand() * symbols.length)]!;
    const side: TradeSide = rand() > 0.5 ? "long" : "short";
    const entry = basePrice[symbol]! * (1 + (rand() - 0.5) * 0.05);
    const notional = group.settings.tradeSizeUsd;
    const size = notional / entry;
    const openedAt = new Date(nowMs - (40 - i) * 6 * 3600_000).toISOString();

    // ~57% winners with a slight positive expectancy.
    const win = rand() < 0.57;
    const movePct = (0.004 + rand() * 0.03) * (win ? 1 : -1);
    const dir = side === "long" ? 1 : -1;
    const exit = entry * (1 + movePct * dir);
    const pnl = (exit - entry) * dir * size;
    const fees = notional * 0.00035 * 2;
    const closedAt = new Date(nowMs - (40 - i) * 6 * 3600_000 + 2 * 3600_000).toISOString();

    trades.create({
      groupId: group.id,
      groupName: group.name,
      symbol,
      side,
      status: "closed",
      env: config.tradingEnv,
      leverage: group.settings.leverage,
      notionalUsd: notional,
      size,
      entryPrice: entry,
      exitPrice: exit,
      realizedPnl: pnl - fees,
      fees,
      openedAt,
      closedAt,
    });
  }

  // A couple of currently open trades.
  for (const group of demoGroups) {
    const symbol = "BTC";
    const entry = basePrice[symbol]!;
    trades.create({
      groupId: group.id,
      groupName: group.name,
      symbol,
      side: "long",
      status: "open",
      env: config.tradingEnv,
      leverage: group.settings.leverage,
      notionalUsd: group.settings.tradeSizeUsd,
      size: group.settings.tradeSizeUsd / entry,
      entryPrice: entry,
      stopLoss: entry * 0.98,
      takeProfits: [entry * 1.02, entry * 1.05],
      openedAt: new Date(nowMs - 2 * 3600_000).toISOString(),
    });
  }

  log.info(`Seeded ${demoGroups.length} groups and ${trades.count()} trades.`);
}
