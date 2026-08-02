import { TelegramClient, type Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import type { Group } from "@tttrading/shared";
import { config, telegramReady } from "../config.js";
import { log, event as logEvent } from "../logger.js";
import { groups as groupsRepo, settings as settingsRepo } from "../db/repositories.js";
import { handleIncoming } from "../execution/engine.js";

let client: TelegramClient | null = null;
let pollTimer: ReturnType<typeof setInterval> | undefined;

/** How often the catch-up poller sweeps each channel for missed messages. */
const POLL_INTERVAL_MS = 60_000;
/** How many recent messages to fetch per channel per poll / prime. */
const POLL_LIMIT = 30;

/** The connected Telegram client, or null when the listener isn't running. */
export function getTelegramClient(): TelegramClient | null {
  return client;
}

export function normalizeChannel(channel: string): string {
  return channel
    .replace(/^@/, "")
    .replace(/^https:\/\/t\.me\//, "")
    .replace(/^-100/, "") // collapse Telegram's marked channel id to the bare id
    .toLowerCase();
}

/**
 * Resolve a group's channel string to a Telegram entity. Public channels
 * resolve by @handle; private channels are found by numeric id in the account's
 * dialog list (a bare id is otherwise misread as a PeerUser).
 */
export async function resolveEntity(
  tg: TelegramClient,
  channel: string,
): Promise<unknown> {
  const norm = normalizeChannel(channel);
  if (!/^\d+$/.test(norm)) return tg.getEntity(channel);

  const dialogs = await tg.getDialogs({});
  for (const d of dialogs) {
    const e = d.entity as { id?: unknown } | undefined;
    if (e && String(e.id) === norm) return e;
  }
  // Fallback: try the -100-marked channel id form.
  return tg.getEntity(Number(`-100${norm}`));
}

/** Find the group whose configured channel matches this message's chat. */
async function matchGroup(event: NewMessageEvent): Promise<Group | undefined> {
  const all = groupsRepo.list();
  try {
    const chat = await event.getChat();
    const username = (chat as { username?: string })?.username?.toLowerCase();
    const chatId = String((chat as { id?: unknown })?.id ?? event.chatId ?? "");
    return all.find((g) => {
      const norm = normalizeChannel(g.telegramChannel);
      return norm === username || norm === chatId || g.telegramChannel === chatId;
    });
  } catch {
    return undefined;
  }
}

async function onMessage(event: NewMessageEvent): Promise<void> {
  const text = event.message?.text;
  if (!text) return;
  const group = await matchGroup(event);
  if (!group) return; // message from a channel we don't track
  const msgId = event.message?.id;
  // Claim by id so the catch-up poller never re-processes what we handle here.
  if (typeof msgId === "number" && !settingsRepo.claimTelegramMessage(group.id, msgId)) {
    return; // already processed (e.g. poller beat us to it)
  }
  try {
    await handleIncoming(group, text);
  } catch (err) {
    log.error("Failed to handle Telegram message:", err instanceof Error ? err.message : err);
  }
}

/**
 * Seed each group's "seen" set with the current latest message ids WITHOUT
 * processing them, so the poller only ever acts on messages that arrive AFTER
 * startup (pre-startup history is imported via backfill, not executed).
 */
async function primeGroups(tg: TelegramClient): Promise<void> {
  for (const g of groupsRepo.list()) {
    try {
      const entity = await resolveEntity(tg, g.telegramChannel);
      const messages = await tg.getMessages(entity as Parameters<typeof tg.getMessages>[0], {
        limit: POLL_LIMIT,
      });
      for (const m of messages as Api.Message[]) {
        const id = (m as { id?: number }).id;
        if (typeof id === "number") settingsRepo.markTelegramMessageSeen(g.id, id);
      }
    } catch (err) {
      log.warn(`Telegram prime ${g.name} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Catch-up poller: a safety net for the live event stream. GramJS can silently
 * stop delivering updates after an idle disconnect; this sweep re-fetches each
 * channel's recent messages and processes any not already handled — closing the
 * gap that caused overnight messages to be missed.
 */
async function pollOnce(): Promise<void> {
  const tg = client;
  if (!tg) return;
  // Reconnect if the connection dropped while idle.
  try {
    if (!tg.connected) {
      log.warn("Telegram disconnected — reconnecting…");
      await tg.connect();
      log.info("Telegram reconnected.");
    }
  } catch (err) {
    log.warn("Telegram reconnect failed:", err instanceof Error ? err.message : err);
    return;
  }

  for (const g of groupsRepo.list()) {
    try {
      const entity = await resolveEntity(tg, g.telegramChannel);
      const messages = (await tg.getMessages(entity as Parameters<typeof tg.getMessages>[0], {
        limit: POLL_LIMIT,
      })) as Api.Message[];
      // Process oldest-first so ordering matches how they were sent.
      const fresh: { id: number; text: string }[] = [];
      for (const m of messages) {
        const id = (m as { id?: number }).id;
        const text = (m as { message?: string }).message;
        if (typeof id !== "number" || !text) continue;
        if (settingsRepo.claimTelegramMessage(g.id, id)) fresh.push({ id, text });
      }
      fresh.sort((a, b) => a.id - b.id);
      for (const f of fresh) {
        logEvent(
          "message",
          `Catch-up: recovered missed message from ${g.name}`,
          { msgId: f.id },
          { groupId: g.id },
        );
        try {
          await handleIncoming(g, f.text);
        } catch (err) {
          log.error("Catch-up handleIncoming failed:", err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      log.warn(`Telegram poll ${g.name} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Connect to Telegram and start listening. No-op when creds are missing. */
export async function startTelegram(): Promise<void> {
  if (!telegramReady()) {
    log.warn(
      "Telegram not configured (TG_API_ID / TG_API_HASH / TG_SESSION). " +
        "Listener disabled — use the desk's manual signal input to test.",
    );
    return;
  }

  const session = new StringSession(config.telegram.session);
  client = new TelegramClient(session, config.telegram.apiId, config.telegram.apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  const me = await client.getMe();
  const name = (me as { username?: string; firstName?: string })?.username ??
    (me as { firstName?: string })?.firstName ?? "unknown";
  log.info(`Telegram connected as ${name}.`);

  client.addEventHandler((e) => void onMessage(e), new NewMessage({}));

  const channels = groupsRepo.list().map((g) => g.telegramChannel);
  log.info(`Listening for signals in: ${channels.join(", ") || "(no groups yet)"}`);

  // Prime the seen-set to "now", then start the catch-up poller.
  await primeGroups(client);
  pollTimer = setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);
  log.info(`Telegram catch-up poller every ${Math.round(POLL_INTERVAL_MS / 1000)}s.`);
}

export async function stopTelegram(): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  if (client) {
    await client.disconnect();
    client = null;
  }
}
