import type { Trade } from "@tttrading/shared";
import { config, alertsEnabled } from "../config.js";
import { log } from "../logger.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

export function alertOpened(trade: Trade): void {
  if (!config.alerts.onFill) return;
  void sendAlert(
    `🟢 <b>Opened</b> ${trade.side.toUpperCase()} ${esc(trade.symbol)} ` +
      `${trade.leverage}x · ${trade.notionalUsd} USDC @ ${trade.entryPrice}\n` +
      `<i>${esc(trade.groupName)}</i>`,
  );
}

export function alertClosed(trade: Trade): void {
  if (!config.alerts.onFill) return;
  const emoji = (trade.realizedPnl ?? 0) >= 0 ? "✅" : "🔻";
  void sendAlert(
    `${emoji} <b>Closed</b> ${trade.side.toUpperCase()} ${esc(trade.symbol)} — ${pnl(trade.realizedPnl)}\n` +
      `<i>${esc(trade.groupName)}</i>`,
  );
}

export function alertError(context: string, message: string): void {
  if (!config.alerts.onError) return;
  void sendAlert(`⚠️ <b>Error</b> ${esc(context)}\n${esc(message)}`);
}

export function alertBlocked(groupName: string, summary: string, score: number): void {
  if (!config.alerts.onBlocked) return;
  void sendAlert(`🚫 <b>Blocked red</b> ${esc(summary)} (${score}/100)\n<i>${esc(groupName)}</i>`);
}
