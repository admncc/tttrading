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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a raw alert to the configured Telegram bot chat. Fire-and-forget, but
 * RESILIENT to transient failures: a momentary network blip (fetch throws) or a
 * 429/5xx from Telegram is retried with backoff, so a notification isn't silently
 * lost — e.g. a trade opening while Telegram is briefly reconnecting. A 4xx other
 * than 429 is a permanent (bad-request) error and is not retried.
 */
export async function sendAlert(text: string): Promise<void> {
  if (!alertsEnabled) return;
  const url = `https://api.telegram.org/bot${config.alerts.telegramBotToken}/sendMessage`;
  const backoffMs = [500, 1500, 4000]; // 4 attempts total
  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
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
      if (res.ok) return;
      const body = await res.text();
      // 429 (rate limit) and 5xx are transient → retry; other 4xx are permanent.
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === backoffMs.length) {
        log.warn(`alert failed: ${res.status} ${body}`);
        return;
      }
      log.warn(`alert send transient ${res.status} — retry ${attempt + 1}/${backoffMs.length}`);
    } catch (err) {
      // Network-level failure (DNS/connect/"fetch failed") — retry unless exhausted.
      if (attempt === backoffMs.length) {
        log.warn("alert send error (gave up):", err instanceof Error ? err.message : err);
        return;
      }
      log.warn(
        `alert send error (retry ${attempt + 1}/${backoffMs.length}):`,
        err instanceof Error ? err.message : err,
      );
    }
    await sleep(backoffMs[attempt]!);
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
