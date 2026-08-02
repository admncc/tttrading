import type { Trade } from "@tttrading/shared";
import { config, alertsEnabled } from "../config.js";
import { log } from "../logger.js";
import { trades as tradesRepo } from "../db/repositories.js";
import { analytics } from "../stats/service.js";
import { sendAlert } from "./notifier.js";

export type ReportPeriod = "daily" | "weekly";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmt(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)} USDC`;
}

/** Compose a performance summary for the given period as an HTML message. */
export function buildReport(period: ReportPeriod): string {
  const days = period === "daily" ? 1 : 7;
  const from = new Date(Date.now() - days * 86400_000).toISOString();
  const title = period === "daily" ? "Daily report (24h)" : "Weekly report (7d)";

  const a = analytics({ from });
  if (a.closedTrades === 0) {
    return `📊 <b>${title}</b>\nNo closed trades in this period.`;
  }
  const o = a.overall;

  const closed = tradesRepo
    .list(10000)
    .filter(
      (t) =>
        !t.shadow &&
        t.status === "closed" &&
        t.openedAt >= from &&
        Number.isFinite(t.realizedPnl),
    );
  const best = closed.reduce<Trade | undefined>(
    (b, t) => (t.realizedPnl! > (b?.realizedPnl ?? -Infinity) ? t : b),
    undefined,
  );
  const worst = closed.reduce<Trade | undefined>(
    (b, t) => (t.realizedPnl! < (b?.realizedPnl ?? Infinity) ? t : b),
    undefined,
  );
  const topGroup = a.byGroup[0];
  const topSymbol = a.bySymbol[0];

  const lines = [
    `📊 <b>${title}</b>`,
    `Closed: ${a.closedTrades} · Win rate: ${(o.winRate * 100).toFixed(0)}%`,
    `PnL: <b>${fmt(o.realizedPnl)}</b> · PF: ${Number.isFinite(o.profitFactor) ? o.profitFactor.toFixed(2) : "∞"}` +
      (o.rrSampleSize ? ` · RR: ${o.avgRR}R` : ""),
  ];
  if (best) lines.push(`🏆 Best: ${esc(best.symbol)} ${fmt(best.realizedPnl!)}`);
  if (worst && worst !== best) lines.push(`🔻 Worst: ${esc(worst.symbol)} ${fmt(worst.realizedPnl!)}`);
  if (topGroup) lines.push(`👥 Top group: ${esc(topGroup.label)} ${fmt(topGroup.stats.realizedPnl)}`);
  if (topSymbol) lines.push(`🪙 Top coin: ${esc(topSymbol.label)} ${fmt(topSymbol.stats.realizedPnl)}`);
  if (a.includesSimulated) lines.push(`<i>includes simulated (test-mode) trades</i>`);
  return lines.join("\n");
}

/** Send a report to the alert chat now. */
export async function sendReport(period: ReportPeriod): Promise<boolean> {
  if (!alertsEnabled) return false;
  await sendAlert(buildReport(period));
  return true;
}

let timer: ReturnType<typeof setInterval> | undefined;
let lastDaily = "";
let lastWeekly = "";

/**
 * Start the report scheduler: checks each minute and fires the daily/weekly
 * summary at the configured UTC hour (weekly on the configured weekday),
 * guarded so each fires at most once per day.
 */
export function startReports(): void {
  if (!alertsEnabled) return;
  const { dailyReport, weeklyReport, reportHour, reportWeekday } = config.alerts;
  if (!dailyReport && !weeklyReport) return;
  log.info(
    `Telegram reports scheduled at ${reportHour}:00 UTC ` +
      `(daily=${dailyReport}, weekly=${weeklyReport} on weekday ${reportWeekday}).`,
  );
  timer = setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() !== reportHour || now.getUTCMinutes() !== 0) return;
    const today = now.toISOString().slice(0, 10);
    if (dailyReport && lastDaily !== today) {
      lastDaily = today;
      void sendReport("daily");
    }
    if (weeklyReport && now.getUTCDay() === reportWeekday && lastWeekly !== today) {
      lastWeekly = today;
      void sendReport("weekly");
    }
  }, 60_000);
}

export function stopReports(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
