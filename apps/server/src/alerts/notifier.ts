import type { Trade } from "@tttrading/shared";
import { config, alertsEnabled } from "../config.js";
import { settings as settingsRepo } from "../db/repositories.js";
import { log } from "../logger.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Post how an incoming message was classified (signal / managed / trade-update /
 * market-commentary / ignored / blocked) to the alert chat. Gated by the
 * alertOnClassify toggle. `label` may contain HTML (emoji + <b>); `detail` is
 * escaped plain text.
 */
export function alertClassification(groupName: string, label: string, detail?: string): void {
  if (!settingsRepo.getAlertOnClassify()) return;
  void sendAlert(`${label}${detail ? ` · ${esc(detail)}` : ""}\n<i>${esc(groupName)}</i>`);
}

/** Send a raw alert to the configured Telegram bot chat. Fire-and-forget. */
export async function sendAlert(text: string): Promise<void> {
  if (!alertsEnabled) return;
  const url = `https://api.telegram.org/bot${config.alerts.telegramBotToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.alerts.telegramChatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) log.warn(`alert failed: ${res.status} ${await res.text()}`);
  } catch (err) {
    log.warn("alert send error:", err instanceof Error ? err.message : err);
  }
}

const pnl = (n?: number) => (n === undefined ? "?" : `${n >= 0 ? "+" : ""}${n.toFixed(2)} USDC`);

const venueTag = (t: Trade) => (t.exchange && t.exchange !== "hyperliquid" ? ` · ${t.exchange}` : "");

export function alertOpened(trade: Trade, filledFromLimit = false): void {
  if (!settingsRepo.getAlertOnTrades(config.alerts.onFill)) return;
  const head = filledFromLimit ? "🎯 <b>Limit filled</b>" : "🟢 <b>Opened</b>";
  void sendAlert(
    `${head} ${trade.side.toUpperCase()} ${esc(trade.symbol)} ` +
      `${trade.leverage}x · ${trade.notionalUsd} USDC @ ${trade.entryPrice}\n` +
      `<i>${esc(trade.groupName)}${venueTag(trade)}</i>`,
  );
}

/** Infer why a trade closed from its exit vs SL/TP, for a clearer alert header. */
function closeReason(t: Trade): string {
  const exit = t.exitPrice;
  if (exit !== undefined) {
    if (t.stopLoss !== undefined && (t.side === "long" ? exit <= t.stopLoss * 1.0005 : exit >= t.stopLoss * 0.9995)) {
      return t.slMovedToBreakeven ? "🟡 <b>Stopped (break-even)</b>" : "🛑 <b>Stopped out</b>";
    }
    const tps = t.takeProfits ?? [];
    if (tps.length && (t.side === "long" ? exit >= tps[0]! : exit <= tps[0]!)) {
      return "🎯 <b>Take-profit</b>";
    }
  }
  return (t.realizedPnl ?? 0) >= 0 ? "✅ <b>Closed</b>" : "🔻 <b>Closed</b>";
}

export function alertClosed(trade: Trade): void {
  if (!settingsRepo.getAlertOnTrades(config.alerts.onFill)) return;
  void sendAlert(
    `${closeReason(trade)} ${trade.side.toUpperCase()} ${esc(trade.symbol)} — ${pnl(trade.realizedPnl)}\n` +
      `<i>${esc(trade.groupName)}${venueTag(trade)}</i>`,
  );
}

export function alertError(context: string, message: string): void {
  if (!settingsRepo.getAlertOnSystem(config.alerts.onError)) return;
  void sendAlert(`⚠️ <b>Error</b> ${esc(context)}\n${esc(message)}`);
}

export function alertBlocked(groupName: string, summary: string, score: number): void {
  if (!settingsRepo.getAlertOnTrades(config.alerts.onBlocked)) return;
  void sendAlert(`🚫 <b>Blocked red</b> ${esc(summary)} (${score}/100)\n<i>${esc(groupName)}</i>`);
}
